import Logger from '@/utils/Logger';

const logger = Logger.withTag('M3U8');

/** 分片探测：完整下载第一个分片，最多等 20 秒 */
const SEGMENT_PROBE_TIMEOUT_MS = 20000;

/** 探测结果缓存时长：同一地址在这个时间内不再重复测速（避免反复下分片） */
const PROBE_CACHE_DURATION = 30 * 60 * 1000;

export interface M3U8ProbeInfo {
  pingTime: number;
  segmentLoadMs: number | null;
  segmentDurationMs: number | null;
  segmentRatio: number;
  /** 分片经代理返回非 200（403/404/5xx 等）——这条路不可用，直接回退直连 */
  blocked?: boolean;
}

/**
 * 测速缓存：key 用"域名+端口"（host），同一台服务器（同一 CDN 的不同剧集）不重复测速。
 * 配了 m3u8Proxy 时地址前面被拼了代理前缀，取 host 前先把它剥掉。
 */
const probeCache: { [key: string]: { info: M3U8ProbeInfo; at: number } } = {};

/** 取清单里第一个分片：地址 + 清单里标注的这个分片时长（秒） */
function parseFirstSegment(playlist: string, base: string): { url: string; duration: number } | null {
  const lines = playlist.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXTINF:/.test(lines[i])) continue;
    const next = lines[i + 1]?.trim();
    if (!next || next.startsWith('#')) continue;
    const duration = Number.parseFloat(lines[i].slice('#EXTINF:'.length));
    try {
      return { url: new URL(next, base).href, duration: Number.isFinite(duration) ? duration : 0 };
    } catch {
      return null;
    }
  }
  return null;
}

export const getInfoFromM3U8 = async (
  url: string,
  signal: AbortSignal,
  proxyPrefix?: string,
): Promise<M3U8ProbeInfo | null> => {
  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort());

  const perfStart = performance.now();
  logger.info(`M3U8检测开始 - url: ${url.substring(0, 100)}...`);
  

  if (!url.toLowerCase().endsWith(".m3u8")) {
    logger.info(`M3U8检测 跳过 - 非M3U8文件`);
    return null;
  }

  let m3u8Url = new URL(url);
  // 同一 host（域名+端口）只测一次：不同剧集只要落在同一台服务器上就复用结果。
  // key 里带上路径标识（direct/proxy），否则"先测代理再测直连"会互相命中对方的缓存。
  const realUrl = proxyPrefix && url.startsWith(proxyPrefix) ? url.slice(proxyPrefix.length) : url;
  const route = proxyPrefix ? 'proxy' : 'direct';
  let cacheKey: string;
  try {
    cacheKey = `${route}:${new URL(realUrl).host}`;
  } catch {
    cacheKey = `${route}:${realUrl}`;
  }
  const cached = probeCache[cacheKey];
  if (cached && Date.now() - cached.at < PROBE_CACHE_DURATION) {
    logger.info(`命中测速缓存（${cacheKey}，${Math.round((Date.now() - cached.at) / 1000)}s 前测过）: 倍率 ${cached.info.segmentRatio}`);
    return cached.info;
  }

  let timerId;
  try {
    let pingTime = 0;
    const fetchStart = performance.now();
    timerId = setTimeout(() => controller.abort(), 10000);
    m3u8Url.searchParams.set('_t123789', Date.now().toString());
    let response = await fetch(m3u8Url.href, { signal: controller.signal });
    clearTimeout(timerId);
    
    const fetchEnd = performance.now();
    pingTime = Math.round(fetchEnd - fetchStart);
    logger.info(`M3U8检测ping结束, pingTime: ${pingTime}ms`);
    
    if (!response.ok) {
      return null;
    }
    
    let playlist = await response.text();
    let match = playlist.match(/#EXT-X-STREAM-INF:PROGRAM-ID=\d[^\n]+\n([^\n]+)/)
    if(match) {
      // 需要进一步解析子文件
      m3u8Url = new URL(match[1], url);
      timerId = setTimeout(() => controller.abort(), 10000);
      response = await fetch(m3u8Url.href, { signal: controller.signal });
      clearTimeout(timerId);
      if (!response.ok) {
        return null;
      }
      playlist = await response.text();
    }

    // 分片探测：完整下载第一个分片
    const firstSegment = parseFirstSegment(playlist, m3u8Url.href);
    let segmentLoadMs: number | null = null;
    let segmentDurationMs: number | null = null;
    let segmentRatio = 0;
    let blocked = false;
    if (firstSegment) {
      // 完整下载第一个分片，再和清单里标注的分片时长比较：
      // 加载耗时比分片时长短（倍数 > 1）说明"下载比播放快"，这个源能流畅播放；
      // 倍数 <= 1 说明它连实时播放都跟不上。加载耗时也算进检测总耗时，慢源自然排后面。
      const loadStart = performance.now();
      const probeController = new AbortController();
      const probeTimer = setTimeout(() => probeController.abort(), SEGMENT_PROBE_TIMEOUT_MS);
      try {
        // 加时间戳绕过 CDN 缓存，否则测到的是缓存命中速度（快得离谱、不代表真实回源速度）
        const probeUrl = new URL(firstSegment.url);
        probeUrl.searchParams.set('_t123789', Date.now().toString());
        const probeResponse = await fetch(probeUrl.href, { signal: probeController.signal });
        if (probeResponse.status !== 200) {
          // 源站没给 200（403 防盗链、404、5xx 等）：这条路不可用，回退直连
          blocked = true;
          logger.info(`分片返回 ${probeResponse.status}（非 200），判定该路由不可用`);
        } else {
          const chunk = await probeResponse.arrayBuffer();
          segmentLoadMs = Math.round(performance.now() - loadStart);
          segmentDurationMs = Math.round(firstSegment.duration * 1000);
          segmentRatio =
            segmentDurationMs > 0 && segmentLoadMs > 0
              ? Number((segmentDurationMs / segmentLoadMs).toFixed(2))
              : 0;
          logger.info(
            `分片完整加载: ${(chunk.byteLength / 1024).toFixed(0)}KB / ${segmentLoadMs}ms` +
              `（该片时长 ${firstSegment.duration}s，倍数 ${segmentRatio}）`,
          );
        }
      } catch (error) {
        logger.info(`分片加载失败或超时（按慢源处理，耗时 ${Math.round(performance.now() - loadStart)}ms）: ${String(error)}`);
      } finally {
        clearTimeout(probeTimer);
      }
    }

    const perfEnd = performance.now();
    logger.info(`M3U8检测结束 消耗:${(perfEnd - perfStart).toFixed(2)}ms`);

    const info: M3U8ProbeInfo = {
      pingTime,
      segmentLoadMs,
      segmentDurationMs,
      segmentRatio,
      blocked,
    };
    // 只缓存成功的探测结果，失败的下次还会再试
    probeCache[cacheKey] = { info, at: Date.now() };
    return info;
  } catch (error) {
    clearTimeout(timerId);
    const perfEnd = performance.now();
    logger.info(`M3U8检测失败 - 消耗:${(perfEnd - perfStart).toFixed(2)}ms, error: ${error}`);
    return null;
  }
};
