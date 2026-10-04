/**
 * 本地预缓存代理 —— HTTP 服务、回源与预取调度
 *
 * 用 react-native-tcp-socket 在 127.0.0.1 上起一个极简 HTTP/1.1 服务：
 *   播放器 -> 本代理 -> 回源（直连，或已经过 m3u8Proxy 的远端中转）
 *
 * 与 Worker 方案的区别：代理跑在设备上，预取用的是设备自己的多条连接，
 * 因此能真正改善"客户端出口拥塞"这一段。
 */

import { Buffer } from 'buffer';
import TcpSocket from 'react-native-tcp-socket';
import Logger from '@/utils/Logger';
import { SegmentCache } from './cache';
import {
  PREFETCH_COUNT,
  decodeTarget,
  isHlsPlaylist,
  isLeafPlaylist,
  rewriteChildPlaylist,
  rewriteLeafPlaylist,
} from './playlist';
import { planPrefetchWindow } from './prefetchWindow';
import {
  applyRange,
  base64ByteLength,
  buildForwardHeaders,
  bytesResult,
  guessSegmentType,
  parseHead,
  readQuery,
  textResult,
  type FetchResult,
  type ParsedRequest,
  type ProxyResult,
} from './http';

const logger = Logger.withTag('VideoPrefetch');

/**
 * 分片内存缓存上限——只是兜底，正常不该触发：
 * 缓存实际按"当前分片 + 后面 PREFETCH_COUNT 片"裁剪（见 trimCacheToWindow），
 * 最多也就 6 片，就算单片 5MB 也只有 30MB。
 */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** 回源超时。超过这个时间还下不完一片，这个源基本也放不动了，直接换源 */
const FETCH_TIMEOUT_MS = 30000;
const PORT_ATTEMPTS = 5;
/** pid -> 分片列表 最多保留多少份 */
const MAX_PLAYLISTS = 50;
/**
 * 分片响应给播放器的缓存策略。分片内容不可变，允许 ExoPlayer 自己缓存，
 * 这样重看同一集时能命中它自己的磁盘缓存；playlist 一律 no-store，避免直播拿到旧清单。
 */
const SEGMENT_CACHE_CONTROL = 'public, max-age=3600';

