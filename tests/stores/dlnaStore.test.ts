/** @jest-environment node */

let mockEmitEvent: ((update: { transportState?: string; durationMillis?: number }) => void) | null = null;

const mockController = {
  setAvTransportUri: jest.fn(async () => {}),
  play: jest.fn(async () => {}),
  pause: jest.fn(async () => {}),
  stop: jest.fn(async () => {}),
  seekTo: jest.fn(async () => {}),
  getCapabilities: jest.fn(async () => ({ canSeek: true })),
  getPositionInfo: jest.fn(async () => ({
    positionMillis: 0,
    trackDurationMillis: 0,
    positionSupported: false,
    trackUri: '',
  })),
  getTransportInfo: jest.fn(async () => ({ state: 'PLAYING', status: 'OK' })),
  getMediaInfo: jest.fn(async () => ({ currentUri: 'http://cdn/current', numberOfTracks: 1 })),
};

jest.mock('@/services/dlna/control', () => ({
  DlnaController: jest.fn(() => mockController),
}));

jest.mock('@/services/dlna/discovery', () => ({
  startDlnaDiscovery: jest.fn(() => ({ stop: jest.fn(), devices: new Promise(() => {}) })),
}));

jest.mock('@/services/dlna/events', () => ({
  // 记下事件回调，测试里用 mockEmitEvent 模拟电视推送的 GENA 事件
  subscribeToDlnaEvents: jest.fn(async (_device: unknown, onUpdate: (update: unknown) => void) => {
    mockEmitEvent = onUpdate;
    return { stop: jest.fn(async () => {}) };
  }),
}));

jest.mock('@/services/localProxy', () => ({
  cancelProxyDownloads: jest.fn(),
  ensureLocalProxy: jest.fn(async () => 'http://192.168.1.5:18923'),
  isHlsUrl: (url: string) => url.includes('m3u8'),
  isLanProxyOrigin: jest.fn(() => true),
  resolvePlayUrl: jest.fn(async (url: string) => `proxy:${url}`),
  resolveLivePlayUrl: jest.fn(async (url: string, ua: string) => `live:${ua}:${url}`),
}));

const mockSavePlayRecord = jest.fn(async () => {});
let mockEpisode: { url: string } | undefined;
jest.mock('@/stores/playerStore', () => ({
  __esModule: true,
  default: {
    getState: () => ({
      savePlayRecord: mockSavePlayRecord,
      episodes: [],
      currentEpisodeIndex: -1,
      status: { positionMillis: 30000, durationMillis: 600000, isPlaying: true },
    }),
    setState: jest.fn(),
  },
  selectCurrentEpisode: () => mockEpisode,
}));

jest.mock('@/stores/detailStore', () => ({
  __esModule: true,
  default: { getState: () => ({ detail: null, sources: [] }) },
}));

