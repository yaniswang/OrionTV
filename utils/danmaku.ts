export interface DanmakuAnime {
  animeId: number;
  bangumiId?: string;
  animeTitle: string;
  type: string;
  typeDescription: string;
  imageUrl?: string;
  startDate?: string;
  episodeCount?: number;
  commentCount?: number;
  source: string;
}

export interface DanmakuEpisode {
  episodeId: number;
  episodeTitle: string;
}

export interface DanmakuComment {
  p: string;
  m: string;
  cid: number;
}

export interface DanmakuSelection {
  animeId: number;
  episodeId: number;
  animeTitle: string;
  episodeTitle: string;
  searchKeyword?: string;
}

export interface DisplayDanmaku {
  text: string;
  time: number;
  color: string;
  mode: number; // 0 scroll, 1 top, 2 bottom
}

export interface DanmakuSearchResponse {
  errorCode: number;
  success: boolean;
  errorMessage: string;
  animes: DanmakuAnime[];
}

export interface DanmakuEpisodesResponse {
  errorCode: number;
  success: boolean;
  errorMessage: string;
  bangumi: {
    bangumiId: string;
    animeTitle: string;
    episodes: DanmakuEpisode[];
  };
}

export interface DanmakuCommentsResponse {
  count: number;
  comments: DanmakuComment[];
}

export function convertDanmakuFormat(comments: DanmakuComment[]): DisplayDanmaku[] {
  return comments
    .map((comment) => {
      const parts = (comment.p || "").split(",");
      const time = parseFloat(parts[0]) || 0;
      const type = parseInt(parts[1], 10) || 1;
      const colorValue = parseInt(parts[3], 10);
      const color =
        Number.isFinite(colorValue) && colorValue > 0
          ? `#${colorValue.toString(16).padStart(6, "0")}`
          : "#ffffff";

      let mode = 0;
      if (type === 5) mode = 1;
      else if (type === 4) mode = 2;

      return {
        text: (comment.m || "").trim(),
        time,
        color,
        mode,
      };
    })
    .filter((item) => item.text.length > 0)
    .sort((a, b) => a.time - b.time);
}

