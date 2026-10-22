import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  fetchDanmakuComments,
  parseEpisodeNumber,
  resolveEpisodeForSearch,
  type DanmakuComment,
  type DanmakuCommentsResult,
  type DanmakuMatch,
} from "@/services/danmaku";
import { useSettingsStore } from "@/stores/settingsStore";
import { DanmakuSelectionManager } from "@/services/storage";
import Logger from "@/utils/Logger";

const logger = Logger.withTag("DanmakuStore");
const STORAGE_KEY = "mytv_danmaku";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 3;

export interface DanmakuSettings {
  /** 0-1 */
  opacity: number;
  /** 顶部显示区域占比：0.25 / 0.5 / 0.75 / 1 */
  area: number;
  /** 字号（逻辑像素） */
  fontSize: number;
  /** 1-5，对应极慢/较慢/适中/较快/极快 */
  speed: number;
  /** 弹幕密度：正常 / 较多 / 重叠 */
  density: "normal" | "more" | "overlap";
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  opacity: 1,
  area: 0.25,
  fontSize: 25,
  speed: 3,
  density: "more",
};

interface CachedComments extends DanmakuCommentsResult {
  loadedAt: number;
}

const commentCache = new Map<number, CachedComments>();

const readCache = (episodeId: number, force: boolean): CachedComments | null => {
  const cached = commentCache.get(episodeId);
  if (!cached) return null;
  if (force || Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    commentCache.delete(episodeId);
    return null;
  }
  return cached;
};

const writeCache = (episodeId: number, value: DanmakuCommentsResult) => {
  commentCache.set(episodeId, { ...value, loadedAt: Date.now() });
  while (commentCache.size > CACHE_MAX_ENTRIES) {
    const oldest = [...commentCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0];
    if (!oldest) break;
    commentCache.delete(oldest[0]);
  }
};

interface PersistedDanmaku {
  enabled: boolean;
  settings: DanmakuSettings;
  /** 2: 速度改为 1-5 五档 */
  version?: number;
}

interface DanmakuState {
  enabled: boolean;
  settings: DanmakuSettings;
  comments: DanmakuComment[];
  match: DanmakuMatch | null;
  matchMode: "auto" | "manual" | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  videoDuration: number | null;
  hydrated: boolean;
  loadedKey: string | null;
  lastRequest: {
    title: string;
    year?: string;
    source?: string;
    id?: string;
    episodeIndex: number;
    episodeCount?: number;
    episodeTitle?: string;
  } | null;
  hydrate: () => Promise<void>;
  toggleEnabled: () => void;
  updateSettings: (patch: Partial<DanmakuSettings>) => void;
  loadForEpisode: (params: {
    title: string;
    year?: string;
    source?: string;
    id?: string;
    episodeIndex: number;
    episodeCount?: number;
    episodeTitle?: string;
    force?: boolean;
  }) => Promise<void>;
  loadEpisode: (
    match: DanmakuMatch,
    options?: {
      force?: boolean;
      matchMode?: "auto" | "manual";
      rememberSelection?: {
        source: string;
        id: string;
        playbackEpisodeNumber?: number;
      };
    },
  ) => Promise<void>;
  reload: () => Promise<void>;
  clear: () => void;
}

const persist = (state: Pick<DanmakuState, "enabled" | "settings">) => {
  const payload: PersistedDanmaku = {
    enabled: state.enabled,
    settings: state.settings,
    version: 2,
  };
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload)).catch((error) => {
    logger.warn("save danmaku settings failed", error);
  });
};

/** 旧版速度是 1-10，新版是 1-5 五档 */
const normalizeSpeed = (value: number, version?: number): number => {
  const raw = Number.isFinite(value) ? value : DEFAULT_DANMAKU_SETTINGS.speed;
  if (version === 2) return Math.max(1, Math.min(5, Math.round(raw)));
  if (raw <= 2) return 1;
  if (raw <= 4) return 2;
  if (raw <= 7) return 3;
  if (raw <= 9) return 4;
  return 5;
};

let requestSeq = 0;