jest.mock('@/utils/Toast', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('@/utils/PlaybackSkipNotice', () => ({ notifyPlaybackSkip: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import useDlnaStore from '@/stores/dlnaStore';
import usePlayerStore from '@/stores/playerStore';

const device = {
  id: 'uuid:tv',
  udn: 'uuid:tv',
  friendlyName: '客厅电视',
  location: 'http://192.168.1.20:9197/description.xml',
  controlUrl: 'http://192.168.1.20:9197/AVTransport/control',
  serviceType: 'urn:schemas-upnp-org:service:AVTransport:1',
  hasRenderingControlService: false,
};

const LAST_DEVICE_KEY = 'oriontv_dlna_last_device';

describe('直播投屏', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  afterEach(async () => {
    await useDlnaStore.getState().disableCast({ restoreLocal: false, stopRemote: true });
  });

  it('自动连接与剧集共用的上次投屏设备，并推送频道原地址', async () => {
    await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device));

    await useDlnaStore.getState().enableLiveCast({ url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: '' });

    expect(useDlnaStore.getState().phase).toBe('connected');
    expect(useDlnaStore.getState().currentDevice?.id).toBe(device.id);
    // 没有 UA 时直接透传原地址，不经过代理
    expect(mockController.setAvTransportUri).toHaveBeenCalledWith('http://cdn/a.m3u8', 'CCTV-1', 'auto', undefined);
    // 直播从当前位置播放，不 Seek
    expect(mockController.seekTo).not.toHaveBeenCalled();
  });

  it('配置了 UA 时经过原生代理补 UA', async () => {
    await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device));

    await useDlnaStore.getState().enableLiveCast({ url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: 'okhttp' });

    expect(mockController.setAvTransportUri).toHaveBeenCalledWith('live:okhttp:http://cdn/a.m3u8', 'CCTV-1', 'auto', undefined);
  });

  it('切换频道时推送新地址，同一频道不重复下发', async () => {
    await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device));
    await useDlnaStore.getState().enableLiveCast({ url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: '' });
    mockController.setAvTransportUri.mockClear();

    await useDlnaStore.getState().castLiveChannel({ url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: '' });
    expect(mockController.setAvTransportUri).not.toHaveBeenCalled();

    await useDlnaStore.getState().castLiveChannel({ url: 'http://cdn/b.m3u8', title: '湖南卫视', userAgent: '' });
    expect(mockController.setAvTransportUri).toHaveBeenCalledWith('http://cdn/b.m3u8', '湖南卫视', 'auto', undefined);
  });

  it('直播投屏中连上新设备会更新共用的上次设备记录', async () => {
    await useDlnaStore.getState().enableLiveCast({ url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: '' });
    await useDlnaStore.getState().selectDevice(device);

    expect(JSON.parse((await AsyncStorage.getItem(LAST_DEVICE_KEY)) ?? '{}').id).toBe(device.id);
  });

  it('结束投屏只停止电视，不写剧集播放记录、不恢复剧集播放器', async () => {
    await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device));
    await useDlnaStore.getState().enableLiveCast({ url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: '' });

    await useDlnaStore.getState().disableCast({ restoreLocal: true, stopRemote: true });

    expect(mockController.stop).toHaveBeenCalled();
    expect(mockSavePlayRecord).not.toHaveBeenCalled();
    expect(usePlayerStore.setState).not.toHaveBeenCalled();
    expect(useDlnaStore.getState().enabled).toBe(false);
  });

  it('未开启直播投屏时切换频道不做任何事', async () => {
    await useDlnaStore.getState().castLiveChannel({ url: 'http://cdn/b.m3u8', title: '湖南卫视', userAgent: '' });
    expect(mockController.setAvTransportUri).not.toHaveBeenCalled();
  });
});

