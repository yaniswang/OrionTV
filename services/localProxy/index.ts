/**
 * 本地预缓存代理 —— 对外接口
 *
 * 播放时并行预缓存：把 HLS 播放入口包一层本机代理，
 * 代理在回源的同时，向后并发预取接下来的若干分片到内存缓存。
 *
 * 与 m3u8Proxy 的关系：m3u8Proxy 是"远端中转"，本模块是"本机预取"。
 * 拼接顺序是 m3u8Proxy 先、本地代理后，两者同时生效，互不影响。
 * 没有配置 m3u8Proxy 时，本地代理直接回源。
 */

import Logger from '@/utils/Logger';
import { buildProxyUrl } from './playlist';
import { getProxyOrigin, startProxyServer, stopProxyServer } from './proxy';

const logger = Logger.withTag('VideoPrefetch');

const DEFAULT_PORT = 18923;

export { PREFETCH_COUNT } from './playlist';
export { getProxyOrigin, stopProxyServer, onProxyEvent, hasRecentSegmentTimeout } from './proxy';
export type { ProxyEvent } from './proxy';

/** 启动本地代理（幂等）；失败返回 null，调用方回退直连 */
export async function ensureLocalProxy(): Promise<string | null> {
  const existing = getProxyOrigin();
  if (existing) return existing;

  try {
    return await startProxyServer(DEFAULT_PORT);
  } catch (error) {
    logger.warn(`本地预缓存代理不可用，回退直连: ${String(error)}`);
    return null;
  }
}

/** 只有 HLS 才值得走本地代理；MP4 等直连，避免白白过一遍 JS */
export function isHlsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.toLowerCase().includes('m3u8');
}

/** 把播放地址包成本地代理地址；非 HLS 或代理不可用时原样返回 */
export async function resolvePlayUrl(url: string): Promise<string> {
  if (!isHlsUrl(url)) return url;
  const origin = await ensureLocalProxy();
  return origin ? buildProxyUrl(origin, url) : url;
}

/**
 * 批量包装剧集地址。整份列表里没有 HLS 时不会启动代理。
 */
export async function mapEpisodesWithLocalProxy(urls: string[]): Promise<string[]> {
  if (!urls.some((url) => isHlsUrl(url))) return urls;

  const origin = await ensureLocalProxy();
  if (!origin) return urls;

  return urls.map((url) => (isHlsUrl(url) ? buildProxyUrl(origin, url) : url));
}
