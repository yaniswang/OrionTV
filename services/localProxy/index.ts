/**
 * 本地预缓存代理 —— 原生模块的 JS 入口。
 *
 * 全部数据面都在 Android 原生 MediaProxy 中完成，这里只负责启动、停止和包装播放地址。
 */

import Logger from '@/utils/Logger';
import { getNativeMediaProxy } from './native';

const logger = Logger.withTag('VideoPrefetch');
const DEFAULT_PORT = 18923;

let nativeOrigin: string | null = null;

export function getProxyOrigin(): string | null {
  return nativeOrigin;
}

export function isLanProxyOrigin(origin = getProxyOrigin()): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  } catch {
    return false;
  }
}

export function cancelProxyDownloads(): void {
  getNativeMediaProxy()?.cancelDownloads();
}

export async function stopProxyServer(): Promise<void> {
  nativeOrigin = null;
  const native = getNativeMediaProxy();
  if (!native) return;
  try {
    await native.stop();
  } catch (error) {
    logger.warn(`停止原生本地代理失败: ${String(error)}`);
  }
}

/** 启动原生代理（幂等）；原生模块不可用或启动失败时返回 null。 */
export async function ensureLocalProxy(): Promise<string | null> {
  if (nativeOrigin) return nativeOrigin;
  const native = getNativeMediaProxy();
  if (!native) {
    logger.warn('Android 原生本地代理不可用');
    return null;
  }

  try {
    const result = await native.start({ preferredPort: DEFAULT_PORT });
    const origin = typeof result?.origin === 'string' ? result.origin : null;
    if (!origin) return null;
    nativeOrigin = origin;
    return origin;
  } catch (error) {
    logger.warn(`原生本地代理不可用: ${String(error)}`);
    return null;
  }
}

/** 只有 HLS 需要经过本地代理，MP4 等直连。 */
export function isHlsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.toLowerCase().includes('m3u8');
}

/** 把播放地址交给原生代理包装；失败时返回原地址。 */
export async function resolvePlayUrl(url: string): Promise<string> {
  if (!isHlsUrl(url)) return url;
  if (!(await ensureLocalProxy())) return url;

  try {
    const wrapped = await getNativeMediaProxy()?.wrapUrl(url);
    return typeof wrapped === 'string' && wrapped ? wrapped : url;
  } catch (error) {
    logger.warn(`原生代理包装播放地址失败: ${String(error)}`);
    return url;
  }
}

/** 批量包装剧集地址；整份列表没有 HLS 时不启动代理。 */
export async function mapEpisodesWithLocalProxy(urls: string[]): Promise<string[]> {
  if (!urls.some((url) => isHlsUrl(url))) return urls;
  if (!(await ensureLocalProxy())) return urls;

  try {
    const wrapped = await getNativeMediaProxy()?.wrapUrls(urls);
    return Array.isArray(wrapped) && wrapped.length === urls.length ? wrapped : urls;
  } catch (error) {
    logger.warn(`原生代理包装剧集地址失败: ${String(error)}`);
    return urls;
  }
}
