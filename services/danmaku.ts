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
  /** 从弹幕剧集标题解析出的真实集号 */
  episodeNumber?: number;
  /** 搜索结果的来源（tencent / 360 …） */
  source?: string;
  /** 弹幕实际所在平台（qq / bilibili …，取自剧集标题前缀） */
  platform?: string;
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

// ---------------------------------------------------------------------------
// 片源侧：当前播放的是第几集
// ---------------------------------------------------------------------------

/** 片源分集里不参与匹配的条目：番外、合集（"第1-20集"、"全集"） */
const PLAYBACK_EXTRA_PATTERN =
  /预告|花絮|采访|彩蛋|小剧场|番外|特辑|幕后|片花|抢先|加更|纯享|会员版|全集|合集|\d+\s*-\s*\d+\s*集/;

/**
 * 片源分集标题 -> 真实集号。
 * "总第N集" 优先（按季拆分的片源会标全剧集号）；其次 "第N集/话/期"、纯数字、EPxx；
 * 番外和合集返回 null；单集片源（"正片""HD中字"）算第 1 集；没有标题时按位置。
 */
export const parsePlaybackEpisodeNumber = (
  title: string | undefined,
  index: number,
  total: number,
): number | null => {
  const text = (title || "").trim();
  if (!text) return index + 1;
  const sum = text.match(/总第\s*0*(\d+)\s*[集话]/);
  if (sum) return Number(sum[1]);
  if (PLAYBACK_EXTRA_PATTERN.test(text)) return null;
  const matched =
    text.match(/第\s*0*(\d+)\s*[集话期]/) ||
    text.match(/^0*(\d+)$/) ||
    text.match(/^EP?\s*0*(\d+)/i) ||
    text.match(/^0*(\d+)\s*[集话]/) || // "001集：英雄之子是废物？"
    text.match(/第\s*0*(\d+)\s*$/); // "第18"
  if (matched) return Number(matched[1]) || null;
  return total === 1 ? 1 : null;
};

/** 电影分部标记：上 / 中 / 下（可带 集/部/篇），"HD中字"里的"中"不算 */
const MOVIE_PART_PATTERN = /[上中下](集|部|篇)?\s*$/;
/** 多版本电影的最大条数；条数更多的没有集号列表按连续剧处理 */
const MAX_MOVIE_VERSIONS = 3;

/**
 * 整个片源列表的真实集号（逐条规则见 parsePlaybackEpisodeNumber），另加一条只能看整列表的规则：
 * 多版本电影（"HD国语""HD中字"）——整列表没有集号、不超过 3 条、标题各不相同、没有上/中/下分部——都算第 1 集。
 */
export const parsePlaybackEpisodeNumbers = (titles: (string | undefined)[]): (number | null)[] => {
  const numbers = titles.map((title, index) => parsePlaybackEpisodeNumber(title, index, titles.length));
  if (titles.length < 2 || titles.length > MAX_MOVIE_VERSIONS || numbers.some((n) => n !== null)) {
    return numbers;
  }
  const texts = titles.map((title) => (title || "").trim());
  const isVersions =
    new Set(texts).size === texts.length && !texts.some((text) => MOVIE_PART_PATTERN.test(text));
  return isVersions ? texts.map((text) => (PLAYBACK_EXTRA_PATTERN.test(text) ? null : 1)) : numbers;
};

/** 中文之间（或结尾）的英文罗马数字换成全角：斗罗大陆II绝世唐门 -> 斗罗大陆Ⅱ绝世唐门 */
const ROMAN_NUMERALS: Record<string, string> = {
  II: "Ⅱ", III: "Ⅲ", IV: "Ⅳ", VI: "Ⅵ", VII: "Ⅶ", VIII: "Ⅷ", IX: "Ⅸ",
};
export const romanFallbackKeyword = (title: string): string =>
  title.replace(
    /([一-龥])(VIII|VII|III|VI|IV|IX|II)(?=[一-龥\s]|$)/g,
    (_, prefix: string, roman: string) => prefix + ROMAN_NUMERALS[roman],
  );

// ---------------------------------------------------------------------------
// 弹幕侧：把一个搜索候选整理成按平台分组、按真实集号索引的弹幕源
// ---------------------------------------------------------------------------

/** 平台优先级：原站弹幕最全的在前 */
const PLATFORM_PRIORITY = ["bilibili", "qq", "qiyi", "youku", "imgo"];
const PLATFORM_NAMES: Record<string, string> = {
  bilibili: "B站",
  qq: "腾讯",
  qiyi: "爱奇艺",
  youku: "优酷",
  imgo: "芒果",
  renren: "人人",
  hanjutv: "韩剧TV",
};
const platformRank = (platform: string): number => {
  const index = PLATFORM_PRIORITY.indexOf(platform);
  return index < 0 ? PLATFORM_PRIORITY.length : index;
};
export const getDanmakuPlatformName = (platform?: string): string =>
  platform ? PLATFORM_NAMES[platform] || platform : "";
