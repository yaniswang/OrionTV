import Logger from '@/utils/Logger';

const logger = Logger.withTag('M3U8');

/**
 * PING 一次尝试的总预算（清单 + HEAD 共用同一个超时）：
 * 单源最坏只花这一个超时的钱，不会因为"清单超时 + HEAD 超时"叠成两倍。
 */
const PING_TIMEOUT_MS = 10000;
/**
 * 完整测速：单个分片的超时 = 该分片时长 × 2，等于把倍率下限卡在 0.5。
 * 分片时长就是"这片本该播多久"，等了两倍时间还没下完就是跟不上播放，再等也没意义。
 * 按最长分片 6 秒算，单个分片最多等 12 秒。
 */
const SEGMENT_TIMEOUT_FACTOR = 2;
/** 清单没标出分片时长（EXTINF 缺失）时的兜底超时：按最长分片 6s × 2 = 12s */
const SEGMENT_TIMEOUT_FALLBACK_MS = 12000;

/** 单片测速超时：分片时长 × 2；时长缺失时用 12s 兜底 */
const segmentProbeTimeoutMs = (durationSec: number) =>
  durationSec > 0 ? Math.round(durationSec * 1000 * SEGMENT_TIMEOUT_FACTOR) : SEGMENT_TIMEOUT_FALLBACK_MS;
/** 完整测速要完整下载的分片个数 */
const FULL_PROBE_SEGMENT_COUNT = 2;
/** 跳过 PING 直接测速时，加载清单的单个请求超时 */
const MANIFEST_TIMEOUT_MS = 10000;
/**
 * 清单只取前 1KB：实测 16 个源站里"前 2 个分片"最多占 459B，1KB 有 2 倍余量。
 * 服务器不支持 Range 时按原样返回全量，不会比现在更差。分片探测不走 Range。
 */
const MANIFEST_RANGE_HEADER: Record<string, string> = { Range: 'bytes=0-1023' };

/** 探测结果缓存时长：同一地址在这个时间内不再重复测速（避免反复下分片） */
const PROBE_CACHE_DURATION = 30 * 60 * 1000;

/**
 * 完整测速缓存开关。
 * PING 与完整测速是两个独立的缓存概念：PING 每次都是真实请求（清单 + HEAD，很轻），
 * 只按"域名"缓存完整测速结果（要真下 2 个分片，代价大）。
 * 命中缓存就跳过下载分片，倍率直接复用（PROBE_CACHE_DURATION 内有效）。
 */
export const SPEED_CACHE_ENABLED = true;

export interface M3U8Segment {
  url: string;
  /** 清单里标注的分片时长（秒） */
  duration: number;
}

export interface M3U8ProbeInfo {
  /** ping 耗时：清单加载 + 首个分片 HEAD，用于第一轮排序 */
  pingTime: number;
  /** 完整测速：前 2 个分片的总加载耗时 */
  segmentLoadMs: number | null;
  /** 完整测速：前 2 个分片在清单里标注的总时长 */
  segmentDurationMs: number | null;
  /** 分片时长 / 加载耗时，> 1 表示下载比播放快 */
  segmentRatio: number;
  /** 分片返回非 200（403/404/5xx 等）——这条路不可用，直接回退直连 */
  blocked?: boolean;
}

/** ping 结果：info 用于第一轮排序，segments 给本次完整测速用 */
export interface M3U8PingResult {
  info: M3U8ProbeInfo;
  segments: M3U8Segment[];
}

/**
 * 测速缓存：key 用"域名+端口"（host），同一台服务器（同一 CDN 的不同剧集）不重复测速。
 * 配了 m3u8Proxy 时地址前面被拼了代理前缀，取 host 前先把它剥掉。
 */
const probeCache: { [key: string]: { info: M3U8ProbeInfo; at: number } } = {};

function getCacheKey(url: string, proxyPrefix?: string): string {
  // key 里带上路由标识（direct/proxy），否则"先测代理再测直连"会互相命中对方的缓存
  const realUrl = proxyPrefix && url.startsWith(proxyPrefix) ? url.slice(proxyPrefix.length) : url;
  const route = proxyPrefix ? 'proxy' : 'direct';
  try {
    return `${route}:${new URL(realUrl).host}`;
  } catch {
    return `${route}:${realUrl}`;
  }
}

/** 取完整测速缓存：命中就不用再下分片；PING 不走这个缓存 */
export const getCachedSpeedTest = (url: string, proxyPrefix?: string): M3U8ProbeInfo | null => {
  if (!SPEED_CACHE_ENABLED) return null;
  const cacheKey = getCacheKey(url, proxyPrefix);
  const cached = probeCache[cacheKey];
  if (!cached || Date.now() - cached.at >= PROBE_CACHE_DURATION) return null;
  logger.info(`命中测速缓存（${cacheKey}，${Math.round((Date.now() - cached.at) / 1000)}s 前测过）: 倍率 ${cached.info.segmentRatio}`);
  return cached.info;
};

