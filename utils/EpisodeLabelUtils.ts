import { parsePlaybackEpisodeNumbers } from "@/services/danmaku";

/** 超过这个数的"集号"是综艺的日期期号（第20221225期），不当作集数 */
const MAX_EPISODE_NUMBER = 9999;

// 同一个标题列表只解析一次（播放记录约 10 秒保存一次，弹窗每次渲染也会用到）
const numbersCache = new WeakMap<(string | undefined)[], (number | null)[]>();

const episodeNumbers = (titles: (string | undefined)[]): (number | null)[] => {
  const cached = numbersCache.get(titles);
  if (cached) return cached;
  const parsed = parsePlaybackEpisodeNumbers(titles);
  const result = titles.map((title, index) => {
    // 没有标题时解析会按位置返回，这里只认标题里写的集号
    if (!title?.trim()) return null;
    const number = parsed[index];
    return number !== null && number <= MAX_EPISODE_NUMBER ? number : null;
  });
  numbersCache.set(titles, result);
  return result;
};

/** 写进播放记录 / 收藏的分集信息（LunaTV 服务端原样保存这些额外字段） */
export interface EpisodeRecordInfo {
  /** 当前这一集的片源原始标题 */
  episode_title?: string;
  /** 当前这一集的真实集号；番外为 null */
  episode_number?: number | null;
  /** 按标题算出的集数（特别篇不计入） */
  episode_total?: number;
}

/** 当前这一集的分集信息；标题列表和播放列表条数对不上时不写，首页按原来的条数显示 */
export function getEpisodeRecordInfo(
  titles: string[] | undefined,
  index: number,
  count: number,
): EpisodeRecordInfo {
  if (!titles?.length || titles.length !== count) return {};
  const title = titles[index]?.trim();
  if (!title) return { episode_total: getEpisodeTotal(titles, count) };
  return {
    episode_title: title,
    episode_number: episodeNumbers(titles)[index],
    episode_total: getEpisodeTotal(titles, count),
  };
}

/**
 * 首页 / 收藏页卡片角标：正片 "集号/集数"，番外显示原始标题；只有一集（电影）时返回 "" 表示不显示；
 * 老记录或网页版写的记录没有这些字段，返回 undefined，按原来的 "第几条/条数" 显示。
 */
export function getRecordEpisodeBadge(info: EpisodeRecordInfo | undefined): string | undefined {
  if (!info?.episode_title) return undefined;
  if (info.episode_number) {
    if (!info.episode_total || info.episode_total <= 1) return "";
    return `${info.episode_number}/${info.episode_total}`;
  }
  return info.episode_title;
}

/** 片源集数：取分集标题里的最大集号（特别篇、番外不算）；解析不出时用条数 */
export function getEpisodeTotal(titles: (string | undefined)[] | undefined, count: number): number {
  if (!titles?.length) return count;
  const numbers = episodeNumbers(titles).filter((n): n is number => n !== null);
  return numbers.length ? Math.max(...numbers) : count;
}

/**
 * 选集列表的显示顺序（原始下标）：有集号的正片保持原顺序在前，
 * 没有集号的条目（特别篇、花絮）放到最后；整个列表都没有集号时保持原顺序。
 */
export function getEpisodeDisplayOrder(titles: (string | undefined)[]): number[] {
  const numbers = episodeNumbers(titles);
  const main: number[] = [];
  const others: number[] = [];
  numbers.forEach((number, index) => (number === null ? others : main).push(index));
  return [...main, ...others];
}

export interface EpisodeGroup {
  label: string;
  /** 组内条目的原始下标，按显示顺序 */
  indices: number[];
}

const chunk = <T,>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * 选集分组：有集号的正片每 size 条一组，标签是组内首尾集号；
 * 没有集号的条目（特别篇、花絮）全部放进最后的"其它"组；整个列表都没有集号时按位置分组。
 */
export function getEpisodeGroups(titles: (string | undefined)[], size: number): EpisodeGroup[] {
  const numbers = episodeNumbers(titles);
  const main: number[] = [];
  const others: number[] = [];
  numbers.forEach((number, index) => (number === null ? others : main).push(index));
  if (!main.length) {
    return chunk(others, size).map((indices, i) => ({
      label: `${i * size + 1}-${i * size + indices.length}`,
      indices,
    }));
  }
  const groups = chunk(main, size).map((indices) => {
    const first = numbers[indices[0]];
    const last = numbers[indices[indices.length - 1]];
    return { label: first === last ? `${first}` : `${first}-${last}`, indices };
  });
  if (others.length) groups.push({ label: "其它", indices: others });
  return groups;
}