/** 平台优先级序号，越小越优先（手动弹窗排序与自动匹配保持一致） */
export const getDanmakuPlatformRank = (platform: string): number => platformRank(platform);

export const getDanmakuAnimeYear = (anime: Pick<DanmakuAnime, "startDate">): number | null =>
  getStartDateYear(anime.startDate);

/** 360 只是聚合索引，更新慢，作为原站的备份 */
export const isBackupDanmakuSource = (source?: string): boolean => source === "360";

/** 剧集标题前缀【qq】【bilibili1】就是弹幕所在平台；没有前缀时用搜索来源 */
const platformOfEpisode = (title: string): string | null =>
  title.match(/^【([^】]+)】/)?.[1].replace(/\d+$/, "") || null;

const DANMAKU_EXTRA_PATTERN =
  /预告|PV|花絮|采访|小剧场|特辑|彩蛋|番外|幕后|片花|MV|主题曲|看点|抢先|加更|纯享|直拍|reaction|会员版|精编版|加长版|剪辑版|分钟版|先导|发布会|专访/i;

export interface DanmakuSourceEpisode extends DanmakuEpisode {
  /** 真实集号；番外为 null */
  number: number | null;
}

export interface DanmakuSource {
  key: string;
  anime: DanmakuAnime;
  /** qq / bilibili / qiyi … */
  platform: string;
  /** 来自 360 聚合 */
  isBackup: boolean;
  /** 正片，按集号排序 */
  main: DanmakuSourceEpisode[];
  /** 番外、集号重复或无法编号的条目，保持原顺序 */
  extras: DanmakuSourceEpisode[];
  byNumber: Map<number, DanmakuSourceEpisode>;
}

const stripPlatformPrefix = (title: string) => title.replace(/^【[^】]*】\s*/, "");

const buildSource = (
  anime: DanmakuAnime,
  platform: string,
  episodes: DanmakuEpisode[],
): DanmakuSource => {
  const rows = episodes.map((episode) => {
    const text = stripPlatformPrefix(episode.episodeTitle || "");
    const extra = DANMAKU_EXTRA_PATTERN.test(text);
    const number = extra ? null : Number(text.match(/第\s*0*(\d+)\s*[集话話期]/)?.[1]) || null;
    return { episode, extra, number };
  });
  const anyNumbered = rows.some((row) => !row.extra && row.number !== null);
  const byNumber = new Map<number, DanmakuSourceEpisode>();
  const main: DanmakuSourceEpisode[] = [];
  const extras: DanmakuSourceEpisode[] = [];
  let position = 0;
  rows.forEach((row) => {
    if (row.extra) {
      extras.push({ ...row.episode, number: null });
      return;
    }
    position += 1;
    // 整组都没有集号时按位置；否则标题里没有集号的（如"相守结局"）保持原样，不编集号
    const number = anyNumbered ? row.number : position;
    if (number === null || byNumber.has(number)) {
      extras.push({ ...row.episode, number: null });
      return;
    }
    const item = { ...row.episode, number };
    byNumber.set(number, item);
    main.push(item);
  });
  main.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  return {
    key: `${anime.animeId}:${platform}`,
    anime,
    platform,
    isBackup: isBackupDanmakuSource(anime.source),
    main,
    extras,
    byNumber,
  };
};

/** 一个候选按平台拆成多个弹幕源（360 会把多个平台首尾拼在一起），按平台优先级排序 */
export const buildDanmakuSources = (
  anime: DanmakuAnime,
  episodes: DanmakuEpisode[],
): DanmakuSource[] => {
  const groups = new Map<string, DanmakuEpisode[]>();
  for (const episode of episodes) {
    const platform = platformOfEpisode(episode.episodeTitle || "") || anime.source || "unknown";
    const list = groups.get(platform);
    if (list) list.push(episode);
    else groups.set(platform, [episode]);
  }
  return [...groups]
    .map(([platform, list]) => buildSource(anime, platform, list))
    .sort((a, b) => platformRank(a.platform) - platformRank(b.platform));
};

