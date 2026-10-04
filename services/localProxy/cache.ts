/**
 * 本地预缓存代理 —— 分片内存缓存
 *
 * 缓存的是分片的 base64 文本：下载时由原生直接给出 base64，
 * 下发时原生直接吃 base64，JS 线程不用碰任何一个字节。
 * 只缓存分片（playlist 不走这里）。
 */

interface CacheEntry {
  base64: string;
  /** 解码后的字节数，用于容量统计 */
  size: number;
}

export class SegmentCache {
  private map = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** 命中会刷新 LRU 顺序 */
  get(key: string): string | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.base64;
  }

  set(key: string, base64: string, size: number): void {
    if (this.map.has(key)) this.release(key);
    this.map.set(key, { base64, size });
    this.bytes += size;
    this.evict();
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  /** 只保留这些 key，其它全部清掉（按预取窗口裁剪用） */
  keepOnly(keys: Set<string>): void {
    for (const key of [...this.map.keys()]) {
      if (!keys.has(key)) this.release(key);
    }
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  get count(): number {
    return this.map.size;
  }

  private release(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.bytes -= entry.size;
    this.map.delete(key);
  }

  /** 至少保留一条，避免单条超过上限时把刚放进去的也淘汰掉 */
  private evict(): void {
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.release(oldest);
    }
  }
}