type TcpSocketLike = {
  /** react-native-tcp-socket 内部的 socket id，直发原生写入时要用 */
  _id?: number;
  write(data: string | Uint8Array, encoding?: string, cb?: (err?: Error) => void): boolean;
  end(data?: string | Uint8Array): void;
  destroy(): void;
  setNoDelay(noDelay?: boolean): void;
  setKeepAlive(enable?: boolean): void;
  on(event: 'data', cb: (data: string | Uint8Array) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
};

type TcpServerLike = {
  close?: (cb?: (err?: Error) => void) => void;
  /** 监听成功后返回系统实际分配的端口（port 传 0 时用它取回真实端口） */
  address?: () => { port: number } | null;
};

const segmentCache = new SegmentCache(MAX_CACHE_BYTES);
/** pid -> 分片绝对地址列表（只登记"最终分片清单"） */
const playlists = new Map<string, string[]>();
/**
 * 播放器当前在用的最终分片清单 pid。
 * 换源后，旧源可能还有残留请求在跑，它超时不能被当成"当前源太慢"。
 */
let activePlaylistPid: string | null = null;
/** 在途的预取下载：分片地址 -> 归属、取消句柄与可复用的下载 Promise */
const inflight = new Map<
  string,
  { pid: string; sid: number; controller: AbortController; promise: Promise<FetchResult> }
>();
/** 正在为播放器拉取的那个分片（它自己不算预取，需要服务完这次请求） */
let servingFetch: { pid: string; sid: number; controller: AbortController } | null = null;

let server: TcpServerLike | null = null;
let localOrigin: string | null = null;

/** 代理运行中需要让界面知道的状况 */
export type ProxyEvent = { type: 'segment-timeout'; url: string };
type ProxyEventListener = (event: ProxyEvent) => void;
const proxyEventListeners = new Set<ProxyEventListener>();
/** 最近一次"当前分片回源超时"的时间戳 */
let lastSegmentTimeoutAt = 0;

/** 订阅代理事件，返回取消订阅函数 */
export function onProxyEvent(listener: ProxyEventListener): () => void {
  proxyEventListeners.add(listener);
  return () => {
    proxyEventListeners.delete(listener);
  };
}

function emitProxyEvent(event: ProxyEvent): void {
  if (event.type === 'segment-timeout') lastSegmentTimeoutAt = Date.now();
  for (const listener of [...proxyEventListeners]) {
    try {
      listener(event);
    } catch {
      // 监听方（界面）出错不应影响代理本身
    }
  }
}

/** 最近是否发生过"当前分片回源超时"（用于把失败原因写进界面提示） */
export function hasRecentSegmentTimeout(withinMs = 30000): boolean {
  return lastSegmentTimeoutAt > 0 && Date.now() - lastSegmentTimeoutAt <= withinMs;
}

// ------------------------------------------------------------------ 生命周期

export function getProxyOrigin(): string | null {
  return localOrigin;
}

/**
 * 启动本地代理（幂等）。
 *
 * 端口一律交给系统随机分配（bind 0），既不会和其它程序冲突，
 * 也不会出现"上一个实例的端口还没释放"的问题。
 * 万一当前环境拿不到系统分配的端口号，再退回 preferredPort 起的固定端口段兜底。
 */
export async function startProxyServer(preferredPort: number): Promise<string> {
  if (server && localOrigin) return localOrigin;

  const fallbackPorts = Array.from({ length: PORT_ATTEMPTS }, (_, i) => preferredPort + i);
  const candidates = [0, ...fallbackPorts]; // 0 = 让系统随机挑一个空闲端口

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const handle = await listenOn(candidate);
      // candidate 为 0 时必须从系统拿回真实端口，拿不到就换下一个候选
      const port = handle.address?.()?.port ?? (candidate || null);
      if (!port) {
        lastError = new Error(`监听 ${candidate} 成功但取不到端口号`);
        handle.close?.();
        continue;
      }
      server = handle;
      localOrigin = `http://127.0.0.1:${port}`;
      logger.info(
        `本地预缓存代理已启动 ${localOrigin}，预取 ${PREFETCH_COUNT} 片` +
          (candidate === 0 ? '（系统随机端口）' : `（随机端口不可用，退回 ${port}）`),
      );
      return localOrigin;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`本地预缓存代理启动失败: ${String(lastError)}`);
}

export async function stopProxyServer(): Promise<void> {
  const current = server;
  if (!current?.close) return;

  await new Promise<void>((resolve) => {
    current.close!(() => resolve());
  });

  server = null;
  localOrigin = null;
  segmentCache.clear();
  playlists.clear();
  activePlaylistPid = null;
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
  servingFetch?.controller.abort();
  servingFetch = null;
}

function listenOn(port: number): Promise<TcpServerLike> {
  return new Promise((resolve, reject) => {
    const created = TcpSocket.createServer((socket) => {
      onConnection(socket as unknown as TcpSocketLike);
    });

    const onError = (err: Error) => {
      created.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      created.removeListener('error', onError);
      resolve(created as unknown as TcpServerLike);
    };

    created.once('error', onError);
    created.once('listening', onListening);
    created.listen({ port, host: '127.0.0.1' });
  });
}

// ------------------------------------------------------------------ 连接处理

function onConnection(socket: TcpSocketLike): void {
  let buffer = '';
  // 同一连接上的请求必须串行处理，否则响应可能乱序写回、破坏 HTTP 协议
  let chain: Promise<void> = Promise.resolve();

  socket.setNoDelay(true);
  socket.setKeepAlive(true);

  socket.on('error', (err) => {
    logger.debug(`socket 错误: ${err.message}`);
    socket.destroy();
  });

  socket.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

    // 一个连接上可能连续来多个请求（keep-alive），逐个处理
    let split = buffer.indexOf('\r\n\r\n');
    while (split !== -1) {
      const head = buffer.slice(0, split);
      buffer = buffer.slice(split + 4);
      chain = chain.then(() => handleHead(socket, head));
      split = buffer.indexOf('\r\n\r\n');
    }
  });
}