export const useDanmakuStore = create<DanmakuState>((set, get) => ({
  enabled: true,
  settings: DEFAULT_DANMAKU_SETTINGS,
  comments: [],
  match: null,
  matchMode: null,
  loading: false,
  error: null,
  loadedAt: null,
  videoDuration: null,
  hydrated: false,
  loadedKey: null,
  lastRequest: null,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedDanmaku>;
        const stored = {
          ...((parsed.settings || {}) as Partial<DanmakuSettings> & {
            antiOverlap?: boolean;
          }),
        };
        delete stored.antiOverlap;
        set({
          enabled: parsed.enabled !== false,
          settings: {
            ...DEFAULT_DANMAKU_SETTINGS,
            ...stored,
            speed: normalizeSpeed(stored.speed ?? DEFAULT_DANMAKU_SETTINGS.speed, parsed.version),
          },
        });
      }
    } catch (error) {
      logger.warn("load danmaku settings failed", error);
    } finally {
      set({ hydrated: true });
    }
  },

  toggleEnabled: () => {
    const enabled = !get().enabled;
    set({ enabled });
    persist({ enabled, settings: get().settings });
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    persist({ enabled: get().enabled, settings });
  },

  loadForEpisode: async ({ title, year, source, id, episodeIndex, episodeCount, episodeTitle, force = false }) => {
    const baseUrl = useSettingsStore.getState().danmakuApiUrl;
    if (!baseUrl.trim()) {
      set({
        comments: [],
        match: null,
        matchMode: null,
        error: "未配置弹幕API",
        loading: false,
        loadedAt: null,
      });
      return;
    }
    if (!get().enabled) return;
    const key = `${baseUrl}|${source || ""}|${id || ""}|${title}|${year || ""}|${episodeIndex}|${episodeCount || 0}|${episodeTitle || ""}`;
    if (!force && get().loadedKey === key && get().match) return;

    const seq = ++requestSeq;
    set({
      loading: true,
      error: null,
      loadedKey: key,
      lastRequest: { title, year, source, id, episodeIndex, episodeCount, episodeTitle },
      comments: [],
      match: null,
      matchMode: null,
      videoDuration: null,
      loadedAt: null,
    });
    try {
      let savedSelection: {
        animeId: number;
        animeTitle: string;
        source?: string;
        episodeId?: number;
        episodeNumber?: number;
        playbackEpisodeNumber?: number;
      } | null = null;
      if (!force && source && id) {
        try {
          savedSelection = await DanmakuSelectionManager.get(source, id);
        } catch {
          savedSelection = null;
        }
      }
      const match = await resolveEpisodeForSearch(baseUrl, title, episodeIndex, {
        year,
        episodeCount,
        episodeNumber: episodeTitle ? parseEpisodeNumber(episodeTitle) ?? undefined : undefined,
        savedSelection,
      });
      if (seq !== requestSeq) return;
      if (!match) {
        set({
          comments: [],
          match: null,
          matchMode: null,
          loading: false,
          error: "未找到匹配的弹幕，请手动匹配",
          loadedAt: Date.now(),
        });
        return;
      }
      await get().loadEpisode(match, {
        force,
        matchMode:
          savedSelection && savedSelection.animeId === match.animeId
            ? "manual"
            : "auto",
      });
    } catch (error) {
      if (seq !== requestSeq) return;
      const message = error instanceof Error ? error.message : "弹幕加载失败";
      logger.warn("load danmaku failed", error);
      set({
        loading: false,
        error: message,
        comments: [],
        match: null,
        matchMode: null,
      });
    }
  },

  loadEpisode: async (match, options) => {
    const baseUrl = useSettingsStore.getState().danmakuApiUrl;
    if (!baseUrl.trim()) {
      set({ error: "未配置弹幕API", loading: false });
      return;
    }
    const seq = ++requestSeq;
    const matchMode = options?.rememberSelection
      ? "manual"
      : options?.matchMode ?? get().matchMode;
    set({
      loading: true,
      error: null,
      match,
      matchMode,
      comments: [],
      videoDuration: null,
      loadedAt: null,
    });
    try {
      const cached = readCache(match.episodeId, options?.force === true);
      const result = cached || (await fetchDanmakuComments(baseUrl, match.episodeId));
      if (seq !== requestSeq) return;
      if (!cached) writeCache(match.episodeId, result);
      set({
        comments: result.comments,
        matchMode,
        videoDuration: result.videoDuration || null,
        loadedAt: Date.now(),
        loading: false,
        error: result.comments.length ? null : "当前集暂无弹幕",
      });
      if (options?.rememberSelection) {
        try {
          await DanmakuSelectionManager.save(
            options.rememberSelection.source,
            options.rememberSelection.id,
            {
            animeId: match.animeId,
            animeTitle: match.animeTitle,
              source: match.source,
              episodeId: match.episodeId,
              episodeNumber: match.episodeNumber,
              playbackEpisodeNumber: options.rememberSelection.playbackEpisodeNumber,
            },
          );
        } catch (error) {
          logger.warn("save danmaku selection failed", error);
        }
      }
    } catch (error) {
      if (seq !== requestSeq) return;
      const message = error instanceof Error ? error.message : "弹幕加载失败";
      logger.warn("fetch comments failed", error);
      set({ loading: false, error: message, comments: [], matchMode: null });
    }
  },

  reload: async () => {
    const { match, lastRequest } = get();
    if (match) {
      await get().loadEpisode(match, {
        force: true,
        matchMode: get().matchMode ?? "auto",
      });
      return;
    }
    if (lastRequest) {
      await get().loadForEpisode({ ...lastRequest, force: true });
    }
  },

  clear: () => {
    requestSeq++;
    set({
      comments: [],
      match: null,
      matchMode: null,
      loading: false,
      error: null,
      loadedAt: null,
      loadedKey: null,
      lastRequest: null,
    });
  },
}));

export default useDanmakuStore;
