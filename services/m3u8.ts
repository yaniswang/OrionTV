import Logger from '@/utils/Logger';

const logger = Logger.withTag('M3U8');

interface CacheEntry {
  pingTime: number,
  firstTsUrl: string,
  speed: number,
  timestamp: number;
}

const m3u8InfoCache: { [url: string]: CacheEntry } = {};
const CACHE_DURATION = 10 * 60 * 1000;

export const getInfoFromM3U8 = async (
  url: string,
  signal: AbortSignal,
): Promise<{
  pingTime: number,
  firstTsUrl: string,
  speed: number,
} | null> => {
  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort());

  const perfStart = performance.now();
  logger.info(`[PERF] M3U8 resolution detection START - url: ${url.substring(0, 100)}...`);
  
  // 1. Check cache first
  const cachedEntry = m3u8InfoCache[url];
  if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_DURATION) {
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection CACHED - took ${(perfEnd - perfStart).toFixed(2)}ms, pingTime: ${cachedEntry.pingTime}`);
    return cachedEntry;
  }

  if (!url.toLowerCase().endsWith(".m3u8")) {
    logger.info(`[PERF] M3U8 resolution detection SKIPPED - not M3U8 file`);
    return null;
  }

  let timerId;
  try {
    let pingTime = 0, firstTsUrl = ''
    const fetchStart = performance.now();
    timerId = setTimeout(() => controller.abort(), 5000);
    let m3u8Url = new URL(url);
    m3u8Url.searchParams.set('_t123789', Date.now().toString());
    let response = await fetch(m3u8Url.href, { signal: controller.signal });
    clearTimeout(timerId);
    
    const fetchEnd = performance.now();
    pingTime = Math.round(fetchEnd - fetchStart);
    logger.info(`[PERF] M3U8 fetch took ${(pingTime).toFixed(2)}ms, status: ${response.status}`);
    
    if (!response.ok) {
      return null;
    }
    
    const parseStart = performance.now();
    let playlist = await response.text();
    let match = playlist.match(/#EXT-X-STREAM-INF:PROGRAM-ID=\d[^\n]+\n([^\n]+)/)
    if(match) {
      // 需要进一步解析子文件
      const subM3u8Url = new URL(match[1], url);
      timerId = setTimeout(() => controller.abort(), 5000);
      response = await fetch(subM3u8Url.href, { signal: controller.signal });
      clearTimeout(timerId);
      if (!response.ok) {
        return null;
      }
      playlist = await response.text();
    }
    
    match = playlist.match(/#EXTINF:[^,]+,\n([^\n]+)/);
    if (match) {
      firstTsUrl = new URL(match[1], url).href;
    }

    const parseEnd = performance.now();
    logger.info(`[PERF] M3U8 parsing took ${(parseEnd - parseStart).toFixed(2)}ms`);

    // 2. Store result in cache
    m3u8InfoCache[url] = {
      pingTime,
      firstTsUrl,
      speed: 0,
      timestamp: Date.now(),
    };

    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection COMPLETE - took ${(perfEnd - perfStart).toFixed(2)}ms, pingTime: ${pingTime}`);
    
    return {
      pingTime,
      firstTsUrl,
      speed: 0,
    };
  } catch (error) {
    clearTimeout(timerId);
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection ERROR - took ${(perfEnd - perfStart).toFixed(2)}ms, error: ${error}`);
    return null;
  }
};

export const getTsSpeed = async (
  url: string,
  signal?: AbortSignal,
): Promise<{
  speed: number,
} | null> => {
  try {
    const cachedEntry = m3u8InfoCache[url];
    const downloadStart = performance.now();
    let allBytes = 0;
    for(let i=0;i<3;i++) {
      // 重复测3次,提升测试精度
      const firstTsUrl = new URL(cachedEntry.firstTsUrl);
      firstTsUrl.searchParams.set('_t123789', Date.now().toString());
      const response = await fetch(firstTsUrl.href, { signal });
      if (!response.ok) {
        return null;
      }
      const buf = await response.arrayBuffer();
      allBytes += buf.byteLength;
    }
    const downloadEnd = performance.now();
    const speed = Math.round(allBytes / (downloadEnd - downloadStart) * 1000 / 1024);
    cachedEntry.speed = speed;
    return cachedEntry;
  } catch (error) {
    return null;
  }
}