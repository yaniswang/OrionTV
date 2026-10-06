import useDetailStore from '@/stores/detailStore';
import { api } from '@/services/api';
import { SearchResult } from '@/services/api';
import { clearSpeedTestCache } from '@/services/m3u8';

jest.mock('@/services/api', () => ({
  api: {
    searchVideosWs: jest.fn(),
    searchVideo: jest.fn(),
  },
}));

jest.mock('@/services/storage', () => ({
  FavoriteManager: {
    isFavorited: jest.fn(async () => false),
    toggle: jest.fn(async () => true),
  },
}));

const mockApi = api as unknown as {
  searchVideosWs: jest.Mock;
  searchVideo: jest.Mock;
};

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXTINF:4.000,',
  'seg0.ts',
  '#EXTINF:6.000,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
].join('\n');

/** PING 阶段对首个分片的 HEAD 探测次数 */
let probeCalls = 0;

const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 轮询等待某个条件成立（用于观察测速过程中的中间状态） */
const waitFor = async (condition: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
};

const makeResponse = (status: number, body: string, bytes: number) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(bytes),
});

const makeSource = (id: number, source: string, m3u8Url: string): SearchResult => ({
  id,
  title: '白日提灯',
  poster: '',
  episodes: [m3u8Url],
  source,
  source_name: source,
  year: '2025',
});

beforeEach(() => {
  jest.clearAllMocks();
  probeCalls = 0;
  clearSpeedTestCache();
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
  });

  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    if (init.method === 'HEAD') {
      probeCalls++;
      return makeResponse(200, '', 0);
    }
    if (url.includes('.m3u8')) {
      return makeResponse(200, PLAYLIST, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return makeResponse(200, '', 512 * 1024);
  }) as any;
});

describe('detailStore.init 有推荐源', () => {
  it('跳过 PING：推荐源立即进列表，WS 源返回后直接进列表并测速，全程不发 HEAD 请求', async () => {
    const preferred = makeSource(1, 'pref', 'https://pref.example.com/index.m3u8');
    const other = makeSource(2, 'other', 'https://other.example.com/index.m3u8');
    mockApi.searchVideo.mockResolvedValue({ results: [preferred] });
    let releaseWs: (messages: { type: string; results?: SearchResult[] }[]) => void = () => {};
    mockApi.searchVideosWs.mockReturnValue(
      new Promise((resolve) => {
        releaseWs = resolve;
      }),
    );

    const initPromise = useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, 'pref', '1', '');

    // WS 还没返回：推荐源已经在列表里（边等搜索边播放）
    await flushAsyncWork();
    expect(useDetailStore.getState().searchResults.map((result) => result.source)).toEqual(['pref']);
    expect(probeCalls).toBe(0);

    releaseWs([
      { type: 'source_result', results: [other] },
      { type: 'complete' },
    ]);
    await initPromise;

    const finalState = useDetailStore.getState();
    expect(probeCalls).toBe(0); // 跳过 PING：没有分片探测
    expect(finalState.searchResults.map((result) => result.source).sort()).toEqual(['other', 'pref']);
    expect(finalState.searchResults.every((result) => result.segmentLoadMs != null)).toBe(true);
    expect(finalState.error).toBeNull();
  });

  it('测速中的源会写进 testingSource，测完清空', async () => {
    const preferred = makeSource(1, 'pref', 'https://pref.example.com/index.m3u8');
    mockApi.searchVideo.mockResolvedValue({ results: [preferred] });
    mockApi.searchVideosWs.mockResolvedValue([{ type: 'complete' }]);

    let releaseSegments: () => void = () => {};
    const segmentGate = new Promise<void>((resolve) => {
      releaseSegments = resolve;
    });

    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (init.method === 'HEAD') {
        probeCalls++;
        return makeResponse(200, '', 0);
      }
      if (url.includes('.m3u8')) {
        return makeResponse(200, PLAYLIST, 0);
      }
      await segmentGate;
      return makeResponse(200, '', 512 * 1024);
    }) as any;

    const initPromise = useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, 'pref', '1', '');

    expect(await waitFor(() => useDetailStore.getState().testingSource === 'pref')).toBe(true);
    releaseSegments();
    await initPromise;
    expect(useDetailStore.getState().testingSource).toBeNull();
  });
  it('缓存按两条路由一起查：上次回退直连测出的结果，二次打开直接复用不再重测', async () => {
    const proxyPrefix = 'https://proxy.example.com/';
    const preferred = makeSource(1, 'pref', 'https://pref.example.com/index.m3u8');
    mockApi.searchVideo.mockResolvedValue({ results: [preferred] });
    // 每次 init 都要一份新的消息数组：searchVideosWs 返回的数组会被调用方 shift 掉
    mockApi.searchVideosWs.mockImplementation(async () => [{ type: 'complete' }]);

    let segmentGets = 0;
    global.fetch = jest.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('.m3u8')) {
        // 代理路由的清单 403，直连清单正常：这条源只会在直连上测出结果
        return url.startsWith(proxyPrefix) ? makeResponse(403, '', 0) : makeResponse(200, PLAYLIST, 0);
      }
      segmentGets++;
      return makeResponse(200, '', 512 * 1024);
    }) as any;

    await useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, 'pref', '1', proxyPrefix);
    const getsAfterFirst = segmentGets;
    expect(getsAfterFirst).toBeGreaterThan(0);
    expect(useDetailStore.getState().searchResults[0].useProxy).toBe(false);

    // 二次打开：缓存里只有直连那条，也要命中（并把播放路由切成直连），不再下分片
    await useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, 'pref', '1', proxyPrefix);
    expect(segmentGets).toBe(getsAfterFirst);
    const [second] = useDetailStore.getState().searchResults;
    expect(second.segmentLoadMs).not.toBeNull();
    expect(second.useProxy).toBe(false);
  });

  it('代理清单返回 403 时回退直连，仍然测出倍率', async () => {
    const proxyPrefix = 'https://proxy.example.com/';
    const preferred = makeSource(1, 'pref', 'https://pref.example.com/index.m3u8');
    mockApi.searchVideo.mockResolvedValue({ results: [preferred] });
    mockApi.searchVideosWs.mockResolvedValue([{ type: 'complete' }]);

    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes('.m3u8')) {
        // 代理路由的清单 403，直连清单正常
        return url.startsWith(proxyPrefix) ? makeResponse(403, '', 0) : makeResponse(200, PLAYLIST, 0);
      }
      return makeResponse(200, '', 512 * 1024);
    }) as any;

    await useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, 'pref', '1', proxyPrefix);

    const [result] = useDetailStore.getState().searchResults;
    expect(result.segmentLoadMs).not.toBeNull();
    expect(result.segmentRatio).toBeGreaterThan(0);
    expect(result.useProxy).toBe(false); // 代理不可用，改用直连
  });
});