export function normalizeDanmakuTitle(title: string): string {
  return title
    .replace(/\s+/g, "")
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

export function filterDanmakuSources(
  animes: DanmakuAnime[],
  videoTitle: string,
  videoYear?: string
): DanmakuAnime[] {
  if (animes.length <= 1) return animes;

  const extractYear = (dateStr?: string): string | null => {
    if (!dateStr) return null;
    const match = dateStr.match(/^(\d{4})/);
    return match ? match[1] : null;
  };

  const normalizedVideoTitle = normalizeDanmakuTitle(videoTitle);

  if (videoYear) {
    const exactMatches = animes.filter((anime) => {
      const animeYear = extractYear(anime.startDate);
      return animeYear === videoYear && normalizeDanmakuTitle(anime.animeTitle) === normalizedVideoTitle;
    });
    if (exactMatches.length > 0) return exactMatches;
  }

  const titleMatches = animes.filter(
    (anime) => normalizeDanmakuTitle(anime.animeTitle) === normalizedVideoTitle
  );
  if (titleMatches.length > 0) return titleMatches;

  if (videoYear) {
    const yearMatches = animes.filter((anime) => extractYear(anime.startDate) === videoYear);
    if (yearMatches.length > 0) return yearMatches;
  }

  return animes;
}

export function formatDanmakuSourceLabel(
  anime: Pick<DanmakuAnime, "animeTitle" | "source" | "episodeCount" | "commentCount">
): string {
  const parts = [anime.animeTitle];
  if (anime.source) parts.push(anime.source);
  if (anime.episodeCount) parts.push(`${anime.episodeCount}集`);
  const base = parts.filter(Boolean).join(" · ");
  return typeof anime.commentCount === "number" ? `${base}（${anime.commentCount}条）` : base;
}

export function extractEpisodeNumber(title: string): number | null {
  if (!title) return null;
  const embyMatch = title.match(/[Ss]\d+[Ee](\d+)/);
  if (embyMatch) return parseInt(embyMatch[1], 10);
  const match = title.match(/^(\d+)$|第?\s*(\d+)\s*[集话話]?/);
  return match ? parseInt(match[1] || match[2], 10) : null;
}

export function matchDanmakuEpisode(
  currentEpisodeIndex: number,
  danmakuEpisodes: DanmakuEpisode[],
  videoEpisodeTitle?: string
): DanmakuEpisode | null {
  if (!danmakuEpisodes.length) return null;

  if (videoEpisodeTitle) {
    const episodeNum = extractEpisodeNumber(videoEpisodeTitle);
    if (episodeNum !== null) {
      for (const ep of danmakuEpisodes) {
        if (extractEpisodeNumber(ep.episodeTitle) === episodeNum) {
          return ep;
        }
      }
    }
  }

  // 索引超出范围时返回 null，避免错配弹幕
  if (currentEpisodeIndex < 0 || currentEpisodeIndex >= danmakuEpisodes.length) {
    return null;
  }
  return danmakuEpisodes[currentEpisodeIndex];
}

export const DANMAKU_SCROLL_DURATION = 8;
export const DANMAKU_FIXED_DURATION = 4.2;
export const DANMAKU_MAX_FLYING = 48;
export const DANMAKU_TRACKS = 10;
export const DANMAKU_LATE_WINDOW = 1.2;
export const DANMAKU_SPAWN_LOOKBACK = 0.2;
export const DANMAKU_TRACK_GAP = 1.1;

export const DANMAKU_AREA_OPTIONS = [0.25, 0.5, 0.75] as const;
export type DanmakuArea = (typeof DANMAKU_AREA_OPTIONS)[number];

export const DANMAKU_DENSITY_OPTIONS = ["sparse", "medium", "unlimited"] as const;
export type DanmakuDensity = (typeof DANMAKU_DENSITY_OPTIONS)[number];

export const DANMAKU_DEFAULT_AREA: DanmakuArea = 0.25;
export const DANMAKU_DEFAULT_DENSITY: DanmakuDensity = "medium";

const DENSITY_MAX_PER_WINDOW: Record<DanmakuDensity, number> = {
  sparse: 4,
  medium: 10,
  unlimited: Number.POSITIVE_INFINITY,
};
const DENSITY_MAX_SAME_TEXT: Record<DanmakuDensity, number> = {
  sparse: 1,
  medium: 2,
  unlimited: Number.POSITIVE_INFINITY,
};
const DENSITY_MAX_FLYING: Record<DanmakuDensity, number> = {
  sparse: 16,
  medium: 32,
  unlimited: 64,
};

export function isDanmakuArea(value: unknown): value is DanmakuArea {
  return DANMAKU_AREA_OPTIONS.includes(value as DanmakuArea);
}

export function isDanmakuDensity(value: unknown): value is DanmakuDensity {
  return DANMAKU_DENSITY_OPTIONS.includes(value as DanmakuDensity);
}

export function danmakuMaxFlying(density: DanmakuDensity): number {
  return DENSITY_MAX_FLYING[density];
}

export function danmakuTrackCount(screenHeight: number, fontSize: number, areaRatio: number): number {
  const line = fontSize + 8;
  const usable = Math.max(line, screenHeight * areaRatio - 16);
  return Math.max(3, Math.min(24, Math.floor(usable / line)));
}

export function filterDanmakuByDensity(
  comments: DisplayDanmaku[],
  density: DanmakuDensity
): DisplayDanmaku[] {
  if (density === "unlimited") return comments;

  const maxPerWindow = DENSITY_MAX_PER_WINDOW[density];
  const maxSameText = DENSITY_MAX_SAME_TEXT[density];
  const result: DisplayDanmaku[] = [];
  let index = 0;

  while (index < comments.length) {
    const windowStart = Math.floor(comments[index].time);
    const windowItems: DisplayDanmaku[] = [];
    while (index < comments.length && Math.floor(comments[index].time) === windowStart) {
      windowItems.push(comments[index]);
      index += 1;
    }

    const textCount = new Map<string, number>();
    const deduped: DisplayDanmaku[] = [];
    for (const item of windowItems) {
      const seen = textCount.get(item.text) ?? 0;
      if (seen >= maxSameText) continue;
      textCount.set(item.text, seen + 1);
      deduped.push(item);
    }

    if (deduped.length <= maxPerWindow) {
      result.push(...deduped);
      continue;
    }

    const ranked = [...deduped].sort((a, b) => scoreDanmaku(b) - scoreDanmaku(a) || a.time - b.time);
    ranked
      .slice(0, maxPerWindow)
      .sort((a, b) => a.time - b.time)
      .forEach((item) => result.push(item));
  }

  return result;
}

function scoreDanmaku(item: DisplayDanmaku): number {
  const colorBonus = item.color.toLowerCase() !== "#ffffff" ? 3 : 0;
  const lengthBonus = Math.min(item.text.length, 24) * 0.15;
  const modeBonus = item.mode !== 0 ? 2 : 0;
  return colorBonus + lengthBonus + modeBonus;
}

export type VideoClockSnapshot = {
  time: number;
  wall: number;
  playing: boolean;
  rate: number;
};

export type VideoClockSyncState = {
  videoTime: number;
  playing: boolean;
  rate: number;
};

export function interpolateVideoTime(clock: VideoClockSnapshot, now: number): number {
  if (!clock.playing) return clock.time;
  return clock.time + ((now - clock.wall) / 1000) * (clock.rate || 1);
}

export function shouldRefreshVideoClock(
  prev: VideoClockSyncState,
  next: VideoClockSyncState
): boolean {
  return prev.videoTime !== next.videoTime || prev.playing !== next.playing || prev.rate !== next.rate;
}

export function scrollTranslateX(screenWidth: number, itemWidth: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return screenWidth - p * (screenWidth + itemWidth);
}

export function progressFromTranslateX(x: number, screenWidth: number, itemWidth: number): number {
  const total = screenWidth + itemWidth;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (screenWidth - x) / total));
}

