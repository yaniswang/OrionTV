import { SegmentCache } from '@/services/localProxy/cache';
import {
  applyRange,
  buildForwardHeaders,
  bytesResult,
  parseHead,
  readQuery,
  textResult,
  type ProxyResult,
} from '@/services/localProxy/http';
import {
  buildProxyUrl,
  decodeTarget,
  encodeTarget,
  hashString,
  isHlsPlaylist,
  isLeafPlaylist,
  PREFETCH_COUNT,
  rewriteChildPlaylist,
  rewriteLeafPlaylist,
} from '@/services/localProxy/playlist';
import { planPrefetchWindow } from '@/services/localProxy/prefetchWindow';

const ORIGIN = 'http://127.0.0.1:18923';

describe('encodeTarget / decodeTarget', () => {
  it('能原样往返含 / ? & = 的地址', () => {
    const url = 'https://cdn.example/a/b/seg.ts?token=abc&x=1=2';
    const token = encodeTarget(url);
    expect(token).not.toMatch(/[/?&=]/);
    expect(decodeTarget(token)).toBe(url);
  });

  it('能往返 m3u8Proxy 叠加后的双层地址', () => {
    const url = 'https://mp.example/https://cdn.example/a/index.m3u8?__p=wdjh29&__s=3';
    expect(decodeTarget(encodeTarget(url))).toBe(url);
  });

  it('清单地址带 .m3u8 后缀（播放器据此判定 HLS），分片地址不带', () => {
    const playlist = buildProxyUrl(ORIGIN, 'https://cdn.example/a/index.m3u8');
    const segment = buildProxyUrl(ORIGIN, 'https://cdn.example/a/seg0.ts', 0, 'p1');

    expect(playlist.endsWith('.m3u8')).toBe(true);
    expect(segment.endsWith('.m3u8')).toBe(false);
    // 带后缀也要能解回原始地址
    expect(decodeTarget(playlist.slice(ORIGIN.length + 1))).toBe(
      'https://cdn.example/a/index.m3u8',
    );
  });

  it('能往返中文等非 ASCII 地址', () => {
    const url = 'https://cdn.example/剧集/第01集.m3u8';
    expect(decodeTarget(encodeTarget(url))).toBe(url);
  });
});

describe('hashString', () => {
  it('同一输入稳定，不同输入不同', () => {
    expect(hashString('https://a/b.m3u8')).toBe(hashString('https://a/b.m3u8'));
    expect(hashString('https://a/b.m3u8')).not.toBe(hashString('https://a/c.m3u8'));
  });
});

describe('playlist 类型判定', () => {
  it('必须是 #EXTM3U 开头才算清单', () => {
    expect(isHlsPlaylist('#EXTM3U\n#EXTINF:1,\na.ts')).toBe(true);
    expect(isHlsPlaylist('<html>404</html>')).toBe(false);
  });

  it('含 #EXTINF 才算最终分片清单', () => {
    expect(isLeafPlaylist('#EXTM3U\n#EXTINF:1,\na.ts')).toBe(true);
    expect(isLeafPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8')).toBe(false);
  });
});

describe('rewriteLeafPlaylist', () => {
  const source = 'https://cdn.example/a/b/index.m3u8';
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00',
    '#EXTINF:6.0,',
    'seg0.ts',
    '#EXTINF:6.0,',
    '../other/seg1.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  it('把分片解析成绝对地址并指向本地代理，带 pid/sid', () => {
    const leaf = rewriteLeafPlaylist(text, ORIGIN, source);

    expect(leaf.segments).toEqual([
      'https://cdn.example/a/b/seg0.ts',
      'https://cdn.example/a/other/seg1.ts',
    ]);
    expect(leaf.pid).toBe(hashString(source));
    expect(leaf.text).toContain(
      `${ORIGIN}/${encodeTarget(leaf.segments[0])}?pid=${leaf.pid}&sid=0`,
    );
    expect(leaf.text).toContain(
      `${ORIGIN}/${encodeTarget(leaf.segments[1])}?pid=${leaf.pid}&sid=1`,
    );
  });

  it('改写 #EXT-X-KEY 的 URI（不带 pid/sid）', () => {
    const leaf = rewriteLeafPlaylist(text, ORIGIN, source);
    const keyUrl = `${ORIGIN}/${encodeTarget('https://cdn.example/a/b/enc.key')}.m3u8`;
    expect(leaf.text).toContain(`URI="${keyUrl}"`);
  });

  it('改写 #EXT-X-MAP 的 URI，避免相对路径落到代理根上', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6.0,',
      'seg0.m4s',
    ].join('\n');

    const leaf = rewriteLeafPlaylist(text, ORIGIN, source);
    const mapUrl = `${ORIGIN}/${encodeTarget('https://cdn.example/a/b/init.mp4')}.m3u8`;
    expect(leaf.text).toContain(`#EXT-X-MAP:URI="${mapUrl}"`);
  });

  it('保留原有标签行', () => {
    const leaf = rewriteLeafPlaylist(text, ORIGIN, source);
    expect(leaf.text).toContain('#EXT-X-TARGETDURATION:6');
    expect(leaf.text).toContain('#EXT-X-ENDLIST');
    expect(leaf.text).toContain('#EXTINF:6.0,');
  });

  it('空清单不炸，且不产生分片', () => {
    const leaf = rewriteLeafPlaylist('#EXTM3U\n', ORIGIN, source);
    expect(leaf.segments).toEqual([]);
  });
});

