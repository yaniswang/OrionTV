import { classifyPlaylist, firstVariantUrl, resolveUrl, probeCatchupUrl, playlistDurationSec, PROBE_SECONDS } from '../catchupProbe';

/** n 个 seg 秒的片段 */
const segs = (n: number, seg: number) => `#EXTINF:${seg.toFixed(3)},\nx.ts\n`.repeat(n);
const VOD_198 = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${segs(33, 6)}#EXT-X-ENDLIST\n`;
const LIVE = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4,\ns1.ts\n#EXTINF:4,\ns2.ts\n';
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2084544\n01.m3u8?a=1&b=2\n';

describe('classifyPlaylist', () => {
  it('区分点播、直播、主列表、非 m3u8', () => {
    expect(classifyPlaylist(VOD_198)).toBe('vod');
    expect(classifyPlaylist(LIVE)).toBe('live');
    expect(classifyPlaylist(MASTER)).toBe('master');
    expect(classifyPlaylist('624878405 节目播出调整，换个内容看看吧！')).toBe('invalid');
    expect(classifyPlaylist('  \n' + VOD_198)).toBe('vod');
  });

  it('声明了 PLAYLIST-TYPE（VOD / EVENT）的也算点播', () => {
    expect(classifyPlaylist(`#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n${segs(3, 6)}`)).toBe('vod');
  });
});

describe('resolveUrl / firstVariantUrl / playlistDurationSec', () => {
  it('相对路径、根路径、完整地址', () => {
    expect(resolveUrl('01.m3u8?x=1', 'http://h:8080/a/b/index.m3u8?t=9')).toBe('http://h:8080/a/b/01.m3u8?x=1');
    expect(resolveUrl('/c/01.m3u8', 'http://h:8080/a/b/index.m3u8')).toBe('http://h:8080/c/01.m3u8');
    expect(resolveUrl('https://x/y.m3u8', 'http://h/a/index.m3u8')).toBe('https://x/y.m3u8');
  });

  it('取主列表里第一个子列表', () => {
    expect(firstVariantUrl(MASTER, 'http://h/migu/index.m3u8?k=1')).toBe('http://h/migu/01.m3u8?a=1&b=2');
    expect(firstVariantUrl(VOD_198, 'http://h/x.m3u8')).toBeNull();
  });

  it('片段时长求和', () => {
    expect(playlistDurationSec(VOD_198)).toBe(198);
  });
});

describe('probeCatchupUrl：按请求的特殊时长核对', () => {
  const respond = (body: string, url = '', ok = true) =>
    Promise.resolve({ ok, url, text: () => Promise.resolve(body) } as unknown as Response);

  it('检测时长是不易碰巧对上的非整数分钟', () => {
    expect(PROBE_SECONDS % 60).not.toBe(0);
  });

  it('点播且时长与请求相差不超过一个片段（实测咪咕 197→198 / 197→190）→ 支持', async () => {
    expect(await probeCatchupUrl('u', {}, () => respond(VOD_198), 197)).toBe('ok');
    const vod190 = `#EXTM3U\n#EXT-X-TARGETDURATION:10\n${segs(19, 10)}#EXT-X-ENDLIST\n`;
    expect(await probeCatchupUrl('u', {}, () => respond(vod190), 197)).toBe('ok');
  });

  it('主列表 → 跟进子列表（按跳转后的地址解析相对路径）', async () => {
    const calls: string[] = [];
    const fetchImpl = (u: string) => {
      calls.push(u);
      return calls.length === 1 ? respond(MASTER, 'http://cdn/migu/index.m3u8?k=1') : respond(VOD_198);
    };
    expect(await probeCatchupUrl('http://s/c?b=1', {}, fetchImpl, 197)).toBe('ok');
    expect(calls[1]).toBe('http://cdn/migu/01.m3u8?a=1&b=2');
  });

  it('点播但时长对不上（忽略参数返回的循环视频、推流断开带 ENDLIST 的直播）→ 不支持', async () => {
    const loop = `#EXTM3U\n#EXT-X-TARGETDURATION:10\n${segs(360, 10)}#EXT-X-ENDLIST\n`;
    expect(await probeCatchupUrl('u', {}, () => respond(loop), 197)).toBe('unsupported');
    const endedLive = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-DISCONTINUITY\n${segs(20, 2)}#EXT-X-ENDLIST\n`;
    expect(await probeCatchupUrl('u', {}, () => respond(endedLive), 197)).toBe('unsupported');
  });

  it('滚动的直播列表（服务器忽略了回看参数）→ 不支持', async () => {
    expect(await probeCatchupUrl('u', {}, () => respond(LIVE), 197)).toBe('unsupported');
  });

  it('非 m3u8（版权屏蔽、服务端防探测提示）、HTTP 失败、网络异常 → 判断不了（不缓存）', async () => {
    expect(await probeCatchupUrl('u', {}, () => respond('咪咕视频：短时间内连续请求了 6 个不同频道'), 197)).toBeNull();
    expect(await probeCatchupUrl('u', {}, () => respond(VOD_198, '', false), 197)).toBeNull();
    expect(await probeCatchupUrl('u', {}, () => Promise.reject(new Error('net')), 197)).toBeNull();
  });
});