describe('detailStore.init 无推荐源', () => {
  it('保留 PING 流程：清单 + 首个分片 Range 探测，第一轮结果就自动开始播放', async () => {
    const only = makeSource(1, 'a', 'https://a.example.com/index.m3u8');
    mockApi.searchVideosWs.mockResolvedValue([
      { type: 'source_result', results: [only] },
      { type: 'complete' },
    ]);

    await useDetailStore.getState().init('白日提灯', '白日提灯', '2025', undefined as unknown as string, undefined, undefined, '');

    const state = useDetailStore.getState();
    expect(probeCalls).toBeGreaterThan(0); // 没跳过 PING：做了分片探测
    expect(mockApi.searchVideo).not.toHaveBeenCalled();
    expect(state.searchResults.map((result) => result.source)).toEqual(['a']);
    expect(state.detail?.source).toBe('a');
  });
});

describe('插入即入队：列表顺序 = 测速顺序', () => {
  it('同一批源按 PING 完成顺序插表，插入的同时进测速队列', async () => {
    const slow = makeSource(1, 'slow', 'https://slow.example.com/index.m3u8');
    const fast = makeSource(2, 'fast', 'https://fast.example.com/index.m3u8');
    // 同一条 WS 消息按 slow、fast 的顺序返回，但 fast 的 PING 先完成
    mockApi.searchVideosWs.mockResolvedValue([
      { type: 'source_result', results: [slow, fast] },
      { type: 'complete' },
    ]);

    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (init.method === 'HEAD') {
        probeCalls++;
        return makeResponse(200, '', 0);
      }
      if (url.includes('.m3u8')) {
        if (url.includes('slow.example.com')) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return makeResponse(200, PLAYLIST, 0);
      }
      // 分片一律 403：两个源都测不出倍率，顺序里只剩"插表顺序"这一条规则
      return makeResponse(403, '', 0);
    }) as any;

    await useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, undefined, undefined, '');

    const state = useDetailStore.getState();
    expect(state.searchResults.map((result) => result.source)).toEqual(['fast', 'slow']);
    expect(state.searchResults.every((result) => result.segmentLoadMs == null)).toBe(true);
  });

  it('第一个 PING 返回就先插表、先开播，排在最前面', async () => {
    const slow = makeSource(1, 'slow', 'https://slow.example.com/index.m3u8');
    const fast = makeSource(2, 'fast', 'https://fast.example.com/index.m3u8');
    mockApi.searchVideosWs.mockResolvedValue([
      { type: 'source_result', results: [slow, fast] },
      { type: 'complete' },
    ]);

    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (init.method === 'HEAD') {
        probeCalls++;
        return makeResponse(200, '', 0);
      }
      if (url.includes('.m3u8')) {
        if (url.includes('slow.example.com')) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return makeResponse(200, PLAYLIST, 0);
      }
      // 分片一律 403：两个源都测不出倍率，顺序里只剩插入顺序这一条规则
      return makeResponse(403, '', 0);
    }) as any;

    const initPromise = useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, undefined, undefined, '');

    // fast 的 PING 先回来：它先出现在列表里并自动开播，此时 slow 还没 ping 完
    expect(await waitFor(() => useDetailStore.getState().searchResults.length > 0)).toBe(true);
    expect(useDetailStore.getState().searchResults.map((result) => result.source)).toEqual(['fast']);
    expect(useDetailStore.getState().detail?.source).toBe('fast');

    await initPromise;
    // 全部到齐后按插表顺序排：先 ping 完的 fast 在前
    expect(useDetailStore.getState().searchResults.map((result) => result.source)).toEqual(['fast', 'slow']);
  });

  it('测完一个源就把"测速中"图标交接给下一个待测源，中间不会没有图标', async () => {
    const a = makeSource(1, 'a', 'https://a.example.com/index.m3u8');
    const b = makeSource(2, 'b', 'https://b.example.com/index.m3u8');
    mockApi.searchVideosWs.mockResolvedValue([
      { type: 'source_result', results: [a, b] },
      { type: 'complete' },
    ]);

    // b 的 ping 慢一点：保证先插表先测的是 a，这样 a 测完时 b 一定还在待测
    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (init.method === 'HEAD') {
        probeCalls++;
        return makeResponse(200, '', 0);
      }
      if (url.includes('.m3u8')) {
        if (url.includes('b.example.com')) {
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return makeResponse(200, PLAYLIST, 0);
      }
      return makeResponse(200, '', 512 * 1024);
    }) as any;

    // a 已测出倍率、b 还没测时，图标必须已经落在 b 上
    const gaps: (string | null)[] = [];
    const unsubscribe = useDetailStore.subscribe((state) => {
      const aDone = state.searchResults.some((result) => result.source === 'a' && result.segmentLoadMs != null);
      const bPending = state.searchResults.some((result) => result.source === 'b' && result.segmentLoadMs == null);
      if (aDone && bPending && state.testingSource !== 'b') gaps.push(state.testingSource);
    });

    await useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, undefined, undefined, '');
    unsubscribe();

    expect(gaps).toEqual([]);
  });

  it('写倍率之前先撤掉"测速中"图标，刚测完的源不会带着图标停在已测区', async () => {
    const a = makeSource(1, 'a', 'https://a.example.com/index.m3u8');
    const b = makeSource(2, 'b', 'https://b.example.com/index.m3u8');
    mockApi.searchVideosWs.mockResolvedValue([
      { type: 'source_result', results: [a, b] },
      { type: 'complete' },
    ]);

    // 每一次状态变化都检查：正在测的源不能同时已经是"已测源"
    const violations: string[] = [];
    const unsubscribe = useDetailStore.subscribe((state) => {
      const testing = state.testingSource;
      if (!testing) return;
      const alreadyMeasured = state.searchResults.some(
        (result) => result.source === testing && result.segmentLoadMs != null,
      );
      if (alreadyMeasured) violations.push(testing);
    });

    await useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, undefined, undefined, '');
    unsubscribe();

    expect(violations).toEqual([]);
  });

  it('谁先 PING 完谁先插表先测，测完只有已测源重排', async () => {
    const first = makeSource(1, 'first', 'https://first.example.com/index.m3u8');
    const second = makeSource(2, 'second', 'https://second.example.com/index.m3u8');
    mockApi.searchVideosWs.mockResolvedValue([
      { type: 'source_result', results: [first, second] },
      { type: 'complete' },
    ]);

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    global.fetch = jest.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (init.method === 'HEAD') {
        probeCalls++;
        return makeResponse(200, '', 0);
      }
      if (url.includes('.m3u8')) {
        // first 的 ping 更慢：所以先插表、先测的应该是 second
        if (url.includes('first.example.com')) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return makeResponse(200, PLAYLIST, 0);
      }
      if (url.includes('first.example.com')) await firstGate;
      return makeResponse(200, '', 512 * 1024);
    }) as any;

    const tested: string[] = [];
    const unsubscribe = useDetailStore.subscribe((state) => {
      if (state.testingSource && tested[tested.length - 1] !== state.testingSource) {
        tested.push(state.testingSource);
      }
    });

    const initPromise = useDetailStore
      .getState()
      .init('白日提灯', '白日提灯', '2025', undefined as unknown as string, undefined, undefined, '');

    expect(await waitFor(() => tested.length > 0)).toBe(true);
    expect(tested[0]).toBe('second'); // 先 PING 完的先插表、先进测速队列

    // second 测完、first 还在测速中：second 升到最前，first 仍在未测区
    expect(
      await waitFor(() => {
        const list = useDetailStore.getState().searchResults;
        return list.length === 2 && list[0].source === 'second' && list[0].segmentLoadMs != null;
      }),
    ).toBe(true);
    const midList = useDetailStore.getState().searchResults;
    expect(midList.map((result) => result.source)).toEqual(['second', 'first']);
    expect(midList[1].segmentLoadMs).toBeNull();

    releaseFirst();
    await initPromise;
    unsubscribe();

    const finalList = useDetailStore.getState().searchResults;
    expect(finalList.map((result) => result.source).sort()).toEqual(['first', 'second']);
    expect(finalList.every((result) => result.segmentLoadMs != null)).toBe(true);
  });
});
