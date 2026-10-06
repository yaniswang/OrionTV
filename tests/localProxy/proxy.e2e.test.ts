/**
 * 本地预缓存代理 —— 预取窗口行为（端到端）
 *
 * 起一个本地假源站，只验证代理的调度行为，不依赖任何外网：
 *   1. 当前分片没拿到之前，不发起后面的预取（不和播放器抢带宽）；
 *   2. 跳转时窗口外的在途下载被取消，新窗口在跳转片到手后补发；
 *   3. 当前片不读取已完成缓存，但会复用正在预取的同一分片，不取消重下。
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
import { encodeTarget, PREFETCH_COUNT } from '@/services/localProxy/playlist';
import { startProxyServer, stopProxyServer } from '@/services/localProxy/proxy';

const SEG_REST = 150;
const FAST_MS = 50;
const SLOW_MS = 3000;
const HEADERS = { 'user-agent': 'ExoPlayerLib/2.19.1', accept: '*/*' };

jest.setTimeout(60 * 1000);

interface SegState {
  started: boolean;
  aborted: boolean;
  completed: boolean;
  /** 源站一共收到过几次请求（用于验证"不重复下载"） */
  requests: number;
}

const segs = new Map<number, SegState>();
/** 假源站地址，端口由系统分配 */
let ORIGIN = '';

function state(sid: number): SegState {
  let s = segs.get(sid);
  if (!s) {
    s = { started: false, aborted: false, completed: false, requests: 0 };
    segs.set(sid, s);
  }
  return s;
}

function leafPlaylist(): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6'];
  for (let i = 0; i <= SEG_REST; i++) {
    lines.push('#EXTINF:6.0,', `seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function startOrigin(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/index.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(leafPlaylist());
      return;
    }

    const match = path.match(/^\/seg(\d+)\.ts$/);
    if (!match) {
      res.writeHead(404).end();
      return;
    }

    const sid = Number.parseInt(match[1], 10);
    const s = state(sid);
    s.started = true;
    s.requests += 1;
    // 只有第 0 片快（先拿到播放位置），其余都慢，保证跳转时它们仍在途
    const delay = sid === 0 ? FAST_MS : SLOW_MS;
    let requestAborted = false;

    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.write(`#sid=${sid}\n`);

    const timer = setTimeout(() => {
      if (requestAborted) return;
      s.completed = true;
      res.end(`payload-${sid}`);
    }, delay);

    const onGone = () => {
      clearTimeout(timer);
      if (s.completed) return; // 正常结束的 'close' 不算取消
      requestAborted = true;
      s.aborted = true;
    };
    res.on('close', onGone);
    req.on('aborted', onGone);
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      ORIGIN = `http://127.0.0.1:${port}`;
      resolve(server);
    }),
  );
}

function segUrl(playlistText: string, sid: number): string {
  const line = playlistText
    .split('\n')
    .find((l) => l.includes(`sid=${sid}`) && l.startsWith('http'));
  if (!line) throw new Error(`找不到 sid=${sid} 的分片地址`);
  return line.trim();
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  return res.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('预取窗口（端到端）', () => {
  let originServer: http.Server;

  beforeAll(async () => {
    originServer = await startOrigin();
  });

  afterAll(async () => {
    await stopProxyServer();
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  });

  it('跳转后窗口外的在途下载被取消，新窗口等当前片下完再补发', async () => {
    const proxy = await startProxyServer(19100);

    // ① 拉最终分片清单，登记 pid，之后分片请求才会触发预取
    const playlistText = await getText(`${proxy}/${encodeTarget(`${ORIGIN}/index.m3u8`)}`);

    // ② 播放第 0 片：拿到之后才为窗口 1~N 发起预取
    await getText(segUrl(playlistText, 0));
    await sleep(300);

    const startedAfterPlay = [...segs.keys()].sort((a, b) => a - b);
    console.log(`播放第 0 片后，源站已收到请求的分片: [${startedAfterPlay.join(', ')}]`);

    // ③ 跳到第 100 片：旧窗口应被取消；当前片 100 在途期间不做任何预取
    fetch(segUrl(playlistText, 100), { headers: HEADERS }).catch(() => undefined);
    await sleep(1000);

    const describe = (s: SegState) =>
      s.aborted ? '已取消' : s.completed ? '已完成' : s.started ? '在途' : '未请求';
    const dump = (title: string) => {
      console.log(`${title}:`);
      for (const [sid, s] of [...segs.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`  seg${sid}: ${describe(s)}`);
      }
    };
    const inFlightNow = () =>
      [...segs.entries()]
        .filter(([, s]) => s.started && !s.aborted && !s.completed)
        .map(([sid]) => sid)
        .sort((a, b) => a - b);
    const cancelledNow = () =>
      [...segs.entries()].filter(([, s]) => s.aborted).map(([sid]) => sid);

    dump('跳转后 1 秒');

    // 旧窗口必须被取消
    const firstWindow = Array.from({ length: PREFETCH_COUNT }, (_, i) => 1 + i);
    expect(cancelledNow()).toEqual(expect.arrayContaining(firstWindow));
    // 跳转前不应有窗口外的下载被发起
    expect(startedAfterPlay.filter((sid) => sid > PREFETCH_COUNT && sid < 100)).toEqual([]);
    // 当前片 100 没下完之前，不发起后面的预取（不和当前片抢带宽）
    expect(inFlightNow()).toEqual([100]);
    expect(segs.get(101)).toBeUndefined();

    // 等 100 下完之后，才补发新窗口
    await sleep(2500);
    dump('跳转后 3.5 秒');
    expect(state(100).completed).toBe(true);
    expect(inFlightNow()).toEqual(Array.from({ length: PREFETCH_COUNT }, (_, i) => 101 + i));
  });

  it('当前片在途预取时复用下载，不取消重下', async () => {
    // 从干净状态开始，避免上一个用例留下的缓存/在途干扰
    await stopProxyServer();
    segs.clear();
    const proxy = await startProxyServer(19100);
    const playlistText = await getText(`${proxy}/${encodeTarget(`${ORIGIN}/index.m3u8`)}`);

    // 播放第 0 片（快）→ 触发后面几片的预取（慢，3 秒）
    await getText(segUrl(playlistText, 0));
    await sleep(300);

    expect(state(1).started).toBe(true);
    expect(state(1).requests).toBe(1);

    // 播放器接着要第 1 片：复用正在进行的预取，不取消、不重下
    const body = await getText(segUrl(playlistText, 1));
    expect(body.length).toBeGreaterThan(0);
    expect(state(1).requests).toBe(1); // 仍然只有正在预取的那一条请求
    expect(state(1).aborted).toBe(false); // 没有被取消
    expect(state(1).completed).toBe(true);
  });

  it('当前片已完成预取时直接返回缓存，不重新回源', async () => {
    await stopProxyServer();
    segs.clear();
    const proxy = await startProxyServer(19100);
    const playlistText = await getText(`${proxy}/${encodeTarget(`${ORIGIN}/index.m3u8`)}`);

    await getText(segUrl(playlistText, 0));
    await sleep(SLOW_MS + 400);

    expect(state(1).completed).toBe(true);
    expect(state(1).requests).toBe(1);

    const body = await getText(segUrl(playlistText, 1));
    expect(body.length).toBeGreaterThan(0);
    expect(state(1).requests).toBe(1); // 命中已完成缓存，不再回源
  });
});
