/**
 * 原生本地代理的 JS 调用入口；原生不可用时返回 null。
 */

export interface NativeMediaProxy {
  start(options: { preferredPort: number }): Promise<{ origin?: string }>;
  stop(): Promise<void>;
  wrapUrl(target: string): Promise<string>;
  wrapUrls(targets: string[]): Promise<string[]>;
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