describe('推送新媒体后的加载判定（保守：只认明确失败）', () => {
  const live = { url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: '' };
  const Toast = require('@/utils/Toast').default as { show: jest.Mock };
  const stopped = async () => ({ state: 'STOPPED', status: 'OK' });
  const noProgress = async () => ({ positionMillis: 0, trackDurationMillis: 0, positionSupported: true, trackUri: '' });

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockEpisode = undefined;
    await AsyncStorage.clear();
    await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device));
  });

  afterEach(async () => {
    await useDlnaStore.getState().disableCast({ restoreLocal: false, stopRemote: true });
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'PLAYING', status: 'OK' }));
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: 'http://cdn/current', numberOfTracks: 1 }));
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 0, trackDurationMillis: 0, positionSupported: false, trackUri: '',
    }));
    jest.useRealTimers();
  });

  const expectFellBack = () => {
    expect(useDlnaStore.getState().enabled).toBe(false);
    expect(mockController.stop).toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ text1: '电视端加载失败', text2: '已切回本机播放' }));
  };

  const expectStillCasting = () => {
    expect(useDlnaStore.getState().enabled).toBe(true);
    expect(Toast.show).not.toHaveBeenCalledWith(expect.objectContaining({ text1: '电视端加载失败' }));
  };

  it('STOPPED 且电视清空了媒体地址（红米加载失败）：退回本机', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: '', numberOfTracks: 0 }));

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
  });

  it('STOPPED 且曲目数为 0（Kodi 加载失败）：退回本机', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: 'http://cdn/a.m3u8', numberOfTracks: 0 }));

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
  });

  it('STOPPED 但电视仍持有媒体（Macast 加载中）：无法判断，当作还在播放', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    mockController.getTransportInfo.mockImplementation(stopped);

    await jest.advanceTimersByTimeAsync(30000);

    expectStillCasting();
  });

  it('查询媒体信息失败：无法判断，当作还在播放', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getMediaInfo.mockImplementation(async () => { throw new Error('timeout'); });

    await jest.advanceTimersByTimeAsync(30000);

    expectStillCasting();
  });

  it('一直处于加载中（TRANSITIONING）：不超时判失败', async () => {
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'TRANSITIONING', status: 'OK' }));
    await useDlnaStore.getState().enableLiveCast(live);

    await jest.advanceTimersByTimeAsync(30000);

    expectStillCasting();
  });

  it('查询电视状态一直失败：不误判', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    mockController.getTransportInfo.mockImplementation(async () => { throw new Error('timeout'); });

    await jest.advanceTimersByTimeAsync(30000);

    expectStillCasting();
  });

  it('进度不动但电视状态是 PLAYING（如红米电视播直播）：保持投屏', async () => {
    mockController.getPositionInfo.mockImplementation(noProgress);
    await useDlnaStore.getState().enableLiveCast(live);

    await jest.advanceTimersByTimeAsync(25000);

    expectStillCasting();
  });

  it('TransportStatus 报 ERROR_OCCURRED：退回本机', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'PLAYING', status: 'ERROR_OCCURRED' }));

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
  });

  it('保护期后确认 PLAYING 且有播放证据，之后不再做加载判定', async () => {
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 1000, trackDurationMillis: 600000, positionSupported: true, trackUri: '',
    }));
    await useDlnaStore.getState().enableLiveCast(live);
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(5000);
    const calls = mockController.getTransportInfo.mock.calls.length;

    await jest.advanceTimersByTimeAsync(20000);

    expect(mockController.getTransportInfo.mock.calls.length).toBe(calls);
    expectStillCasting();
  });

  it('换台后新频道报无媒体（NO_MEDIA_PRESENT）：退回本机', async () => {
    let position = 0;
    mockController.getPositionInfo.mockImplementation(async () => {
      position += 1000;
      return { positionMillis: position, trackDurationMillis: 0, positionSupported: true, trackUri: '' };
    });
    await useDlnaStore.getState().enableLiveCast(live);
    await jest.advanceTimersByTimeAsync(5000);

    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'NO_MEDIA_PRESENT', status: 'OK' }));
    mockController.getPositionInfo.mockImplementation(noProgress);
    await useDlnaStore.getState().castLiveChannel({ ...live, url: 'http://cdn/b.m3u8', title: '湖南卫视' });
    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
  });

  it('剧集切下一集，Macast 加载期间报 STOPPED 但仍持有新片源：保持投屏，加载完成后正常播放', async () => {
    mockEpisode = { url: 'http://cdn/ep1.m3u8' };
    let position = 0;
    mockController.getPositionInfo.mockImplementation(async () => {
      position += 1000;
      return { positionMillis: position, trackDurationMillis: 600000, positionSupported: true, trackUri: '' };
    });
    await useDlnaStore.getState().enableCast();
    await jest.advanceTimersByTimeAsync(5000);

    mockEpisode = { url: 'http://cdn/ep2.m3u8' };
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getPositionInfo.mockImplementation(noProgress);
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: 'http://cdn/ep2.m3u8', numberOfTracks: 2 }));
    await useDlnaStore.getState().syncCurrentMedia({ positionMillis: 0, play: true });

    await jest.advanceTimersByTimeAsync(8000);
    expectStillCasting();

    // 加载完成后电视进入 PLAYING
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'PLAYING', status: 'OK' }));
    await jest.advanceTimersByTimeAsync(3000);
    expectStillCasting();
  });

  it('剧集换源后新片源加载失败（电视丢掉媒体）：退回本机，不写入时长为 0 的播放记录', async () => {
    mockEpisode = { url: 'http://cdn/source-a.mp4' };
    let position = 0;
    mockController.getPositionInfo.mockImplementation(async () => {
      position += 1000;
      return { positionMillis: position, trackDurationMillis: 600000, positionSupported: true, trackUri: '' };
    });
    await useDlnaStore.getState().enableCast();
    await jest.advanceTimersByTimeAsync(5000);

    mockEpisode = { url: 'http://cdn/source-b.mp4' };
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getPositionInfo.mockImplementation(noProgress);
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: '', numberOfTracks: 0 }));
    mockController.setAvTransportUri.mockClear();
    await useDlnaStore.getState().syncCurrentMedia({ positionMillis: 0, play: true });
    expect(mockController.setAvTransportUri).toHaveBeenCalledWith('http://cdn/source-b.mp4', expect.any(String), 'auto', undefined);

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
    expect(mockSavePlayRecord).not.toHaveBeenCalled();
  });

  it('剧集首次投屏加载失败：恢复本机播放到投屏前的进度', async () => {
    mockEpisode = { url: 'http://cdn/ep1.mp4' };
    // 电视返回时长后才会 Seek 到续播位置
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 0, trackDurationMillis: 600000, positionSupported: false, trackUri: '',
    }));
    await useDlnaStore.getState().enableCast();
    expect(useDlnaStore.getState().phase).toBe('connected');
    (usePlayerStore.setState as jest.Mock).mockClear();
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: '', numberOfTracks: 0 }));

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
    expect(mockSavePlayRecord).not.toHaveBeenCalled();
    const restore = (usePlayerStore.setState as jest.Mock).mock.calls
      .map(([arg]) => (typeof arg === 'function' ? arg({ status: {} }) : arg))
      .find((patch) => 'initialPosition' in patch);
    expect(restore).toMatchObject({ initialPosition: 30000, autoPlayAfterLoad: true });
  });

  const playingWithContent = async () => ({ positionMillis: 5000, trackDurationMillis: 2218000, positionSupported: true, trackUri: '' });

  it('Kodi：换源后加载中报 PLAYING（无时长、无进度），随后失败报 STOPPED 事件：按加载失败退回，不写播放记录', async () => {
    mockEpisode = { url: 'http://cdn/ep1.m3u8' };
    mockController.getPositionInfo.mockImplementation(playingWithContent);
    await useDlnaStore.getState().enableCast();
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(5000);
    expectStillCasting();

    mockEpisode = { url: 'http://cdn/bad.m3u8' };
    mockController.getPositionInfo.mockImplementation(noProgress);
    await useDlnaStore.getState().syncCurrentMedia({ positionMillis: 0, play: true });
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(3500);

    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: 'http://cdn/bad.m3u8', numberOfTracks: 0 }));
    mockEmitEvent?.({ transportState: 'STOPPED' });
    await jest.advanceTimersByTimeAsync(2000);

    expectFellBack();
    expect(Toast.show).not.toHaveBeenCalledWith(expect.objectContaining({ text1: '远端已关闭' }));
    expect(mockSavePlayRecord).not.toHaveBeenCalled();
  });

  it('Kodi：换源后先报 PLAYING 并沿用旧时长、失败后才报 STOPPED（未播到结尾且丢掉媒体）：按加载失败退回，不写播放记录', async () => {
    mockEpisode = { url: 'http://cdn/ep1.m3u8' };
    mockController.getPositionInfo.mockImplementation(playingWithContent);
    await useDlnaStore.getState().enableCast();
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(5000);
    expectStillCasting();

    // 换到坏源：电视先持续报 PLAYING 并沿用旧时长，随后才失败
    mockEpisode = { url: 'http://cdn/bad.m3u8' };
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 0, trackDurationMillis: 2218000, positionSupported: true, trackUri: '',
    }));
    await useDlnaStore.getState().syncCurrentMedia({ positionMillis: 0, play: true });
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(6000);

    // 没有被「沿用旧时长」骗成加载成功，也还没被当成远端已关闭
    expectStillCasting();
    expect(Toast.show).not.toHaveBeenCalledWith(expect.objectContaining({ text1: '远端已关闭' }));

    // 电视最终放弃：STOPPED 且丢掉媒体
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getMediaInfo.mockImplementation(async () => ({ currentUri: 'http://cdn/bad.m3u8', numberOfTracks: 0 }));
    mockEmitEvent?.({ transportState: 'STOPPED' });
    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
    expect(Toast.show).not.toHaveBeenCalledWith(expect.objectContaining({ text1: '远端已关闭' }));
    expect(mockSavePlayRecord).not.toHaveBeenCalled();
  });

  it('Macast：加载中报 PLAYING 后又报 STOPPED 事件但仍持有媒体：观察期内不按远端已关闭退出', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    mockController.getPositionInfo.mockImplementation(noProgress);
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(3500);

    mockController.getTransportInfo.mockImplementation(stopped);
    mockEmitEvent?.({ transportState: 'STOPPED' });
    await jest.advanceTimersByTimeAsync(5000);

    expectStillCasting();
    expect(Toast.show).not.toHaveBeenCalledWith(expect.objectContaining({ text1: '远端已关闭' }));
  });

  it('播放到结尾、电视在标称时长前 8 秒停止（Macast）：按远端播放已结束处理', async () => {
    mockEpisode = { url: 'http://cdn/ep1.m3u8' };
    mockController.getPositionInfo.mockImplementation(playingWithContent);
    await useDlnaStore.getState().enableCast();
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(5000);

    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 2210000, trackDurationMillis: 2218000, positionSupported: true, trackUri: '',
    }));
    await jest.advanceTimersByTimeAsync(2000);
    // 播完：电视停止并清空进度
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getPositionInfo.mockImplementation(async () => ({ positionMillis: 0, trackDurationMillis: 0, positionSupported: true, trackUri: '' }));
    mockEmitEvent?.({ transportState: 'STOPPED' });
    await jest.advanceTimersByTimeAsync(2000);

    expect(useDlnaStore.getState().enabled).toBe(false);
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ text1: '远端播放已结束' }));
  });

  it('播放到结尾、电视先把进度归零再停止（Kodi）：仍按远端播放已结束处理', async () => {
    mockEpisode = { url: 'http://cdn/ep1.m3u8' };
    mockController.getPositionInfo.mockImplementation(playingWithContent);
    await useDlnaStore.getState().enableCast();
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(5000);

    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 2214000, trackDurationMillis: 2219000, positionSupported: true, trackUri: '',
    }));
    await jest.advanceTimersByTimeAsync(2000);
    // 结束前进度先归零
    mockController.getPositionInfo.mockImplementation(async () => ({ positionMillis: 0, trackDurationMillis: 2219000, positionSupported: true, trackUri: '' }));
    await jest.advanceTimersByTimeAsync(2000);
    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getPositionInfo.mockImplementation(async () => ({ positionMillis: 0, trackDurationMillis: 0, positionSupported: true, trackUri: '' }));
    mockEmitEvent?.({ transportState: 'STOPPED' });
    await jest.advanceTimersByTimeAsync(2000);

    expect(useDlnaStore.getState().enabled).toBe(false);
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ text1: '远端播放已结束' }));
  });

  it('用户在电视上中途停止（离结尾很远）：仍按远端已关闭处理', async () => {
    mockEpisode = { url: 'http://cdn/ep1.m3u8' };
    mockController.getPositionInfo.mockImplementation(playingWithContent);
    await useDlnaStore.getState().enableCast();
    mockEmitEvent?.({ transportState: 'PLAYING' });
    await jest.advanceTimersByTimeAsync(5000);

    mockController.getTransportInfo.mockImplementation(stopped);
    mockController.getPositionInfo.mockImplementation(async () => ({ positionMillis: 0, trackDurationMillis: 0, positionSupported: true, trackUri: '' }));
    mockEmitEvent?.({ transportState: 'STOPPED' });
    await jest.advanceTimersByTimeAsync(2000);

    expect(useDlnaStore.getState().enabled).toBe(false);
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ text1: '远端已关闭' }));
  });
});