export function remainingScrollMs(totalSeconds: number, elapsedSeconds: number): number {
  return Math.max(0, (totalSeconds - Math.max(0, elapsedSeconds)) * 1000);
}

export function findSpawnIndex(
  comments: Array<{ time: number }>,
  time: number,
  lookback = DANMAKU_SPAWN_LOOKBACK
): number {
  let idx = 0;
  while (idx < comments.length && comments[idx].time < time - lookback) idx += 1;
  return idx;
}

export function shouldSpawnComment(
  commentTime: number,
  now: number,
  lateWindow = DANMAKU_LATE_WINDOW
): boolean {
  return commentTime >= now - lateWindow;
}

export function danmakuDuration(mode: number): number {
  return mode === 0 ? DANMAKU_SCROLL_DURATION : DANMAKU_FIXED_DURATION;
}

export function estimateDanmakuWidth(text: string, fontSize: number): number {
  return Math.max(24, text.length * fontSize * 0.95);
}

export function pickDanmakuTrack(
  now: number,
  mode: number,
  tracks: number[],
  minGap = DANMAKU_TRACK_GAP,
  allowOverlap = true
): number {
  if (mode !== 0) return mode === 1 ? 0 : tracks.length - 1;
  let best = 0;
  let bestTime = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tracks.length; i++) {
    const lastTime = tracks[i] ?? -999;
    if (now - lastTime > minGap) {
      tracks[i] = now;
      return i;
    }
    if (lastTime < bestTime) {
      bestTime = lastTime;
      best = i;
    }
  }
  if (!allowOverlap) return -1;
  tracks[best] = now;
  return best;
}

export function danmakuTrackToY(
  track: number,
  mode: number,
  screenHeight: number,
  fontSize: number,
  tracks = DANMAKU_TRACKS,
  areaRatio = DANMAKU_DEFAULT_AREA
): number {
  const paddingTop = 10;
  const line = fontSize + 6;
  const usable = screenHeight * areaRatio;
  if (mode === 2) return paddingTop + Math.max(0, usable - line - 8);
  if (tracks <= 1) return paddingTop;
  const spacing = Math.max(line, (usable - line) / (tracks - 1));
  return paddingTop + Math.min(track, tracks - 1) * spacing;
}