async function handleHead(socket: TcpSocketLike, head: string): Promise<void> {
  const parsed = parseHead(head);
  if (!parsed) {
    writeResponse(socket, textResult(400, 'bad request'), false, false);
    return;
  }

  const headOnly = parsed.method === 'HEAD';
  const keepAlive = !/close/i.test(parsed.headers.connection ?? '');

  try {
    const result = await handleRequest(parsed);
    writeResponse(socket, applyRange(result, parsed.headers.range), headOnly, keepAlive);
  } catch (error) {
    // 回源被取消：可能是播放器跳转，也可能是我们自己的回源超时。
    // 这里必须回一个正经的 HTTP 响应——直接断开连接的话，播放器读到的是
    // "响应头还没来就 EOF"，会被当成致命错误，进而把整个源判为不可用。
    // 504 属于可重试错误，播放器会自己退避重试。
    if (isAbortError(error)) {
      try {
        writeResponse(
          socket,
          textResult(504, 'upstream timeout', 'text/plain', 'no-store'),
          headOnly,
          false,
        );
      } catch {
        socket.destroy();
      }
      return;
    }
    logger.warn(`请求处理失败: ${String(error)}`);
    writeResponse(socket, textResult(502, 'proxy error', 'text/plain', 'no-store'), headOnly, keepAlive);
  }
}

// ------------------------------------------------------------------ 请求处理

