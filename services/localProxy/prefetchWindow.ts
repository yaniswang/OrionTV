/**
 * 预取窗口规划（纯逻辑，无 I/O）
 *
 * 语义：任何时刻只允许"当前分片之后的 PREFETCH_COUNT 片"处于下载中，
 * 窗口外的在途下载一律取消。跳转（拖进度条）时旧窗口整体作废。
 */

import { PREFETCH_COUNT } from './playlist';

export interface PrefetchPlanOptions {
  /** 播放器当前请求的分片序号，即播放位置 */
  currentSid: number;
  /** 清单里的分片总数 */
  totalSegments: number;
  /** 当前在途下载的分片序号 */
  inFlightSids: number[];
  /** 判断某个分片是否已在缓存里 */
  isCached: (sid: number) => boolean;
}

export interface PrefetchPlan {
  /** 需要取消的在途分片 */
  toCancel: number[];
  /** 需要新发起的预取分片 */
  toStart: number[];
  /** 允许在途的窗口（闭区间）；windowEnd < windowStart 表示窗口为空 */
  windowStart: number;
  windowEnd: number;
}

export function planPrefetchWindow(options: PrefetchPlanOptions): PrefetchPlan {
  const { currentSid, totalSegments, inFlightSids, isCached } = options;

  const windowStart = currentSid + 1;
  const windowEnd = Math.min(currentSid + PREFETCH_COUNT, totalSegments - 1);

  // 已经在最后一片之后：窗口为空，所有在途的全部取消
  const toCancel =
    windowEnd < windowStart
      ? [...inFlightSids]
      : inFlightSids.filter((sid) => sid < windowStart || sid > windowEnd);

  const inFlight = new Set(inFlightSids);
  const toStart: number[] = [];
  for (let sid = windowStart; sid <= windowEnd; sid++) {
    if (inFlight.has(sid) || isCached(sid)) continue;
    toStart.push(sid);
  }

  return { toCancel, toStart, windowStart, windowEnd };
}
