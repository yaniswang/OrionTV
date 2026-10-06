import {
  clearSpeedTestCache,
  getCachedSpeedTest,
  measureM3U8Speed,
  pingM3U8,
  resolveM3U8Segments,
  M3U8ProbeInfo,
} from "@/services/m3u8";

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:4.000,',
  'seg0.ts',
  '#EXTINF:6.000,',
  'seg1.ts',
  '#EXTINF:6.000,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
].join('\n');

/** 前 2 个分片会被 1KB 截断的长清单：第 2 条地址跨过了 1024 字节 */
const LONG_LEAF = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:4.000,',
  `seg0-${'a'.repeat(600)}.ts`,
  '#EXTINF:6.000,',
  `seg1-${'b'.repeat(600)}.ts`,
  '#EXTINF:6.000,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
].join('\n');

type RecordedCall = { url: string; method: string; range: string | null };

let calls: RecordedCall[] = [];
let segmentInFlight = 0;
let segmentMaxInFlight = 0;
let headStatus = 200;
let segmentStatus = 200;
let playlistBody = PLAYLIST;
let playlistHonorsRange = false;

const makeResponse = (status: number, body: string, bytes: number) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(bytes),
});

beforeEach(() => {
  clearSpeedTestCache();
  calls = [];
  segmentInFlight = 0;
  segmentMaxInFlight = 0;
  headStatus = 200;
  segmentStatus = 200;
  playlistBody = PLAYLIST;
  playlistHonorsRange = false;

  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const range = (init.headers || {}).Range ?? null;
    calls.push({ url, method, range });

    if (url.includes('.m3u8')) {
      if (range && playlistHonorsRange) {
        return makeResponse(206, playlistBody.slice(0, 1024), 1024);
      }
      return makeResponse(200, playlistBody, playlistBody.length);
    }
    if (method === 'HEAD') {
      return makeResponse(headStatus, '', 0);
    }

    segmentInFlight++;
    segmentMaxInFlight = Math.max(segmentMaxInFlight, segmentInFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    segmentInFlight--;
    return makeResponse(segmentStatus, '', 512 * 1024);
  }) as any;
});

describe("pingM3U8", () => {
  it("清单只取 1KB（带 Range），首个分片仍用 HEAD，两个请求都带时间戳", async () => {
    const result = await pingM3U8('https://ping-a.example.com/index.m3u8', new AbortController().signal);

    expect(result?.info.blocked).toBe(false);
    expect(result?.info.segmentRatio).toBe(0); // ping 阶段不做完整测速

    // 前 2 个分片留给完整测速用
    expect(result?.segments?.map((segment) => segment.duration)).toEqual([4, 6]);
    expect(result?.segments?.[0].url).toContain('/seg0.ts');
    expect(result?.segments?.[1].url).toContain('/seg1.ts');

    expect(calls.map((call) => call.method)).toEqual(['GET', 'HEAD']);
    expect(calls[0].url).toContain('/index.m3u8');
    expect(calls[1].url).toContain('/seg0.ts');
    calls.forEach((call) => expect(call.url).toContain('_t123789='));
    expect(calls[0].range).toBe('bytes=0-1023'); // 只有清单走 Range
    expect(calls[1].range).toBeNull();
  });

  it("首个分片返回 403 时判定该路由不可用", async () => {
    headStatus = 403;
    const result = await pingM3U8('https://ping-b.example.com/index.m3u8', new AbortController().signal);
    expect(result?.info.blocked).toBe(true);
  });

  it("首个分片返回 405 时不判定为不可用", async () => {
    headStatus = 405;
    const result = await pingM3U8('https://ping-c.example.com/index.m3u8', new AbortController().signal);
    expect(result?.info.blocked).toBe(false);
  });

  it("源站忽略 Range（返回 200 全量）时不会重复请求清单", async () => {
    const result = await pingM3U8('https://ping-f.example.com/index.m3u8', new AbortController().signal);

    const manifestCalls = calls.filter((call) => call.url.includes('.m3u8'));
    expect(manifestCalls).toHaveLength(1);
    expect(manifestCalls[0].range).toBe('bytes=0-1023');
    expect(result?.segments).toHaveLength(2);
  });

  it("清单被 1KB 截断（不足 2 个分片）时退回全量重拉一次", async () => {
    playlistBody = LONG_LEAF;
    playlistHonorsRange = true;

    const result = await pingM3U8('https://ping-g.example.com/index.m3u8', new AbortController().signal);

    const manifestCalls = calls.filter((call) => call.url.includes('.m3u8'));
    expect(manifestCalls).toHaveLength(2);
    expect(manifestCalls[0].range).toBe('bytes=0-1023');
    expect(manifestCalls[1].range).toBeNull(); // 第二次不带 Range
    // 退回全量后拿到完整的前 2 个分片地址
    expect(result?.segments).toHaveLength(2);
    expect(result?.segments?.[1].url).toContain(`seg1-${'b'.repeat(600)}.ts`);
  });

  it("测速缓存开启：命中同域名缓存就不重复下分片，PING 仍然每次都真实请求", async () => {
    const url = 'https://ping-d.example.com/index.m3u8';
    const signal = new AbortController().signal;

    const first = await pingM3U8(url, signal);
    const measured = await measureM3U8Speed(url, first!.segments, signal, first!.info);
    expect(measured.segmentRatio).toBeGreaterThan(0);
    // 成功的完整测速结果会缓存下来，缓存按域名判断：同域名不同剧集也算命中，别的域名不命中
    expect(getCachedSpeedTest(url)?.segmentRatio).toBe(measured.segmentRatio);
    expect(getCachedSpeedTest('https://ping-d.example.com/another/index.m3u8')?.segmentRatio).toBe(
      measured.segmentRatio,
    );
    expect(getCachedSpeedTest('https://ping-e.example.com/index.m3u8')).toBeNull();

    const requestsBefore = calls.length;
    const second = await pingM3U8(url, signal);
    expect(second?.info.segmentRatio).toBe(0);
    expect(second?.segments).toHaveLength(2);
    // 清单 + HEAD 都是重新请求的
    expect(calls.length).toBe(requestsBefore + 2);
  });

  it("中断后停止请求并返回 null", async () => {
    let fetchAborted = false;
    global.fetch = jest.fn(
      (_input: any, init: any = {}) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            fetchAborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    ) as any;

    const controller = new AbortController();
    const pending = pingM3U8('https://ping-e.example.com/index.m3u8', controller.signal);
    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(fetchAborted).toBe(true);
  });
});