async function handleRequest(parsed: ParsedRequest): Promise<ProxyResult> {
  const token = parsed.pathname.replace(/^\//, '');
  if (!token) return textResult(404, 'not found');

  let target: string;
  try {
    target = decodeTarget(token);
  } catch {
    return textResult(400, 'bad target token');
  }
  if (!/^https?:\/\//i.test(target)) return textResult(400, 'bad target url');

  const pidRaw = readQuery(parsed.search, 'pid');
  const sidRaw = readQuery(parsed.search, 'sid');
  const sidParsed = sidRaw === null ? null : Number.parseInt(sidRaw, 10);
  const isSegment = pidRaw !== null && sidParsed !== null && Number.isFinite(sidParsed);
  const pid = isSegment ? (pidRaw as string) : '';
  const sid = isSegment ? (sidParsed as number) : -1;
  const forwardHeaders = buildForwardHeaders(parsed.headers);

  // ① 分片：先只做取消——窗口外的在途预取一律干掉。
  //    注意这里不发新的预取：当前片还在等回源，先让它独占带宽。
  if (isSegment) {
    cancelSupersededServing(pid, sid);
    cancelOutOfWindowPrefetch(pid, sid);
    trimCacheToWindow(pid, sid);

    const cached = segmentCache.get(target);
    if (cached) {
      // 命中缓存：播放器不用等网络，这时补发后面的预取最合适
      startPrefetchWindow(pid, sid, forwardHeaders);
      return bytesResult(200, cached, guessSegmentType(target), SEGMENT_CACHE_CONTROL);
    }

    // 播放器要的这一片正好在某条在途预取里：直接等那条下载，别取消重下。
    // 此时也不新起预取——让当前片先拿到带宽，等它下完再由下面补发。
    const pending = inflight.get(target);
    if (pending && pending.pid === pid) {
      servingFetch = { pid, sid, controller: pending.controller };
      try {
        await pending.promise;
      } catch (error) {
        // 被外部取消（跳转）：让上层按取消处理，不要再重下这一片
        if (pending.controller.signal.aborted) throw error;
      } finally {
        if (servingFetch?.controller === pending.controller) servingFetch = null;
      }

      const recovered = segmentCache.get(target);
      if (recovered) {
        startPrefetchWindow(pid, sid, forwardHeaders);
        return bytesResult(200, recovered, guessSegmentType(target), SEGMENT_CACHE_CONTROL);
      }
      // 预取没成功（非 200 或出错）：落到下面自己重新回源
    }
  }

  // ② 回源。当前分片自己这条请求要服务完，不参与"窗口外取消"。
  const serveController = new AbortController();
  if (isSegment) servingFetch = { pid, sid, controller: serveController };

  let fetched: FetchResult;
  try {
    fetched = await fetchUrl(target, forwardHeaders, isSegment ? serveController.signal : undefined);
  } catch (error) {
    // 回源超时（不是播放器跳转）：这是一种用户能感知的等待，需要让界面给出提示
    if (isAbortError(error) && isSegment && !serveController.signal.aborted) {
      // 只有"当前正在播的这份清单"超时才通知界面。
      // 换源后旧源残留的重试也会超时，不能让它把刚切过去的健康源误判成慢源。
      if (pid === activePlaylistPid) {
        logger.warn(`当前分片回源超时，已通知界面: ${target}`);
        emitProxyEvent({ type: 'segment-timeout', url: target });
      } else {
        logger.debug(`旧清单的分片超时，忽略（不换源）: ${target}`);
      }
      return textResult(504, 'upstream timeout', 'text/plain', 'no-store');
    }
    throw error;
  } finally {
    if (isSegment && servingFetch?.controller === serveController) servingFetch = null;
  }
  if (!fetched.ok) {
    return bytesResult(
      fetched.status,
      fetched.base64,
      fetched.contentType || 'text/plain',
    );
  }

  // 只有可能是清单时才解码成文本。分片绝不该在这里被整段 UTF-8 解码一遍
  const maybePlaylist =
    fetched.contentType.toLowerCase().includes('mpegurl') || /\.m3u8(\?|$)/i.test(target);

  if (maybePlaylist) {
    const text = Buffer.from(fetched.base64, 'base64').toString('utf8');
    if (isHlsPlaylist(text)) {
      const origin = localOrigin ?? '';

      // ③ 最终分片清单：改写 + 登记，之后的分片请求才会触发预取
      if (isLeafPlaylist(text)) {
        const leaf = rewriteLeafPlaylist(text, origin, target);
        rememberPlaylist(leaf.pid, leaf.segments);
        // 换成另一份清单（切源）了：旧源残留的下载都没人要了，全部取消，别继续占带宽
        if (activePlaylistPid !== leaf.pid) {
          cancelDownloadsOfOtherPlaylists(leaf.pid);
          activePlaylistPid = leaf.pid;
        }
        return textResult(200, leaf.text, 'application/vnd.apple.mpegurl', 'no-store');
      }

      // 子清单：只把子清单地址指向本地代理，不登记、不预取
      return textResult(
        200,
        rewriteChildPlaylist(text, origin, target),
        'application/vnd.apple.mpegurl',
        'no-store',
      );
    }
  }

  // ④ 分片：写缓存；当前片已经拿到，再补发后面的预取
  //    （放在这里是为了不和播放器正在等的这一片抢带宽）
  if (isSegment && fetched.status === 200) {
    segmentCache.set(target, fetched.base64, fetched.byteLength);
  }
  if (isSegment && fetched.ok) {
    startPrefetchWindow(pid, sid, forwardHeaders);
  }

  return bytesResult(
    fetched.status,
    fetched.base64,
    fetched.contentType || guessSegmentType(target),
    SEGMENT_CACHE_CONTROL,
  );
}

function rememberPlaylist(pid: string, segments: string[]): void {
  playlists.set(pid, segments);
  while (playlists.size > MAX_PLAYLISTS) {
    const oldest = playlists.keys().next().value;
    if (oldest === undefined) break;
    playlists.delete(oldest);
  }
}

function inFlightSidsOf(pid: string): number[] {
  const sids: number[] = [];
  for (const entry of inflight.values()) {
    if (entry.pid === pid) sids.push(entry.sid);
  }
  return sids;
}

/**
 * 切源时用：把不属于新清单的下载全部取消——包括在途预取和"正在为播放器拉的那一片"。
 * 旧源这些请求已经没人要了，留着只会继续占带宽、还会在超时时误报。
 */
function cancelDownloadsOfOtherPlaylists(keepPid: string): void {
  for (const [url, entry] of [...inflight]) {
    if (entry.pid === keepPid) continue;
    entry.controller.abort();
    inflight.delete(url);
  }
  if (servingFetch && servingFetch.pid !== keepPid) {
    servingFetch.controller.abort();
    servingFetch = null;
  }
}

/**
 * 按预取窗口裁剪缓存：只留"当前分片 + 后面 PREFETCH_COUNT 片"，其它全部清掉。
 * 这样缓存不需要按字节数限制——播过去的、以及换源前旧清单的分片都会被清空。
 */
function trimCacheToWindow(pid: string, currentSid: number): void {
  const segments = playlists.get(pid);
  if (!segments) return;

  const keep = new Set<string>();
  for (let sid = currentSid; sid <= currentSid + PREFETCH_COUNT && sid < segments.length; sid++) {
    keep.add(segments[sid]);
  }
  segmentCache.keepOnly(keep);
}

/**
 * 只做取消：把窗口（当前分片之后的 PREFETCH_COUNT 片）之外的在途预取干掉，不发新请求。
 * 播放器请求当前片时先走这一步，避免旧窗口的下载继续占着带宽。
 */
function cancelOutOfWindowPrefetch(pid: string, currentSid: number): void {
  const segments = playlists.get(pid);
  if (!segments) return;

  const plan = planPrefetchWindow({
    currentSid,
    totalSegments: segments.length,
    inFlightSids: inFlightSidsOf(pid),
    isCached: (segmentSid) => segmentCache.has(segments[segmentSid]),
  });
  if (plan.toCancel.length === 0) return;

  const cancelSet = new Set(plan.toCancel);
  for (const [url, entry] of [...inflight]) {
    // 正在被播放器等待的那一片不算预取，不能取消（要复用它的下载）
    if (entry.pid !== pid || entry.sid === currentSid || !cancelSet.has(entry.sid)) continue;
    entry.controller.abort();
    inflight.delete(url);
  }
}

/**
 * 补发窗口内缺的预取。只在"当前分片已经拿到"或"当前分片命中缓存"时调用，
 * 保证预取不会和播放器正在等的那一片抢带宽。
 */
function startPrefetchWindow(
  pid: string,
  currentSid: number,
  headers: Record<string, string>,
): void {
  const segments = playlists.get(pid);
  if (!segments) return;

  const plan = planPrefetchWindow({
    currentSid,
    totalSegments: segments.length,
    inFlightSids: inFlightSidsOf(pid),
    isCached: (segmentSid) => segmentCache.has(segments[segmentSid]),
  });

  for (const segmentSid of plan.toStart) {
    startPrefetch(pid, segmentSid, segments[segmentSid], headers);
  }
}

function startPrefetch(
  pid: string,
  sid: number,
  target: string,
  headers: Record<string, string>,
): void {
  const controller = new AbortController();
  const promise = fetchUrl(target, headers, controller.signal)
    .then((result) => {
      if (result.status === 200) {
        segmentCache.set(target, result.base64, result.byteLength);
      }
      return result;
    })
    .catch((error) => {
      if (!isAbortError(error)) logger.debug(`预取失败 ${target}: ${String(error)}`);
      throw error;
    })
    .finally(() => {
      const current = inflight.get(target);
      if (current?.controller === controller) inflight.delete(target);
    });

  inflight.set(target, { pid, sid, controller, promise });
  // 播放器可能不来取这一片，没人 await 时不要产生 unhandled rejection
  promise.catch(() => undefined);
}

/**
 * 播放器跳转时，上一个分片自己那条下载已经没人要了，一并取消。
 * 只有跨度超过预取窗口才算跳转，避免误伤正常顺序播放。
 */
function cancelSupersededServing(pid: string, sid: number): void {
  const current = servingFetch;
  if (!current || current.pid !== pid) return;
  if (Math.abs(sid - current.sid) <= PREFETCH_COUNT) return;

  current.controller.abort();
  servingFetch = null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// ------------------------------------------------------------------ 工具

async function fetchUrl(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort);
  }
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const contentType = response.headers.get('Content-Type') ?? '';
    const base64 = await readBodyAsBase64(response);
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      base64,
      byteLength: base64ByteLength(base64),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * 读取响应体并返回 base64。
 *
 * 优先走 Blob + FileReader：两者都在原生侧完成，JS 只拿到最终字符串，
 * 不像 arrayBuffer 那样把整段数据交给 JS 逐字节解码（实测 2MB 要 1.9 秒）。
 */
async function readBodyAsBase64(response: Response): Promise<string> {
  const blob = (await response.blob()) as Blob & {
    data?: unknown;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    close?: () => void;
  };

  try {
    // RN 的 Blob 带 data（原生持有的二进制），交给 FileReader 在原生侧转 base64
    if (blob.data !== undefined) {
      const viaFileReader = await readBlobAsBase64(blob);
      if (viaFileReader !== null) return viaFileReader;
    }
    // 其它环境（node/单测）走标准 Blob
    if (typeof blob.arrayBuffer === 'function') {
      return Buffer.from(await blob.arrayBuffer()).toString('base64');
    }
    return '';
  } finally {
    // 释放原生侧持有的 blob 内存
    blob.close?.();
  }
}

function readBlobAsBase64(blob: Blob): Promise<string | null> {
  if (typeof FileReader === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : null);
    };
    reader.onerror = () => resolve(null);
    try {
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

function writeResponse(
  socket: TcpSocketLike,
  result: ProxyResult,
  headOnly: boolean,
  keepAlive: boolean,
): void {
  const lines = [
    `HTTP/1.1 ${result.status} ${result.statusText}`,
    `Content-Type: ${result.contentType}`,
    `Content-Length: ${result.bodyLength}`,
    'Accept-Ranges: bytes',
    `Connection: ${keepAlive ? 'keep-alive' : 'close'}`,
    'Access-Control-Allow-Origin: *',
    `Cache-Control: ${result.cacheControl ?? 'no-store'}`,
  ];
  if (result.extraHeaders) {
    for (const key in result.extraHeaders) {
      lines.push(`${key}: ${result.extraHeaders[key]}`);
    }
  }

  socket.write(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
  if (!headOnly && result.bodyLength > 0) {
    writeBodyBase64(socket, result.bodyBase64);
  }
  if (!keepAlive) socket.end();
}

/**
 * 把 base64 响应体交给播放器。
 *
 * react-native-tcp-socket 的 socket.write(Uint8Array) 会在 JS 线程里把整段数据
 * 编码成 base64（实测 2MB 要 780ms），这正是界面卡顿的主因。
 * 原生模块本来就收 base64，所以这里直接调原生 write，跳过这层无谓的编码。
 */
function writeBodyBase64(socket: TcpSocketLike, base64: string): void {
  const native = getNativeTcpSockets();
  if (native && typeof socket._id === 'number') {
    native.write(socket._id, base64, nextRawWriteMsgId());
    return;
  }
  // 拿不到原生模块（例如单测环境）时退回库自带写法
  socket.write(Buffer.from(base64, 'base64'));
}

type NativeTcpSockets = { write: (id: number, base64: string, msgId: number) => void };

let nativeTcpSockets: NativeTcpSockets | null | undefined;
/** 直发用的 msgId：和库内部计数器错开，避免误触发它的 drain 逻辑 */
let rawWriteMsgId = 1000000000;

function nextRawWriteMsgId(): number {
  rawWriteMsgId = rawWriteMsgId >= 2000000000 ? 1000000000 : rawWriteMsgId + 1;
  return rawWriteMsgId;
}

function getNativeTcpSockets(): NativeTcpSockets | null {
  if (nativeTcpSockets !== undefined) return nativeTcpSockets;
  try {
    // 懒加载：单测（node 环境）下没有 react-native，拿不到就退回普通写法
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NativeModules } = require('react-native');
    nativeTcpSockets = (NativeModules?.TcpSockets as NativeTcpSockets) ?? null;
  } catch {
    nativeTcpSockets = null;
  }
  return nativeTcpSockets;
}

/** 仅供调试与单测使用 */
export const __internals = {
  segmentCache,
  playlists,
  inflight,
  cancelOutOfWindowPrefetch,
  startPrefetchWindow,
  cancelSupersededServing,
  rememberPlaylist,
};
