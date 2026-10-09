/** @jest-environment node */

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
  getTransportInfo: jest.fn(async () => ({ state: 'PLAYING' })),
};

jest.mock('@/services/dlna/control', () => ({
  DlnaController: jest.fn(() => mockController),
}));

jest.mock('@/services/dlna/discovery', () => ({
  startDlnaDiscovery: jest.fn(() => ({ stop: jest.fn(), devices: new Promise(() => {}) })),
}));

jest.mock('@/services/dlna/events', () => ({
  subscribeToDlnaEvents: jest.fn(async () => null),
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

describe('电视端加载失败时退回本机播放', () => {
  const live = { url: 'http://cdn/a.m3u8', title: 'CCTV-1', userAgent: '' };
  const Toast = require('@/utils/Toast').default as { show: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockEpisode = undefined;
    await AsyncStorage.clear();
    await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device));
  });

  afterEach(async () => {
    await useDlnaStore.getState().disableCast({ restoreLocal: false, stopRemote: true });
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'PLAYING' }));
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

  it('推送后电视停在 STOPPED：保护期结束即退回本机', async () => {
    await useDlnaStore.getState().enableLiveCast(live);
    expect(useDlnaStore.getState().phase).toBe('connected');
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'STOPPED' }));

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
  });

  it('20 秒内播放进度一直不动：退回本机', async () => {
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 0, trackDurationMillis: 0, positionSupported: true, trackUri: '',
    }));
    await useDlnaStore.getState().enableLiveCast(live);

    await jest.advanceTimersByTimeAsync(15000);
    expect(useDlnaStore.getState().enabled).toBe(true);

    await jest.advanceTimersByTimeAsync(6000);
    expectFellBack();
  });

  it('进度在推进：保持投屏', async () => {
    let position = 0;
    mockController.getPositionInfo.mockImplementation(async () => {
      position += 1000;
      return { positionMillis: position, trackDurationMillis: 0, positionSupported: true, trackUri: '' };
    });
    await useDlnaStore.getState().enableLiveCast(live);

    await jest.advanceTimersByTimeAsync(25000);

    expect(useDlnaStore.getState().enabled).toBe(true);
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('电视不支持位置查询且状态正常：不误判', async () => {
    await useDlnaStore.getState().enableLiveCast(live);

    await jest.advanceTimersByTimeAsync(25000);

    expect(useDlnaStore.getState().enabled).toBe(true);
  });

  it('换台后新频道加载失败：同样退回本机', async () => {
    let position = 0;
    mockController.getPositionInfo.mockImplementation(async () => {
      position += 1000;
      return { positionMillis: position, trackDurationMillis: 0, positionSupported: true, trackUri: '' };
    });
    await useDlnaStore.getState().enableLiveCast(live);
    await jest.advanceTimersByTimeAsync(5000);

    // 新频道加载失败：电视停在无媒体状态，进度不再前进
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'NO_MEDIA_PRESENT' }));
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 0, trackDurationMillis: 0, positionSupported: true, trackUri: '',
    }));
    await useDlnaStore.getState().castLiveChannel({ ...live, url: 'http://cdn/b.m3u8', title: '湖南卫视' });
    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
  });

  it('剧集投屏中换源，新片源加载失败（如 Macast loading failed）：退回本机播放', async () => {
    mockEpisode = { url: 'http://cdn/source-a.mp4' };
    let position = 0;
    mockController.getPositionInfo.mockImplementation(async () => {
      position += 1000;
      return { positionMillis: position, trackDurationMillis: 600000, positionSupported: true, trackUri: '' };
    });
    await useDlnaStore.getState().enableCast();
    await jest.advanceTimersByTimeAsync(5000);
    expect(useDlnaStore.getState().enabled).toBe(true);

    // 换源：播放器已切到新片源，电视加载新地址失败后停在 STOPPED，进度不动
    mockEpisode = { url: 'http://cdn/source-b.mp4' };
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'STOPPED' }));
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 0, trackDurationMillis: 0, positionSupported: true, trackUri: '',
    }));
    mockController.setAvTransportUri.mockClear();
    await useDlnaStore.getState().syncCurrentMedia({ positionMillis: 0, play: true });
    expect(mockController.setAvTransportUri).toHaveBeenCalledWith('http://cdn/source-b.mp4', expect.any(String), 'auto', undefined);

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
    expect(mockSavePlayRecord).not.toHaveBeenCalled();
  });

  it('剧集加载失败：恢复本机播放到投屏前的进度，且不写入时长为 0 的播放记录', async () => {
    mockEpisode = { url: 'http://cdn/ep1.mp4' };
    // 电视返回时长后才会 Seek 到续播位置
    mockController.getPositionInfo.mockImplementation(async () => ({
      positionMillis: 0, trackDurationMillis: 600000, positionSupported: false, trackUri: '',
    }));
    await useDlnaStore.getState().enableCast();
    expect(useDlnaStore.getState().phase).toBe('connected');
    (usePlayerStore.setState as jest.Mock).mockClear();
    mockController.getTransportInfo.mockImplementation(async () => ({ state: 'STOPPED' }));

    await jest.advanceTimersByTimeAsync(4000);

    expectFellBack();
    expect(mockSavePlayRecord).not.toHaveBeenCalled();
    const restore = (usePlayerStore.setState as jest.Mock).mock.calls
      .map(([arg]) => (typeof arg === 'function' ? arg({ status: {} }) : arg))
      .find((patch) => 'initialPosition' in patch);
    expect(restore).toMatchObject({ initialPosition: 30000, autoPlayAfterLoad: true });
  });
});
