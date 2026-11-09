import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Logger from "@/utils/Logger";

const logger = Logger.withTag("CatchupSupport");

// v3：改为请求特殊时长并核对返回时长，旧规则得出的结果作废
const STORAGE_KEY = "catchupSupport.v3";
/** 检测结果有效期一年：过期后再回看会重新检测（服务端可能修好了漏标） */
const TTL_MS = 365 * 24 * 3600 * 1000;

interface Entry {
  ok: boolean;
  at: number;
  /** 方便排查，不参与判断 */
  name: string;
  tvgId: string;
}

interface CatchupSupportState {
  /** 播放地址 → 检测结果（按地址区分：同名、同 tvg-id 的不同线路回看能力可能不同） */
  entries: Record<string, Entry>;
  load: () => Promise<void>;
  record: (url: string, ok: boolean, info: { name: string; tvgId: string }) => void;
}

const isFresh = (e: Entry | undefined): e is Entry => !!e && Date.now() - e.at < TTL_MS;

// 只从存储读一次；之后以内存为准（读取期间新记的结果不能被覆盖）
let loading: Promise<void> | null = null;

const useCatchupSupportStore = create<CatchupSupportState>((set, get) => ({
  entries: {},
  load: () => {
    if (!loading) {
      loading = (async () => {
        try {
          const raw = await AsyncStorage.getItem(STORAGE_KEY);
          if (!raw) return;
          const all = JSON.parse(raw) as Record<string, Entry>;
          const entries: Record<string, Entry> = {};
          for (const [url, e] of Object.entries(all)) if (isFresh(e)) entries[url] = e;
          set({ entries: { ...entries, ...get().entries } });
        } catch (error) {
          logger.warn("load failed:", error);
        }
      })();
    }
    return loading;
  },
  record: (url, ok, info) => {
    const entries = { ...get().entries, [url]: { ok, at: Date.now(), name: info.name, tvgId: info.tvgId } };
    set({ entries });
    logger.info(`${info.name} (${url}) catchup ${ok ? "supported" : "unsupported"}`);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries)).catch((error) => logger.warn("save failed:", error));
  },
}));

/** 已检测过（未过期）的地址返回结果，没检测过返回 undefined */
export const catchupSupportOf = (entries: Record<string, Entry>, url: string): boolean | undefined => {
  const e = entries[url];
  return isFresh(e) ? e.ok : undefined;
};

export default useCatchupSupportStore;