describe('rewriteChildPlaylist', () => {
  it('子清单地址指向本地代理，但不带 pid/sid', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
      '720p/index.m3u8',
    ].join('\n');

    const out = rewriteChildPlaylist(text, ORIGIN, 'https://cdn.example/master.m3u8');

    expect(out).toContain(
      `${ORIGIN}/${encodeTarget('https://cdn.example/720p/index.m3u8')}.m3u8`,
    );
    expect(out).not.toContain('pid=');
    expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720');
  });
});

describe('SegmentCache', () => {
  /** 缓存里存的是 base64 文本，size 是解码后的字节数 */
  const put = (cache: SegmentCache, key: string, byteCount: number) =>
    cache.set(key, 'A'.repeat(Math.ceil(byteCount / 3) * 4), byteCount);

  it('超过上限时按最久未使用淘汰', () => {
    const cache = new SegmentCache(10);
    put(cache, 'a', 4);
    put(cache, 'b', 4);
    expect(cache.sizeBytes).toBe(8);

    put(cache, 'c', 4);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.sizeBytes).toBeLessThanOrEqual(10);
  });

  it('get 会刷新 LRU 顺序', () => {
    const cache = new SegmentCache(10);
    put(cache, 'a', 4);
    put(cache, 'b', 4);
    cache.get('a'); // a 变最近使用
    put(cache, 'c', 4);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('单条超过上限也不会把刚写入的淘汰掉', () => {
    const cache = new SegmentCache(4);
    put(cache, 'big', 8);
    expect(cache.has('big')).toBe(true);
    expect(cache.count).toBe(1);
  });
});

describe('HTTP 解析', () => {
  const head = [
    'GET /YWJj?pid=p1&sid=3 HTTP/1.1',
    'Host: 127.0.0.1:18923',
    'Range: bytes=0-',
    'Connection: keep-alive',
    'User-Agent: ExoPlayer',
  ].join('\r\n');

  it('拆出方法、路径与 query', () => {
    const req = parseHead(head);
    expect(req).not.toBeNull();
    expect(req!.method).toBe('GET');
    expect(req!.pathname).toBe('/YWJj');
    expect(req!.search).toBe('pid=p1&sid=3');
  });

  it('readQuery 取值，取不到返回 null', () => {
    expect(readQuery('pid=p1&sid=3', 'sid')).toBe('3');
    expect(readQuery('pid=p1&sid=3', 'nope')).toBeNull();
    expect(readQuery('', 'pid')).toBeNull();
  });

  it('转发头里去掉 host / connection / range', () => {
    const headers = buildForwardHeaders(parseHead(head)!.headers);
    expect(headers.host).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers.range).toBeUndefined();
    expect(headers['user-agent']).toBe('ExoPlayer');
  });
});

describe('applyRange', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const bodyOf = (result: ProxyResult) => Array.from(Buffer.from(result.bodyBase64, 'base64'));
  const make = (): ProxyResult =>
    bytesResult(200, Buffer.from(bytes).toString('base64'), 'video/mp2t');

  it('bytes=a-b', () => {
    const r = applyRange(make(), 'bytes=2-5');
    expect(r.status).toBe(206);
    expect(bodyOf(r)).toEqual([3, 4, 5, 6]);
    expect(r.bodyLength).toBe(4);
    expect(r.extraHeaders!['Content-Range']).toBe('bytes 2-5/10');
  });

  it('bytes=a- 到结尾', () => {
    const r = applyRange(make(), 'bytes=7-');
    expect(bodyOf(r)).toEqual([8, 9, 10]);
    expect(r.extraHeaders!['Content-Range']).toBe('bytes 7-9/10');
  });

  it('bytes=-n 取末尾 n 字节', () => {
    const r = applyRange(make(), 'bytes=-3');
    expect(bodyOf(r)).toEqual([8, 9, 10]);
  });

  it('bytes=0- 整段请求不做多余的切片', () => {
    const full = make();
    const r = applyRange(full, 'bytes=0-');
    expect(r.status).toBe(206);
    expect(r.bodyBase64).toBe(full.bodyBase64);
  });

  it('无 Range 或非法 Range 时原样返回', () => {
    expect(applyRange(make(), undefined).status).toBe(200);
    expect(applyRange(make(), 'bytes=abc').status).toBe(200);
    expect(applyRange(make(), 'bytes=99-').status).toBe(200);
  });
});

