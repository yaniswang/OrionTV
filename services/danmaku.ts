import Logger from "@/utils/Logger";

const logger = Logger.withTag("Danmaku");

export interface DanmakuComment {
  time: number;
  text: string;
  color: string;
  mode: number;
}

export interface DanmakuMatch {
  episodeId: number;
  animeId: number;
  animeTitle: string;
  episodeTitle: string;
  episodeNumber?: number;
  source?: string;
}

export interface DanmakuAnime {
  animeId: number;
  animeTitle: string;
  type?: string;
  episodeCount?: number;
  startDate?: string;
  imageUrl?: string;
  source?: string;
}

export interface DanmakuEpisode {
  episodeId: number;
  episodeTitle: string;
  seasonId?: string;
  airDate?: string;
  url?: string;
  episodeNumber?: string | number;
}

export interface DanmakuCommentsResult {
  comments: DanmakuComment[];
  videoDuration: number;
}

interface DanmakuApiResponse {
  errorCode?: number;
  success?: boolean;
  errorMessage?: string;
  animes?: {
    animeId?: number;
    animeTitle?: string;
    type?: string;
    episodeCount?: number;
    startDate?: string;
    imageUrl?: string;
    source?: string;
    episodes?: {
      episodeId?: number;
      episodeTitle?: string;
      url?: string;
      episodeNumber?: string;
    }[];
  }[];
  bangumi?: {
    animeId?: number;
    animeTitle?: string;
    episodes?: {
      episodeId?: number;
      episodeTitle?: string;
      seasonId?: string;
      airDate?: string;
      url?: string;
      episodeNumber?: string;
    }[];
  };
  comments?: { p?: string; m?: string; t?: number }[];
  videoDuration?: number;
}

const REQUEST_TIMEOUT_MS = 20000;

/** 统一去掉末尾斜杠，弹幕 API 基地址可以带 token 路径 */
export const normalizeDanmakuBaseUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/** 去掉弹幕源标题里的来源标记，便于在播放信息里展示 */
export const cleanDanmakuTitle = (value: string): string =>
  value
    .replace(/\s*\(\d{4}\)【[^】]*】(?:\s*from\s+\S+)?/i, "")
    .replace(/^【[^】]+】\s*/, "")
    .trim();

const request = async (url: string, init?: RequestInit): Promise<DanmakuApiResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    try {
      return JSON.parse(text) as DanmakuApiResponse;
    } catch {
      throw new Error("弹幕接口返回了非 JSON 数据");
    }
  } finally {
    clearTimeout(timeout);
  }
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const colorToHex = (value: string): string => {
  const color = toNumber(value);
  if (!color) return "#ffffff";
  return `#${Math.max(0, Math.min(0xffffff, Math.trunc(color))).toString(16).padStart(6, "0")}`;
};

/**
 * 弹弹play 格式：p = "time,mode,color,uid"
 */