/** 清空完整测速缓存（按域名的缓存会跨页面留着，需要重新真实测速时用） */
export const clearSpeedTestCache = () => {
  for (const key of Object.keys(probeCache)) delete probeCache[key];
};

/** 拼时间戳绕开 CDN 缓存：测速必须拿到真实回源速度，命中缓存会快得离谱 */
function withCacheBuster(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.searchParams.set('_t123789', Date.now().toString());
  return parsed.href;
}

/** 日志用的短标识：清单地址的最后两段，够区分不同源（日志里要能把各步骤对上同一个源） */
export function urlTag(url: string): string {
  const parts = url.split('?')[0].split('/').filter(Boolean);
  return parts.slice(-2).join('/') || url.slice(0, 30);
}

/** 这些状态码说明这条路不可用；405/501 是服务端不支持 HEAD，不能当成源不可用 */
function isBlockedStatus(status: number): boolean {
  return !(status >= 200 && status < 300) && status !== 405 && status !== 501;
}

/**
 * 所有请求的统一出口：带超时、可被外部 signal 中断（页面跳转时取消在途请求）。
 * 超时时间覆盖到"读完 body"为止，否则慢源可以靠慢速 body 拖死测速。
 */
async function requestWithTimeout<T>(
  url: string,
  signal: AbortSignal,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) {
    controller.abort();
  }
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await read(response);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 只跟随传进来的 signal，不自己计时（超时由调用方统一控制） */
async function fetchFollowing<T>(
  url: string,
  signal: AbortSignal,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  return await read(response);
}

const readText = async (response: Response) => ({
  status: response.status,
  ok: response.ok,
  body: await response.text(),
});

const readBytes = async (response: Response) => ({
  status: response.status,
  ok: response.ok,
  byteLength: (await response.arrayBuffer()).byteLength,
});

const readHead = async (response: Response) => ({ status: response.status, ok: response.ok });