describe('缓存策略字段', () => {
  it('分片可被播放器缓存，清单不允许缓存', () => {
    expect(
      bytesResult(200, Buffer.from([1]).toString('base64'), 'video/mp2t', 'public, max-age=3600')
        .cacheControl,
    ).toBe('public, max-age=3600');
    expect(
      textResult(200, '#EXTM3U', 'application/vnd.apple.mpegurl', 'no-store').cacheControl,
    ).toBe('no-store');
  });

  it('applyRange 保留缓存策略字段', () => {
    const result: ProxyResult = bytesResult(
      200,
      Buffer.from([1, 2, 3]).toString('base64'),
      'video/mp2t',
      'public, max-age=3600',
    );
    expect(applyRange(result, 'bytes=1-2').cacheControl).toBe('public, max-age=3600');
  });
});

describe('planPrefetchWindow（唯一窗口）', () => {
  const noneCached = () => false;
  /** 窗口固定为 [currentSid+1, currentSid+PREFETCH_COUNT] */
  const PREFETCH = PREFETCH_COUNT;

  it('顺序播放：窗口内的在途下载全部保留，不重复发起', () => {
    const inWindow = Array.from({ length: PREFETCH }, (_, i) => 2 + i);
    const plan = planPrefetchWindow({
      currentSid: 1,
      totalSegments: 10,
      inFlightSids: inWindow,
      isCached: noneCached,
    });

    expect(plan.windowStart).toBe(2);
    expect(plan.windowEnd).toBe(1 + PREFETCH);
    expect(plan.toCancel).toEqual([]);
    expect(plan.toStart).toEqual([]);
  });

  it('跳转到 100：旧窗口全部取消，新窗口全部发起', () => {
    const plan = planPrefetchWindow({
      currentSid: 100,
      totalSegments: 200,
      inFlightSids: Array.from({ length: PREFETCH }, (_, i) => 2 + i),
      isCached: noneCached,
    });

    expect(plan.toCancel).toEqual(Array.from({ length: PREFETCH }, (_, i) => 2 + i));
    expect(plan.toStart).toEqual(Array.from({ length: PREFETCH }, (_, i) => 101 + i));
  });

  it('只有窗口外的被取消，窗口内缺的补上', () => {
    const plan = planPrefetchWindow({
      currentSid: 5,
      totalSegments: 20,
      inFlightSids: [3, 6],
      isCached: noneCached,
    });

    expect(plan.windowStart).toBe(6);
    expect(plan.windowEnd).toBe(5 + PREFETCH);
    expect(plan.toCancel).toEqual([3]);
    expect(plan.toStart).toEqual(Array.from({ length: PREFETCH - 1 }, (_, i) => 7 + i));
  });

  it('已缓存的不再发起', () => {
    const plan = planPrefetchWindow({
      currentSid: 0,
      totalSegments: 10,
      inFlightSids: [1],
      isCached: (sid) => sid === 2,
    });

    // 窗口 [1, PREFETCH]：1 在途、2 已缓存，其余补发
    expect(plan.toStart).toEqual(Array.from({ length: PREFETCH - 2 }, (_, i) => 3 + i));
  });

  it('播放到末尾：窗口为空，所有在途下载取消', () => {
    const plan = planPrefetchWindow({
      currentSid: 9,
      totalSegments: 10,
      inFlightSids: [1, 2],
      isCached: noneCached,
    });

    expect(plan.windowEnd).toBeLessThan(plan.windowStart);
    expect(plan.toCancel).toEqual([1, 2]);
    expect(plan.toStart).toEqual([]);
  });

  it('窗口长度始终不超过 PREFETCH 片', () => {
    const plan = planPrefetchWindow({
      currentSid: 0,
      totalSegments: 100,
      inFlightSids: [],
      isCached: noneCached,
    });
    expect(plan.toStart.length).toBe(PREFETCH);
  });
});
