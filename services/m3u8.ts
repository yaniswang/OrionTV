import Logger from '@/utils/Logger';
import { useSettingsStore } from "@/stores/settingsStore";

const logger = Logger.withTag('M3U8');

interface CacheEntry {
  speed: number,
  timestamp: number;
}

const m3u8InfoCache: { [url: string]: CacheEntry } = {};
const CACHE_DURATION = 60 * 60 * 1000;

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
  logger.info(`M3U8检测开始 - url: ${url.substring(0, 100)}...`);
  

  if (!url.toLowerCase().endsWith(".m3u8")) {
    logger.info(`M3U8检测 跳过 - 非M3U8文件`);
    return null;
  }

  let timerId;
  try {
    let pingTime = 0, firstTsUrl = ''
    const fetchStart = performance.now();
    timerId = setTimeout(() => controller.abort(), 10000);
    const m3u8Url = new URL(url);
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
      const subM3u8Url = new URL(match[1], url);
      timerId = setTimeout(() => controller.abort(), 10000);
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

    const perfEnd = performance.now();
    logger.info(`M3U8检测结束 消耗:${(perfEnd - perfStart).toFixed(2)}ms`);
    
    return {
      pingTime,
      firstTsUrl,
      speed: 0,
    };
  } catch (error) {
    clearTimeout(timerId);
    const perfEnd = performance.now();
    logger.info(`M3U8检测失败 - 消耗:${(perfEnd - perfStart).toFixed(2)}ms, error: ${error}`);
    return null;
  }
};

export const getTsSpeed = async (
  url: string,
  firstTsUrl: string,
  signal: AbortSignal,
): Promise<{
  speed: number,
} | null> => {
  let timerId;
  try {
    // 清除代理,获取主机名
    const { m3u8Proxy } = useSettingsStore.getState();    
    let m3u8RealDomain = new URL(url.replace(m3u8Proxy, '')).host;

    // 检测缓存
    let cachedEntry = m3u8InfoCache[m3u8RealDomain];
    if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_DURATION) {
      logger.info(`M3U8检测缓存命中, speed: ${cachedEntry.speed} KB/s`);
      return cachedEntry;
    }

    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort());

    const downloadStart = performance.now();
    let allBytes = 0;
    const testUrl = new URL(firstTsUrl);
    logger.info(`开始M3U8测速: ${firstTsUrl}`);
    for(let i=0;i<5;i++) {
      // 重复多次,提升测试精度
      testUrl.searchParams.set('_t123789', Date.now().toString());
      timerId = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(testUrl.href, { signal: controller.signal });
      clearTimeout(timerId);
      if (!response.ok) {
        return null;
      }
      const buf = await response.arrayBuffer();
      allBytes += buf.byteLength;
      // 最长测速10秒
      if ((performance.now() - downloadStart) >= 10 * 1000){
        logger.info('测速10s超时');
        break;
      }
    }
    const downloadEnd = performance.now();
    const speed = Math.round(allBytes / (downloadEnd - downloadStart) * 1000 / 1024);

    cachedEntry = {
      speed,
      timestamp: Date.now(),
    };
    m3u8InfoCache[m3u8RealDomain] = cachedEntry;

    return cachedEntry;
  } catch (error) {
    if (timerId) clearTimeout(timerId);
    return null;
  }
}

export const clearM3u8Cache = () => {
  Object.keys(m3u8InfoCache).forEach(k => delete m3u8InfoCache[k]);
}