/** 剧名比较键：去掉 "(年份)【类型】from xx"、空格标点，罗马数字与阿拉伯数字视同 */
export const danmakuTitleKey = (value: string): string =>
  value
    .replace(/\(\d{4}\)【[^】]*】.*$/, "")
    .replace(/[\s·:：,，!！?？\-—_（）()[\]【】《》"'“”‘’.。]/g, "")
    .toLowerCase()
    .replace(/ⅲ|iii/g, "3")
    .replace(/ⅱ|ii/g, "2");

/** 展示为 "第 N 集 + 剧集原标题"（去掉平台前缀） */
export const formatDanmakuEpisodeTitle = (episode: {
  episodeTitle?: string;
  episodeNumber?: number | null;
}): string => {
  const title = cleanDanmakuTitle(episode.episodeTitle || "");
  const number = episode.episodeNumber;
  if (!number || number <= 0) return title;
  const prefix = `第${number}集`;
  if (!title) return prefix;
  return new RegExp(`第\\s*0*${number}\\s*[集话話]`).test(title) ? title : `${prefix} ${title}`;
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
  /** 播放详情年份：候选年份必须与之相同；无效年份不自动匹配 */
  year?: string | number;
  /** 当前播放内容的总集数，用于候选排序 */
  episodeCount?: number;
  /** 片源分集解析出的真实集号（parsePlaybackEpisodeNumbers）；null 表示不是正片 */
  episodeNumber?: number | null;
  /** 片源这一条的原始标题；没有集号时用它在弹幕番外里按名称找 */
  episodeTitle?: string;
  /** 记住的手动选择（播放源+内容 ID -> 弹幕源） */
  savedSelection?: DanmakuSavedSelection | null;
}

export interface DanmakuSavedSelection {
  animeId: number;
  animeTitle: string;
  source?: string;
  /** 弹幕平台；version 2 起记录 */
  platform?: string;
  /** auto：只选了站点，按集号对齐；offset：指定了具体集，按偏移对齐 */
  mode?: "auto" | "offset";
  episodeId?: number;
  /** 弹幕真实集号（version 2 起；旧版是列表位置，不再使用） */
  episodeNumber?: number;
  playbackEpisodeNumber?: number;
  version?: number;
}

/** 当前记忆格式版本：集号为真实集号、带平台和模式 */
export const DANMAKU_SELECTION_VERSION = 2;

const toMatch = (source: DanmakuSource, episode: DanmakuSourceEpisode): DanmakuMatch => ({
  episodeId: episode.episodeId,
  animeId: source.anime.animeId,
  animeTitle: source.anime.animeTitle,
  episodeTitle: episode.episodeTitle,
  episodeNumber: episode.number ?? undefined,
  source: source.anime.source,
  platform: source.platform,
});

/**
 * 番外名称比较键：去掉平台前缀、剧名、空格和标点。
 * "【qq】 白日提灯 相守结局"（剧名 白日提灯）与片源的"相守结局"得到同一个键。
 */
export const danmakuEpisodeNameKey = (episodeTitle: string, showTitle: string): string => {
  const show = cleanDanmakuTitle(showTitle).replace(/\(\d{4}\)【[^】]*】.*$/, "").trim();
  let text = stripPlatformPrefix(episodeTitle || "");
  if (show) text = text.split(show).join("");
  return text.replace(/[\s·:：,，!！?？\-—_（）()[\]【】《》"'“”‘’.。]/g, "").toLowerCase();
};

/** 正片按集号在正片里找；番外按名称在番外里找 */
type EpisodeFinder = (source: DanmakuSource) => DanmakuSourceEpisode | undefined;

const validYear = (value?: string | number): number | null => {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2099 ? year : null;
};

/**
 * 手动选择记忆：
 * - offset：在记住的平台里按 "弹幕集号 = 记住的弹幕集号 + (当前集号 - 记住的播放集号)" 取集，取不到就不匹配；
 * - auto / 旧版记忆：在记住的番剧里按集号对齐（旧版没有平台，按平台优先级），取不到交回自动匹配。
 */
const resolveFromSaved = async (
  baseUrl: string,
  saved: DanmakuSavedSelection,
  target: number | null,
  find: EpisodeFinder,
): Promise<{ match: DanmakuMatch | null; done: boolean }> => {
  const isCurrent = saved.version === DANMAKU_SELECTION_VERSION;
  const episodes = await fetchDanmakuBangumiEpisodes(baseUrl, saved.animeId);
  const anime: DanmakuAnime = { animeId: saved.animeId, animeTitle: saved.animeTitle, source: saved.source };
  const all = buildDanmakuSources(anime, episodes);
  const sources = isCurrent && saved.platform ? all.filter((item) => item.platform === saved.platform) : all;

  // 偏移只对正片有意义；番外在记住的平台里按名称找
  if (isCurrent && saved.mode === "offset" && target !== null) {
    const source = sources[0];
    if (!source) return { match: null, done: true };
    let episode: DanmakuSourceEpisode | undefined;
    if (Number(saved.episodeNumber) > 0 && Number(saved.playbackEpisodeNumber) > 0) {
      episode = source.byNumber.get(Number(saved.episodeNumber) + target - Number(saved.playbackEpisodeNumber));
    }
    if (!episode && target === saved.playbackEpisodeNumber && saved.episodeId) {
      episode = [...source.main, ...source.extras].find((item) => item.episodeId === saved.episodeId);
    }
    return { match: episode ? toMatch(source, episode) : null, done: true };
  }

  for (const source of sources) {
    const episode = find(source);
    if (episode) return { match: toMatch(source, episode), done: true };
  }
  return { match: null, done: false };
};

/**
 * 自动匹配：
 * 1. 候选年份必须与片源相同；搜不到同年份候选时，用罗马数字兜底关键词再搜一次；
 * 2. 剧名相同的原站候选 → 剧名相同的 360 候选（备份）→ 都没有时按集数最接近的候选；
 * 3. 选中范围内按平台优先级取第一个包含当前集的弹幕源。
 */
export const resolveEpisodeForSearch = async (
  baseUrl: string,
  title: string,
  episodeIndex: number,
  options: DanmakuSearchOptions = {},
): Promise<DanmakuMatch | null> => {
  const parsed = options.episodeNumber === undefined ? episodeIndex + 1 : options.episodeNumber;
  const target = parsed && parsed > 0 ? parsed : null;
  // 没有集号的是番外：用片源标题在弹幕番外里按名称找
  const nameKey = target === null ? danmakuEpisodeNameKey(options.episodeTitle || "", title) : "";
  if (target === null && !nameKey) return null;
  const find: EpisodeFinder =
    target !== null
      ? (source) => source.byNumber.get(target)
      : (source) =>
          source.extras.find(
            (episode) => danmakuEpisodeNameKey(episode.episodeTitle, source.anime.animeTitle) === nameKey,
          );

  if (options.savedSelection) {
    try {
      const saved = await resolveFromSaved(baseUrl, options.savedSelection, target, find);
      if (saved.done) return saved.match;
    } catch (error) {
      logger.warn("resolve from saved selection failed", error);
    }
  }

  const year = validYear(options.year);
  if (year === null) return null;
  const sameYear = (list: DanmakuAnime[]) =>
    list.filter((anime) => getStartDateYear(anime.startDate) === year);

  let candidates = sameYear(await searchDanmakuAnime(baseUrl, title));
  const fallbackKeyword = romanFallbackKeyword(title);
  if (!candidates.length && fallbackKeyword !== title) {
    candidates = sameYear(await searchDanmakuAnime(baseUrl, fallbackKeyword));
  }
  if (!candidates.length) return null;

  const sorted = sortDanmakuAnimeCandidates(candidates, year, options.episodeCount);
  const episodesCache = new Map<number, Promise<DanmakuEpisode[]>>();
  const loadSources = async (anime: DanmakuAnime) => {
    let pending = episodesCache.get(anime.animeId);
    if (!pending) {
      pending = fetchDanmakuBangumiEpisodes(baseUrl, anime.animeId);
      episodesCache.set(anime.animeId, pending);
    }
    return buildDanmakuSources(anime, await pending);
  };

  // 以第一名为准，同剧名同年份的候选一起参与平台选择
  const pickInTier = async (pool: DanmakuAnime[]): Promise<DanmakuMatch | null> => {
    const top = pool[0];
    if (!top) return null;
    const topKey = danmakuTitleKey(top.animeTitle);
    const tier = pool.filter((anime) => anime === top || danmakuTitleKey(anime.animeTitle) === topKey);
    let best: { source: DanmakuSource; episode: DanmakuSourceEpisode; rank: number } | null = null;
    for (const [order, anime] of tier.entries()) {
      for (const source of await loadSources(anime)) {
        const episode = find(source);
        if (!episode) continue;
        const rank = platformRank(source.platform) * 1000 + order;
        if (!best || rank < best.rank) best = { source, episode, rank };
      }
    }
    return best ? toMatch(best.source, best.episode) : null;
  };

  const titleKey = danmakuTitleKey(title);
  const sameTitle = sorted.filter((anime) => danmakuTitleKey(anime.animeTitle) === titleKey);
  return (
    (await pickInTier(sameTitle.filter((anime) => !isBackupDanmakuSource(anime.source)))) ||
    (await pickInTier(sameTitle.filter((anime) => isBackupDanmakuSource(anime.source)))) ||
    (await pickInTier(sorted))
  );
};

