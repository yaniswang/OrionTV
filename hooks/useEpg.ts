import { useEffect, useState } from "react";
import { parseXmltvAsync, EpgData } from "@/services/epg";
import { SERVER_USER_AGENT } from "@/services/api";
import { HOUR, dayStartOf } from "@/services/liveTimeline";
import Logger from "@/utils/Logger";

const logger = Logger.withTag("EPG");

/** 超过这个时间或跨天就重新下载 */
const REFRESH_MS = 6 * HOUR;
/** 进页后延迟加载，避开进页动画 */
const LOAD_DELAY_MS = 1000;

let cache: { url: string; loadedAt: number; data: EpgData } | null = null;
let inflight: { url: string; promise: Promise<EpgData | null> } | null = null;

const isFresh = (url: string) => {
  if (!cache || cache.url !== url) return false;
  const now = Date.now();
  const tz = -new Date().getTimezoneOffset();
  return now - cache.loadedAt < REFRESH_MS && dayStartOf(now, tz) === dayStartOf(cache.loadedAt, tz);
};

async function download(url: string): Promise<EpgData | null> {
  try {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": SERVER_USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const t1 = Date.now();
    const data = await parseXmltvAsync(text);
    logger.info(`EPG loaded: ${text.length} chars, ${data.programs.size} channels, download ${t1 - t0}ms, parse ${Date.now() - t1}ms`);
    if (data.programs.size === 0) return null;
    cache = { url, loadedAt: Date.now(), data };
    return data;
  } catch (error) {
    // 节目单只是增强功能，失败不打扰用户，下次打开面板再试
    logger.warn("EPG load failed:", error);
    return null;
  }
}

/**
 * 加载节目单。url 为空表示服务器没配置节目单；reloadKey 变化时（如打开面板）检查是否需要重新下载。
 */
export function useEpg(url: string, reloadKey: number): EpgData | null {
  const [data, setData] = useState<EpgData | null>(() => (url && isFresh(url) ? cache!.data : null));

  useEffect(() => {
    if (!url) {
      setData(null);
      return;
    }
    if (isFresh(url)) {
      setData(cache!.data);
      return;
    }
    let cancelled = false;
    // 解析约 2MB 文本会占用 JS 线程，等进页动画结束再做。
    // 不用 InteractionManager：下层页面有循环动画时它永远不回调，节目单就一直不加载
    const timer = setTimeout(() => {
      logger.info(`EPG load start: ${url}`);
      if (!inflight || inflight.url !== url) {
        const promise = download(url).finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });
        inflight = { url, promise };
      }
      void inflight.promise.then((result) => {
        if (!cancelled && result) setData(result);
      });
    }, LOAD_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, reloadKey]);

  return data;
}
