/**
 * 原生本地代理的 JS 调用入口；原生不可用时返回 null。
 */

/** 原生代理过滤掉广告后发出的事件，payload = { count: 过滤掉的广告段数 } */
export const AD_FILTERED_EVENT = 'MediaProxyAdFiltered';

export interface NativeMediaProxy {
  start(options: { preferredPort: number }): Promise<{ origin?: string }>;
  stop(): Promise<void>;
  /** adFilter=true 时走 /_noad 前缀，清单会在本地代理里过滤插播广告 */
  wrapUrl(target: string, adFilter: boolean): Promise<string>;
  wrapUrls(targets: string[], adFilter: boolean): Promise<string[]>;
  wrapLiveUrl?(target: string, userAgent: string): Promise<string>;
  cancelDownloads(): void;
}

let nativeMediaProxy: NativeMediaProxy | null | undefined;

export function getNativeMediaProxy(): NativeMediaProxy | null {
  if (nativeMediaProxy !== undefined) return nativeMediaProxy;
  try {
    // 懒加载：Node 单测没有 Android 原生模块时返回 null。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NativeModules } = require('react-native');
    const candidate = NativeModules?.MediaProxy as Partial<NativeMediaProxy> | undefined;
    nativeMediaProxy =
      candidate && typeof candidate.start === 'function' && typeof candidate.wrapUrl === 'function'
        ? (candidate as NativeMediaProxy)
        : null;
  } catch {
    nativeMediaProxy = null;
  }
  return nativeMediaProxy;
}
