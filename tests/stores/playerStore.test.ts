/**
 * 播放页复用 detail 缓存的回归用例。
 *
 * 背景：离开播放页会 `abort()` 后台初始化，被中止的 init 不会把 `allSourcesLoaded`
 * 置为 true；如果再次进入时只按 detail/episodes 判断复用，这个标志就永远停在 false，
 * 换源列表会一直显示加载中而实际没有任何源在测。
 */
import useDetailStore from '@/stores/detailStore';
import usePlayerStore from '@/stores/playerStore';
import { api } from '@/services/api';
import NetInfo from '@react-native-community/netinfo';
import { clearSpeedTestCache } from '@/services/m3u8';

jest.mock('@/services/api', () => ({
  api: { searchVideosWs: jest.fn(), searchVideo: jest.fn() },
}));

jest.mock('@/services/storage', () => ({
  PlayRecordManager: { get: jest.fn(async () => null) },
  PlayerSettingsManager: { get: jest.fn(async () => null) },
  SettingsManager: { get: jest.fn(async () => ({})), save: jest.fn(async () => {}) },
  FavoriteManager: {
    isFavorited: jest.fn(async () => false),
    toggle: jest.fn(async () => true),
    getAll: jest.fn(async () => ({})),
    remove: jest.fn(async () => true),
  },
}));

jest.mock('@/services/localProxy', () => ({
  mapEpisodesWithLocalProxy: jest.fn(async (episodes: string[]) => episodes),
}));

jest.mock('@/utils/Toast', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock(
  '@react-native-async-storage/async-storage',
  () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
}));

const mockApi = api as unknown as { searchVideosWs: jest.Mock; searchVideo: jest.Mock };
const mockNetInfoFetch = NetInfo.fetch as unknown as jest.Mock;

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXTINF:4.000,',
  'seg0.ts',
  '#EXTINF:6.000,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
].join('\n');

const makeResponse = (status: number, body: string, bytes: number) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(bytes),
});

const makeSource = (id: number, source: string) => ({
  id,
  title: '白日提灯',
  poster: '',
  episodes: [`https://${source}.example.com/index.m3u8`],
  source,
  source_name: source,
  year: '2025',
});

const withProbe = (item: ReturnType<typeof makeSource>, segmentLoadMs: number | null) => ({
  ...item,
  pingTime: 0,
  segmentLoadMs,
  segmentRatio: 0,
  useProxy: false,
});

const waitFor = async (condition: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
};

beforeEach(() => {
  jest.clearAllMocks();
  clearSpeedTestCache();
  mockNetInfoFetch.mockResolvedValue({ type: 'wifi' });
  useDetailStore.setState({
    q: null,
    title: null,
    searchResults: [],
    sources: [],
    detail: null,
    loading: true,
    error: null,
    allSourcesLoaded: false,
    controller: null,
    isFavorited: false,
    failedSources: new Set(),
    testingSource: null,
  });
  usePlayerStore.setState({ episodes: [], currentEpisodeIndex: 0 });
});

describe('播放页进入时的 detail 复用', () => {
  it('后台初始化被中止（allSourcesLoaded=false）：再次进入要重新初始化，不能一直停在加载中', async () => {
    const preferred = makeSource(1, 'pref');
    const other = makeSource(2, 'other');

    // ---- 第一次进入：推荐源测完、WS 其它源在后台测，服务端还没吐 complete ----
    mockApi.searchVideo.mockResolvedValue({ results: [preferred] });
    mockApi.searchVideosWs.mockResolvedValue([{ type: 'source_result', results: [other] }]);
    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (init.method === 'HEAD') return makeResponse(200, '', 0);
      if (url.includes('.m3u8')) return makeResponse(200, PLAYLIST, 0);
      return makeResponse(200, '', 512 * 1024);
    }) as any;

    const firstInit = useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, 'pref', '1', '');
    expect(await waitFor(() => useDetailStore.getState().detail?.source === 'pref')).toBe(true);
    useDetailStore.getState().startSpeedTest(); // 模拟起播，放行后台测速
    expect(
      await waitFor(() => useDetailStore.getState().searchResults.length === 2),
    ).toBe(true);

    // ---- 后退：play 卸载 -> playerStore.reset() -> detailStore.abort() ----
    useDetailStore.getState().abort();
    await firstInit;
    expect(useDetailStore.getState().allSourcesLoaded).toBe(false);
    expect(useDetailStore.getState().detail?.source).toBe('pref');

    // ---- 第二次进入：同一个源，应该重新初始化 ----
    mockApi.searchVideo.mockResolvedValue({ results: [preferred] });
    mockApi.searchVideosWs.mockImplementation(async () => [
      { type: 'source_result', results: [other] },
      { type: 'complete' },
    ]);
    mockApi.searchVideosWs.mockClear();

    await usePlayerStore.getState().loadVideo({
      source: 'pref',
      id: 1,
      episodeIndex: 0,
      title: '白日提灯',
      year: '2025',
      stype: 'tv',
    } as any);

    expect(mockApi.searchVideosWs).toHaveBeenCalled(); // 没有被"复用缓存"短路掉

    // 视频起播放行后台测速，init 才能收尾并把 allSourcesLoaded 置回 true
    useDetailStore.getState().startSpeedTest();
    expect(await waitFor(() => useDetailStore.getState().allSourcesLoaded)).toBe(true);
    expect(useDetailStore.getState().testingSource).toBeNull();
  });

  it('列表已加载完成（allSourcesLoaded=true）：再次进入复用缓存，不重新初始化', async () => {
    const preferred = makeSource(1, 'pref');
    useDetailStore.setState({
      q: '白日提灯',
      title: '白日提灯',
      searchResults: [withProbe(preferred, 123)],
      sources: [{ source: 'pref', source_name: 'pref', resolution: null }],
      detail: withProbe(preferred, 123),
      loading: false,
      allSourcesLoaded: true,
    });

    await usePlayerStore.getState().loadVideo({
      source: 'pref',
      id: 1,
      episodeIndex: 0,
      title: '白日提灯',
      year: '2025',
      stype: 'tv',
    } as any);

    expect(mockApi.searchVideosWs).not.toHaveBeenCalled();
    expect(mockApi.searchVideo).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().episodes.length).toBeGreaterThan(0);
  });
});