describe("resolveM3U8Segments", () => {
  it("非 M3U8 地址不发请求，直接返回 null", async () => {
    const segments = await resolveM3U8Segments(
      'https://resolve-a.example.com/movie.mp4',
      new AbortController().signal,
    );
    expect(segments).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("只拉清单就能解析出前 2 个分片，不下载分片、不 HEAD", async () => {
    const segments = await resolveM3U8Segments(
      'https://resolve-b.example.com/index.m3u8',
      new AbortController().signal,
    );

    expect(segments?.map((segment) => segment.duration)).toEqual([4, 6]);
    expect(segments?.[0].url).toContain('/seg0.ts');
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(calls[0].url).toContain('_t123789=');
    expect(calls[0].range).toBe('bytes=0-1023'); // 清单只取前 1KB
  });

  it("清单被 1KB 截断时退回全量重拉，拿到完整的前 2 个分片", async () => {
    playlistBody = LONG_LEAF;
    playlistHonorsRange = true;

    const segments = await resolveM3U8Segments(
      'https://resolve-f.example.com/index.m3u8',
      new AbortController().signal,
    );

    expect(calls.map((call) => call.range)).toEqual(['bytes=0-1023', null]);
    expect(segments).toHaveLength(2);
    expect(segments?.[1].url).toContain(`seg1-${'b'.repeat(600)}.ts`);
  });

  it("master 清单会继续跟进子清单", async () => {
    global.fetch = jest.fn(async (input: any) => {
      const url = String(input);
      calls.push({ url, method: 'GET', range: null });
      if (url.includes('/master.m3u8')) {
        return makeResponse(
          200,
          '#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1000\nchunklist.m3u8\n',
          0,
        );
      }
      return makeResponse(200, PLAYLIST, 0);
    }) as any;

    const segments = await resolveM3U8Segments(
      'https://resolve-c.example.com/master.m3u8',
      new AbortController().signal,
    );

    expect(segments?.map((segment) => segment.duration)).toEqual([4, 6]);
    expect(calls.map((call) => call.url.split('?')[0])).toEqual([
      'https://resolve-c.example.com/master.m3u8',
      'https://resolve-c.example.com/chunklist.m3u8',
    ]);
    // 主清单和子清单都要带时间戳，绕开 CDN 缓存
    calls.forEach((call) => expect(call.url).toContain('_t123789='));
  });

  it("清单返回非 200 时返回 null", async () => {
    global.fetch = jest.fn(async (input: any) => {
      calls.push({ url: String(input), method: 'GET', range: null });
      return makeResponse(403, '', 0);
    }) as any;

    const segments = await resolveM3U8Segments(
      'https://resolve-d.example.com/index.m3u8',
      new AbortController().signal,
    );
    expect(segments).toBeNull();
  });

  it("中断后停止请求并返回 null", async () => {
    global.fetch = jest.fn(
      (_input: any, init: any = {}) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    ) as any;

    const controller = new AbortController();
    const pending = resolveM3U8Segments('https://resolve-e.example.com/index.m3u8', controller.signal);
    controller.abort();

    await expect(pending).resolves.toBeNull();
  });
});

describe("measureM3U8Speed", () => {
  it("前 2 个分片并发下载，按总时长 / 总耗时算倍率", async () => {
    const url = 'https://speed-a.example.com/index.m3u8';
    const signal = new AbortController().signal;

    const ping = await pingM3U8(url, signal);
    const info = await measureM3U8Speed(url, ping!.segments!, signal, ping!.info);

    expect(segmentMaxInFlight).toBe(2); // 并发下载，贴近真实并行播放
    expect(info.segmentDurationMs).toBe(10000); // 4s + 6s
    expect(info.segmentLoadMs).not.toBeNull();
    expect(info.segmentRatio).toBeGreaterThan(0);
    expect(info.blocked).toBe(false);

    // 只统计完整测速的分片下载（ping 的首个分片是 HEAD，不算在内）
    const segmentCalls = calls.filter((call) => call.method === 'GET' && !call.url.includes('.m3u8'));
    expect(segmentCalls).toHaveLength(2);
    segmentCalls.forEach((call) => expect(call.url).toContain('_t123789='));
  });

  it("分片返回 403 时判定不可用，且不写入缓存", async () => {
    segmentStatus = 403;
    const url = 'https://speed-b.example.com/index.m3u8';
    const signal = new AbortController().signal;
    const baseInfo: M3U8ProbeInfo = {
      pingTime: 100,
      segmentLoadMs: null,
      segmentDurationMs: null,
      segmentRatio: 0,
    };

    const info = await measureM3U8Speed(
      url,
      [{ url: 'https://speed-b.example.com/seg0.ts', duration: 4 }],
      signal,
      baseInfo,
    );

    expect(info.blocked).toBe(true);
    expect(info.segmentRatio).toBe(0);
    expect(getCachedSpeedTest(url)).toBeNull();

    // ping 不做缓存，每次都会重新拉清单 + HEAD
    const ping = await pingM3U8(url, signal);
    expect(ping?.info.segmentRatio).toBe(0);
  });

  it("PING 因 HEAD 502 判 blocked 时，只要分片 GET 正常就算测速成功并写进缓存", async () => {
    const url = 'https://speed-e.example.com/index.m3u8';
    const signal = new AbortController().signal;
    // ping 阶段 HEAD 502 → blocked，但分片 GET 是正常 200
    headStatus = 502;
    const pinged = await pingM3U8(url, signal);
    expect(pinged?.info.blocked).toBe(true);

    const info = await measureM3U8Speed(url, pinged!.segments, signal, pinged!.info);
    expect(info.blocked).toBeFalsy(); // 不继承 PING 的 blocked
    expect(info.segmentRatio).toBeGreaterThan(0);
    expect(getCachedSpeedTest(url)?.segmentRatio).toBe(info.segmentRatio);
  });

  it("单片超时 = 分片时长 × 2，有一片超时时倍率最低掉到 0.5", async () => {
    const baseInfo: M3U8ProbeInfo = {
      pingTime: 100,
      segmentLoadMs: null,
      segmentDurationMs: null,
      segmentRatio: 0,
    };

    // seg0 一直挂着等超时，seg1 立刻返回；分片时长 0.3s → 单片超时 600ms
    global.fetch = jest.fn((input: any, init: any = {}) => {
      if (String(input).includes('seg0')) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return Promise.resolve(makeResponse(200, '', 512 * 1024));
    }) as any;

    const startedAt = Date.now();
    const info = await measureM3U8Speed(
      'https://speed-d.example.com/index.m3u8',
      [
        { url: 'https://speed-d.example.com/seg0.ts', duration: 0.3 },
        { url: 'https://speed-d.example.com/seg1.ts', duration: 0.3 },
      ],
      new AbortController().signal,
      baseInfo,
    );
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2500); // 600ms 就超时了，不是原来的 20s
    expect(info.segmentLoadMs).toBeGreaterThanOrEqual(590);
    expect(info.segmentLoadMs).toBeLessThan(1000);
    expect(info.segmentDurationMs).toBe(300); // 只累加成功的那一片
    expect(info.segmentRatio).toBeGreaterThanOrEqual(0.4);
    expect(info.segmentRatio).toBeLessThanOrEqual(0.55); // 倍率下限 0.5
    expect(info.blocked).toBeFalsy();
  });

  it("中断后不再返回倍率", async () => {
    const controller = new AbortController();
    const baseInfo: M3U8ProbeInfo = {
      pingTime: 100,
      segmentLoadMs: null,
      segmentDurationMs: null,
      segmentRatio: 0,
    };

    global.fetch = jest.fn(
      (_input: any, init: any = {}) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    ) as any;

    const pending = measureM3U8Speed(
      'https://speed-c.example.com/index.m3u8',
      [
        { url: 'https://speed-c.example.com/seg0.ts', duration: 4 },
        { url: 'https://speed-c.example.com/seg1.ts', duration: 6 },
      ],
      controller.signal,
      baseInfo,
    );
    controller.abort();

    const info = await pending;
    expect(info.segmentRatio).toBe(0);
    expect(info.segmentLoadMs).toBeNull();
  });
});