/** 取清单里前 count 个分片：地址 + 清单里标注的时长（秒） */
function parseSegments(playlist: string, base: string, count: number): M3U8Segment[] {
  const segments: M3U8Segment[] = [];
  const lines = playlist.split('\n');
  for (let i = 0; i < lines.length && segments.length < count; i++) {
    if (!/^#EXTINF:/.test(lines[i])) continue;
    const next = lines[i + 1]?.trim();
    if (!next || next.startsWith('#')) continue;
    const duration = Number.parseFloat(lines[i].slice('#EXTINF:'.length));
    try {
      segments.push({ url: new URL(next, base).href, duration: Number.isFinite(duration) ? duration : 0 });
    } catch {
      break;
    }
  }
  return segments;
}

type PlaylistTextFetcher = (
  url: string,
  withRange: boolean,
) => Promise<{ status: number; ok: boolean; body: string }>;

/** Range 截断的最后一行可能是不完整的地址，丢掉它 */
function trimIncompleteTail(body: string, withRange: boolean): string {
  if (!withRange || body.endsWith('\n') || body.indexOf('\n') < 0) return body;
  return body.slice(0, body.lastIndexOf('\n') + 1);
}

/**
 * 拉清单并解析出前 count 个分片。
 * 先只取前 1KB（Range 头）：截断导致分片不足、或源站不支持 Range 报 416 时，
 * 退回全量重拉一次；源站忽略 Range 直接返回 200 全量的话不会多花请求。
 */
async function loadSegments(
  fetchText: PlaylistTextFetcher,
  url: string,
  count: number,
): Promise<{ status: number; ok: boolean; segments: M3U8Segment[] }> {
  const attempt = async (withRange: boolean) => {
    const playlistUrl = withCacheBuster(url);
    const first = await fetchText(playlistUrl, withRange);
    if (!first.ok) return { status: first.status, ok: false, segments: [] };

    let playlist = trimIncompleteTail(first.body, withRange);
    let mediaPlaylistUrl = playlistUrl;

    const match = playlist.match(/#EXT-X-STREAM-INF:PROGRAM-ID=\d[^\n]+\n([^\n]+)/);
    if (match) {
      mediaPlaylistUrl = new URL(match[1], url).href;
      // 子清单也要带时间戳，否则这一跳会命中 CDN 缓存，测出来的是缓存速度
      const sub = await fetchText(withCacheBuster(mediaPlaylistUrl), withRange);
      if (!sub.ok) return { status: sub.status, ok: false, segments: [] };
      playlist = trimIncompleteTail(sub.body, withRange);
    }

    return { status: first.status, ok: true, segments: parseSegments(playlist, mediaPlaylistUrl, count) };
  };

  const ranged = await attempt(true);
  if (ranged.ok && ranged.segments.length >= count) return ranged;
  // 源站忽略 Range（200 全量）且能解析出分片：结果已经是完整的，不用再拉一次
  if (ranged.ok && ranged.status === 200 && ranged.segments.length > 0) return ranged;

  const full = await attempt(false);
  return full.ok ? full : ranged;
}

/**
 * PING：只加载 m3u8 清单 + 首个分片取 1KB，不做完整测速。
 * 清单只取前 1KB；首个分片用 Range 而不是 HEAD，让 ping 速度更接近真实源速度
 * （只测清单会漏掉"清单很快、分片 CDN 很慢"的源）。
 */
export const pingM3U8 = async (
  url: string,
  signal: AbortSignal,
  proxyPrefix?: string,
): Promise<M3U8PingResult | null> => {
  const perfStart = performance.now();

  if (!url.toLowerCase().endsWith('.m3u8')) {
    logger.info(`M3U8检测 跳过 - 非M3U8文件`);
    return null;
  }

  // 日志标识：源站短标识 + 走代理还是直连，方便把各步骤对上同一个源
  const tag = urlTag(url);
  const route = proxyPrefix ? '代理' : '直连';
  logger.info(`M3U8检测开始 [${tag}|${route}] - url: ${url.substring(0, 100)}...`);
  // 整次 ping（清单 + 首个分片）共用一个超时预算，单源最坏只花 PING_TIMEOUT_MS
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) {
    controller.abort();
  }
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    // 1) 清单：只取前 1KB（带时间戳，可被 signal 中断），解析出来的分片留在返回值里给测速复用
    const manifestStart = performance.now();
    const loaded = await loadSegments(
      (target, withRange) =>
        fetchFollowing(
          target,
          controller.signal,
          withRange ? { headers: MANIFEST_RANGE_HEADER } : {},
          readText,
        ),
      url,
      FULL_PROBE_SEGMENT_COUNT,
    );
    logger.info(
      `[PERF] ping清单 [${tag}|${route}] ${(performance.now() - manifestStart).toFixed(0)}ms status=${loaded.status} 分片数=${loaded.segments.length}`,
    );
    if (!loaded.ok) {
      return null;
    }
    const segments = loaded.segments;

    // 2) HEAD 首个分片：把分片 CDN 的响应耗时也算进 ping，ping 速度才接近真实播放速度
    let blocked = false;
    if (segments.length > 0) {
      try {
        const probeStart = performance.now();
        const head = await fetchFollowing(
          withCacheBuster(segments[0].url),
          controller.signal,
          { method: 'HEAD' },
          readHead,
        );
        logger.info(
          `[PERF] pingHEAD [${tag}|${route}] ${(performance.now() - probeStart).toFixed(0)}ms status=${head.status} url=${segments[0].url.substring(0, 80)}`,
        );
        blocked = isBlockedStatus(head.status);
        if (blocked) {
          logger.info(`[${tag}|${route}] 首个分片 HEAD 返回 ${head.status}（非 200），判定该路由不可用`);
        }
      } catch (error) {
        if (signal.aborted) return null;
        // HEAD 失败（超时/网络错误）不当成源不可用，交给完整测速判定
        logger.info(`[${tag}|${route}] 首个分片 HEAD 失败（按慢源处理）: ${String(error)}`);
      }
    }

    const pingTime = Math.round(performance.now() - perfStart);
    const info: M3U8ProbeInfo = {
      pingTime,
      segmentLoadMs: null,
      segmentDurationMs: null,
      segmentRatio: 0,
      blocked,
    };
    logger.info(`M3U8检测ping结束, pingTime: ${pingTime}ms, 分片数: ${segments.length}, blocked: ${blocked}`);
    return { info, segments };
  } catch (error) {
    if (signal.aborted) return null;
    const timedOut = controller.signal.aborted;
    logger.info(
      `M3U8检测失败${timedOut ? '（ping 超时）' : ''} - 消耗:${(performance.now() - perfStart).toFixed(2)}ms, error: ${error}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
};

/**
 * 只加载清单、不下载分片：master 清单自动跟进子清单，返回前 2 个分片。
 * 跳过 PING 的源（有推荐源时）用它现拉测速要下载的分片，等价于把 PING 省掉。
 */
export const resolveM3U8Segments = async (
  url: string,
  signal: AbortSignal,
): Promise<M3U8Segment[] | null> => {
  if (!url.toLowerCase().endsWith('.m3u8')) return null;
  try {
    const loaded = await loadSegments(
      (target, withRange) =>
        requestWithTimeout(
          target,
          signal,
          withRange ? { headers: MANIFEST_RANGE_HEADER } : {},
          MANIFEST_TIMEOUT_MS,
          readText,
        ),
      url,
      FULL_PROBE_SEGMENT_COUNT,
    );
    if (!loaded.ok) {
      logger.info(`清单加载失败 status=${loaded.status} url=${url.substring(0, 80)}`);
      return null;
    }
    return loaded.segments.length > 0 ? loaded.segments : null;
  } catch (error) {
    if (!signal.aborted) logger.info(`清单加载失败: ${String(error)}`);
    return null;
  }
};

/**
 * 完整测速：并发下载前 2 个分片（分片地址来自 ping 阶段，不再重复拉清单），
 * 再按"分片总时长 / 总加载耗时"算倍率。
 * 并发下载是为了贴近真实播放（播放器本身也是多连接并行预取），
 * 但调用方要保证同一时间只有一个源在测。
 */
export const measureM3U8Speed = async (
  url: string,
  segments: M3U8Segment[],
  signal: AbortSignal,
  baseInfo: M3U8ProbeInfo,
  proxyPrefix?: string,
): Promise<M3U8ProbeInfo> => {
  const loadSegment = async (segment: M3U8Segment) => {
    try {
      // 带时间戳绕缓存，否则测到的是缓存命中速度（快得离谱、不代表真实回源速度）
      const response = await requestWithTimeout(
        withCacheBuster(segment.url),
        signal,
        {},
        segmentProbeTimeoutMs(segment.duration),
        readBytes,
      );
      if (isBlockedStatus(response.status)) {
        logger.info(`分片返回 ${response.status}（非 200），判定该路由不可用`);
        return { ok: false, blocked: true, byteLength: 0, durationMs: 0 };
      }
      return {
        ok: true,
        blocked: false,
        byteLength: response.byteLength,
        durationMs: Math.round(segment.duration * 1000),
      };
    } catch (error) {
      if (!signal.aborted) {
        logger.info(`分片加载失败或超时（按失败处理）: ${String(error)}`);
      }
      return { ok: false, blocked: false, byteLength: 0, durationMs: 0 };
    }
  };

  const loadStart = performance.now();
  // 并发下载：总量 / 总耗时才反映"多个分片同时拉能不能跟上播放"
  const loadedSegments = await Promise.all(segments.map(loadSegment));
  const segmentLoadMs = Math.round(performance.now() - loadStart);

  let byteLength = 0;
  let segmentDurationMs = 0;
  let loadedCount = 0;
  let blocked = false;

  for (const item of loadedSegments) {
    blocked = blocked || item.blocked;
    if (!item.ok) continue;
    byteLength += item.byteLength;
    segmentDurationMs += item.durationMs;
    loadedCount++;
  }

  // 倍数 = 分片总时长 / 总加载耗时：> 1 说明下载比播放快，够流畅
  // 耗时不足 0.5ms 时会被四舍五入成 0，按 1ms 兜底：真·瞬间下完是最快的源，不该算出倍数 0
  const loadMsForRatio = Math.max(segmentLoadMs, 1);
  const segmentRatio =
    loadedCount > 0 && segmentDurationMs > 0
      ? Number((segmentDurationMs / loadMsForRatio).toFixed(2))
      : 0;

  logger.info(
    `分片完整测速: ${loadedCount}/${segments.length} 片 ${(byteLength / 1024).toFixed(0)}KB / ${segmentLoadMs}ms` +
      `（总时长 ${(segmentDurationMs / 1000).toFixed(1)}s，倍数 ${segmentRatio}）`,
  );

  const info: M3U8ProbeInfo = {
    ...baseInfo,
    segmentLoadMs: loadedCount > 0 ? segmentLoadMs : null,
    segmentDurationMs: segmentDurationMs > 0 ? segmentDurationMs : null,
    segmentRatio,
    // blocked 只由这次测速的分片结果决定，不能继承 PING 的结论：
    // 有些源站对 HEAD 返回 502（PING 判它 blocked），但 GET 分片其实是好的，
    // 继承下来的话这次成功的测速会被当成失败、永远写不进缓存，每次打开都要重测。
    blocked,
  };

  // 只缓存成功的完整测速结果，失败的下次还会再试
  if (SPEED_CACHE_ENABLED && !info.blocked && loadedCount > 0) {
    probeCache[getCacheKey(url, proxyPrefix)] = { info, at: Date.now() };
  }
  return info;
};
