/**
 * 本地预缓存代理 —— 清单改写（端到端）
 *
 * 用本地假源站构造一份"贴近真实"的多级清单，验证改写规则：
 *   1. 清单类代理地址必须以 .m3u8 结尾（播放器据此判定 HLS，否则按普通文件解析而失败）；
 *   2. 改写后不能残留任何相对地址（否则播放器会拿代理地址当基准去拼）；
 *   3. #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-KEY 的 URI 都要指向代理，并且真的取得到。
 *
 * 这些都是之前线上踩过的坑，所以固化成回归用例。
 *
 * @jest-environment node
 */

jest.mock('react-native-tcp-socket', () => {
  const net = require('net');
  return {
    __esModule: true,
    default: {
      createServer: (listener: any) => net.createServer(listener),
    },
  };
});

import * as http from 'http';
import { encodeTarget } from '@/services/localProxy/playlist';
import { startProxyServer, stopProxyServer } from '@/services/localProxy/proxy';

const HEADERS = { 'user-agent': 'ExoPlayerLib/2.19.1', accept: '*/*' };

jest.setTimeout(60 * 1000);

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="音频",URI="audio/audio.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO="aac"',
  'sub/leaf.m3u8',
].join('\n');

const LEAF = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-KEY:METHOD=AES-128,URI="../key/enc.key"',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:6.0,',
  'seg0.ts',
  '#EXTINF:6.0,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
].join('\n');

function startOrigin(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const playlists: Record<string, string> = {
      '/master.m3u8': MASTER,
      '/sub/leaf.m3u8': LEAF,
      '/audio/audio.m3u8': [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.0,',
        'a0.ts',
      ].join('\n'),
    };

    if (playlists[path]) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(playlists[path]);
      return;
    }

    // key / init / 分片：返回一点字节即可
    if (/^\/(sub|audio)\/[A-Za-z0-9_.-]+$/.test(path) || path === '/key/enc.key') {
      const body = Buffer.alloc(2048, 7);
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(body);
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    }),
  );
}

async function fetchOk(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers: HEADERS });
  return { status: res.status, text: await res.text() };
}

/** 非注释、非空的行（HLS 里的裸地址行） */
function uriLines(playlist: string): string[] {
  return playlist
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function uriAttrs(playlist: string): string[] {
  const out: string[] = [];
  for (const match of playlist.matchAll(/URI="([^"]+)"/g)) out.push(match[1]);
  return out;
}

describe('清单改写（端到端）', () => {
  let originServer: http.Server;
  let ORIGIN = '';

  beforeAll(async () => {
    const started = await startOrigin();
    originServer = started.server;
    ORIGIN = started.origin;
  });

  afterAll(async () => {
    await stopProxyServer();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('多级清单改写后没有相对地址，且清单地址带 .m3u8 后缀', async () => {
    const proxy = await startProxyServer(19200);

    // 入口：清单类代理地址必须带 .m3u8，否则播放器会按普通文件解析
    const entry = `${proxy}/${encodeTarget(`${ORIGIN}/master.m3u8`)}.m3u8`;
    expect(entry.endsWith('.m3u8')).toBe(true);

    const master = await fetchOk(entry);
    expect(master.status).toBe(200);
    console.log(`改写后的 master:\n${master.text}`);

    // 不残留相对地址；所有 URI 属性都指向代理
    expect(uriLines(master.text).filter((l) => !l.startsWith(proxy))).toEqual([]);
    expect(uriAttrs(master.text).length).toBeGreaterThan(0);
    for (const uri of uriAttrs(master.text)) expect(uri.startsWith(proxy)).toBe(true);

    // 音频子清单（#EXT-X-MEDIA 的 URI）要能通过代理取到
    const audioUrl = uriAttrs(master.text)[0];
    expect(audioUrl.endsWith('.m3u8')).toBe(true);
    const audio = await fetchOk(audioUrl);
    expect(audio.status).toBe(200);
    expect(audio.text).toContain('#EXTINF:');

    // 视频子清单
    const childUrl = uriLines(master.text)[0];
    expect(childUrl.endsWith('.m3u8')).toBe(true);
    const leaf = await fetchOk(childUrl);
    expect(leaf.status).toBe(200);
    console.log(`改写后的叶子清单:\n${leaf.text}`);

    expect(uriLines(leaf.text).filter((l) => !l.startsWith(proxy))).toEqual([]);
    // #EXT-X-KEY / #EXT-X-MAP 的 URI 也要改写到代理上（相对路径否则会拼错）
    expect(leaf.text).toContain(`#EXT-X-KEY:METHOD=AES-128,URI="${proxy}/`);
    expect(leaf.text).toContain(`#EXT-X-MAP:URI="${proxy}/`);

    // 改写后的 init 段（EXT-X-MAP）必须真的取得到
    const mapLine = leaf.text.split('\n').find((l) => l.startsWith('#EXT-X-MAP:'));
    expect(mapLine).toBeDefined();
    const mapUri = mapLine!.match(/URI="([^"]+)"/)?.[1];
    expect(mapUri).toBeDefined();
    const init = await fetchOk(mapUri!);
    expect(init.status).toBe(200);

    // 分片带 pid/sid，能取到内容
    const segLine = uriLines(leaf.text).find((l) => l.includes('sid='));
    expect(segLine).toBeDefined();
    const seg = await fetchOk(segLine!);
    expect(seg.status).toBe(200);
    expect(seg.text.length).toBeGreaterThan(0);
  });
});