export const parseDanmakuComment = (item: { p?: string; m?: string; t?: number }): DanmakuComment | null => {
  const text = (item.m || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const parts = (item.p || "").split(",");
  const time = parts.length > 0 ? toNumber(parts[0]) : toNumber(item.t);
  if (!Number.isFinite(time) || time < 0) return null;
  return {
    time,
    text,
    color: colorToHex(parts[2] || ""),
    mode: parts.length > 1 ? toNumber(parts[1]) : 1,
  };
};

export const parseDanmakuComments = (items: { p?: string; m?: string; t?: number }[]): DanmakuComment[] =>
  items
    .map(parseDanmakuComment)
    .filter((item): item is DanmakuComment => item !== null)
    .sort((a, b) => a.time - b.time);

const ensureSuccess = (data: DanmakuApiResponse) => {
  if (data.success === false) {
    throw new Error(data.errorMessage || "弹幕接口请求失败");
  }
};

export const searchDanmakuAnime = async (baseUrl: string, keyword: string): Promise<DanmakuAnime[]> => {
  const base = normalizeDanmakuBaseUrl(baseUrl);
  const data = await request(`${base}/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`);
  ensureSuccess(data);
  return (data.animes || [])
    .filter((anime) => !!anime.animeId)
    .map((anime) => ({
      animeId: toNumber(anime.animeId),
      animeTitle: anime.animeTitle || "",
      type: anime.type,
      episodeCount: anime.episodeCount,
      startDate: anime.startDate,
      imageUrl: anime.imageUrl,
      source: anime.source,
    }));
};

const getStartDateYear = (value?: string): number | null => {
  const matched = value?.match(/^(\d{4})/);
  if (!matched) return null;
  const year = Number(matched[1]);
  return Number.isInteger(year) ? year : null;
};

/**
 * 手动匹配候选排序：
 * 1. 年份完全一致优先；
 * 2. 总集数与当前总集数的绝对差更小优先；
 * 3. 绝对差相同时，正差优先于负差；
 * 4. 保持 danmu_api 原始返回顺序。
 */
export const sortDanmakuAnimeCandidates = (
  animes: DanmakuAnime[],
  year?: string | number,
  episodeCount?: number,
): DanmakuAnime[] => {
  const targetYear = Number(year);
  const validTargetYear =
    Number.isInteger(targetYear) && targetYear >= 1900 && targetYear <= 2099
      ? targetYear
      : null;
  const targetEpisodeCount =
    Number.isFinite(episodeCount) && Number(episodeCount) > 0
      ? Number(episodeCount)
      : null;

  return animes
    .map((anime, index) => {
      const animeYear = getStartDateYear(anime.startDate);
      const candidateCount =
        Number.isFinite(anime.episodeCount) && Number(anime.episodeCount) > 0
          ? Number(anime.episodeCount)
          : null;
      return {
        anime,
        index,
        yearExact: validTargetYear !== null && animeYear === validTargetYear,
        episodeDistance:
          targetEpisodeCount !== null && candidateCount !== null
            ? Math.abs(candidateCount - targetEpisodeCount)
            : Number.POSITIVE_INFINITY,
        positiveDifference:
          targetEpisodeCount !== null &&
          candidateCount !== null &&
          candidateCount > targetEpisodeCount,
      };
    })
    .sort((a, b) => {
      if (a.yearExact !== b.yearExact) return a.yearExact ? -1 : 1;
      if (a.episodeDistance !== b.episodeDistance) {
        if (a.episodeDistance === Number.POSITIVE_INFINITY) return 1;
        if (b.episodeDistance === Number.POSITIVE_INFINITY) return -1;
        return a.episodeDistance - b.episodeDistance;
      }
      if (a.positiveDifference !== b.positiveDifference) {
        return a.positiveDifference ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ anime }) => anime);
};

/** 从剧集标题里提取集号：第 N 集 / 第N话 / EPxx / SxxEyy / 纯数字 */
export const parseEpisodeNumber = (title: string): number | null => {
  if (!title) return null;
  const emby = title.match(/[Ss]\d+[Ee](\d+)/);
  if (emby) return Number(emby[1]);
  const chinese = title.match(/第\s*(\d+)\s*[集话話]/);
  if (chinese) return Number(chinese[1]);
  const ep = title.match(/\bEP?\s*(\d+)\b/i);
  if (ep) return Number(ep[1]);
  const pure = title.trim().match(/^(\d+)$/);
  return pure ? Number(pure[1]) : null;
};

/** 集数严格以 bangumi 接口的 episodeNumber 为准。 */
export const getDanmakuEpisodeNumber = (
  episode: Pick<DanmakuEpisode, "episodeNumber">,
): number | null => {
  const value = Number(episode.episodeNumber);
  return Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
};

/** 统一展示为“第 N 集 + 剧集原标题”。 */
export const formatDanmakuEpisodeTitle = (
  episode: Pick<DanmakuEpisode, "episodeTitle" | "episodeNumber">,
): string => {
  const title = cleanDanmakuTitle(episode.episodeTitle || "");
  const episodeNumber = getDanmakuEpisodeNumber(episode);
  if (episodeNumber === null) return title;
  const prefix = `第${episodeNumber}集`;
  if (!title) return prefix;
  return new RegExp(`^第\\s*${episodeNumber}\\s*[集话話]`).test(title)
    ? title
    : `${prefix} ${title}`;
};

/** 在剧集列表里按集号定位，找不到再按下标兜底 */
export const findEpisodeForNumber = (
  episodes: DanmakuEpisode[],
  episodeNumber: number,
  fallbackIndex: number,
): DanmakuEpisode | null => {
  if (!episodes.length) return null;
  const byNumber = episodes.find(
    (episode) => getDanmakuEpisodeNumber(episode) === episodeNumber,
  );
  if (byNumber) return byNumber;
  return fallbackIndex >= 0 && fallbackIndex < episodes.length
    ? episodes[fallbackIndex] || null
    : null;
};

export const fetchDanmakuBangumiEpisodes = async (
  baseUrl: string,
  animeId: number,
): Promise<DanmakuEpisode[]> => {
  const base = normalizeDanmakuBaseUrl(baseUrl);
  const data = await request(`${base}/api/v2/bangumi/${animeId}`);
  ensureSuccess(data);
  if (!data.bangumi || toNumber(data.bangumi.animeId) !== animeId) return [];
  return (data.bangumi.episodes || []).flatMap((episode) => {
    if (!episode.episodeId) return [];
    return [{
      episodeId: toNumber(episode.episodeId),
      episodeTitle: episode.episodeTitle || "",
      seasonId: episode.seasonId,
      airDate: episode.airDate,
      url: episode.url,
      episodeNumber: episode.episodeNumber,
    }];
  });
};

export const fetchDanmakuComments = async (baseUrl: string, episodeId: number): Promise<DanmakuCommentsResult> => {
  const base = normalizeDanmakuBaseUrl(baseUrl);
  const data = await request(`${base}/api/v2/comment/${episodeId}?format=json&duration=true`);
  ensureSuccess(data);
  if (!Array.isArray(data.comments)) {
    throw new Error("弹幕接口返回格式无效");
  }
  const comments = parseDanmakuComments(data.comments);
  logger.info(`fetched episode ${episodeId}: ${comments.length} comments`);
  return { comments, videoDuration: toNumber(data.videoDuration) };
};

export interface DanmakuSearchOptions {
  /** 播放详情年份，用于手动候选排序 */
  year?: string | number;
  /** 当前播放内容的总集数，用于手动候选排序 */
  episodeCount?: number;
  /** 播放源剧集标题里解析出的集号，优先于列表下标 */
  episodeNumber?: number;
  /** 记住的手动选择（播放源+内容 ID -> 番剧），换集时优先复用 */
  savedSelection?: DanmakuSavedSelection | null;
}

export interface DanmakuSavedSelection {
  animeId: number;
  animeTitle: string;
  source?: string;
  episodeId?: number;
  episodeNumber?: number;
  playbackEpisodeNumber?: number;
}

const hasEpisodeMapping = (saved: DanmakuSavedSelection): boolean =>
  Number.isFinite(saved.episodeNumber) &&
  Number(saved.episodeNumber) > 0 &&
  Number.isFinite(saved.playbackEpisodeNumber) &&
  Number(saved.playbackEpisodeNumber) > 0;

const resolveFromSavedAnime = async (
  baseUrl: string,
  saved: DanmakuSavedSelection,
  episodeNumber: number,
  episodeIndex: number,
): Promise<DanmakuMatch | null> => {
  try {
    const episodes = await fetchDanmakuBangumiEpisodes(baseUrl, saved.animeId);
    let episode: DanmakuEpisode | null = null;
    if (hasEpisodeMapping(saved)) {
      const savedEpisodeNumber = Number(saved.episodeNumber);
      const savedPlaybackEpisodeNumber = Number(saved.playbackEpisodeNumber);
      const targetEpisodeNumber =
        savedEpisodeNumber + (episodeNumber - savedPlaybackEpisodeNumber);
      if (targetEpisodeNumber > 0) {
        episode =
          episodes.find(
            (item) => getDanmakuEpisodeNumber(item) === targetEpisodeNumber,
          ) || null;
      }
      if (
        !episode &&
        episodeNumber === savedPlaybackEpisodeNumber &&
        saved.episodeId
      ) {
        episode = episodes.find((item) => item.episodeId === saved.episodeId) || null;
      }
    } else {
      episode = findEpisodeForNumber(episodes, episodeNumber, episodeIndex);
    }
    if (!episode) return null;
    return {
      episodeId: episode.episodeId,
      animeId: saved.animeId,
      animeTitle: saved.animeTitle,
      episodeTitle: episode.episodeTitle,
      episodeNumber: getDanmakuEpisodeNumber(episode) ?? undefined,
      source: saved.source,
    };
  } catch (error) {
    logger.warn("resolve from saved anime failed", error);
    return null;
  }
};

export const resolveEpisodeForSearch = async (
  baseUrl: string,
  title: string,
  episodeIndex: number,
  options: DanmakuSearchOptions = {},
): Promise<DanmakuMatch | null> => {
  const expectedEpisode = Math.max(1, Math.trunc(options.episodeNumber ?? episodeIndex + 1));

  if (options.savedSelection) {
    const savedMatch = await resolveFromSavedAnime(
      baseUrl,
      options.savedSelection,
      expectedEpisode,
      episodeIndex,
    );
    if (savedMatch) return savedMatch;
    if (hasEpisodeMapping(options.savedSelection)) return null;
  }

  const animes = await searchDanmakuAnime(baseUrl, title);
  const anime = sortDanmakuAnimeCandidates(
    animes,
    options.year,
    options.episodeCount,
  )[0];
  if (!anime) return null;

  const episodes = await fetchDanmakuBangumiEpisodes(baseUrl, anime.animeId);
  const episode = findEpisodeForNumber(episodes, expectedEpisode, episodeIndex);
  if (!episode) return null;

  return {
    episodeId: episode.episodeId,
    animeId: anime.animeId,
    animeTitle: anime.animeTitle,
    episodeTitle: episode.episodeTitle,
    episodeNumber: getDanmakuEpisodeNumber(episode) ?? undefined,
    source: anime.source,
  };
};

