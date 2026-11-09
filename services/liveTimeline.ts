/**
 * 直播时间轴：把节目单切成「段」，没有节目信息的时间按整点时段补齐。
 * ▲▼ 切换、进度条范围、面板里每天的列表都以段为单位。
 */
import { EpgProgram, programIndexAt } from '@/services/epg';

export const HOUR = 3600 * 1000;
/** 默认可回看 7 天（咪咕实测 7×24 小时）；m3u 写了 catchup-days 以它为准 */
export const CATCHUP_MAX_AGE = 7 * 24 * HOUR;
const MAX_AGE_MARGIN = 60 * 1000;
/** 回看结束时间离直播点至少留这么多：结束时间晚于现在服务器返回 404（实测离现在 0～10 秒都可用，留 5 秒余量） */
export const LIVE_GUARD = 5 * 1000;

/** 频道的可回看时长（毫秒） */
export const catchupMaxAge = (days: number | undefined) => (days ? days * 24 * HOUR : CATCHUP_MAX_AGE);

export interface Segment {
  start: number;
  end: number;
  /** null 表示整点时段 */
  title: string | null;
}

/** 最后一个 start <= t 的节目下标，没有返回 -1 */
function lastStartedIndex(list: EpgProgram[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 包含时刻 t 的段；tzOffsetMinutes 决定整点对齐的时区 */
export function segmentAt(programs: EpgProgram[] | undefined, t: number, tzOffsetMinutes: number): Segment {
  if (programs && programs.length > 0) {
    const idx = programIndexAt(programs, t);
    if (idx >= 0) {
      const p = programs[idx];
      return { start: p.start, end: p.end, title: p.title };
    }
  }
  const tz = tzOffsetMinutes * 60000;
  let start = Math.floor((t + tz) / HOUR) * HOUR - tz;
  let end = start + HOUR;
  if (programs && programs.length > 0) {
    const prev = lastStartedIndex(programs, t);
    if (prev >= 0 && programs[prev].end > start) start = programs[prev].end;
    const next = programs[prev + 1];
    if (next && next.start < end) end = next.start;
  }
  return { start, end, title: null };
}

export function nextSegment(programs: EpgProgram[] | undefined, seg: Segment, tzOffsetMinutes: number): Segment {
  return segmentAt(programs, seg.end, tzOffsetMinutes);
}

export function prevSegment(programs: EpgProgram[] | undefined, seg: Segment, tzOffsetMinutes: number): Segment {
  return segmentAt(programs, seg.start - 1, tzOffsetMinutes);
}

/** 某一天（dayStart 起 24 小时）里开始的所有段 */
export function daySegments(programs: EpgProgram[] | undefined, dayStart: number, tzOffsetMinutes: number): Segment[] {
  const dayEnd = dayStart + 24 * HOUR;
  const list: Segment[] = [];
  let t = dayStart;
  while (t < dayEnd) {
    const seg = segmentAt(programs, t, tzOffsetMinutes);
    if (seg.start >= dayStart) list.push(seg);
    t = seg.end;
  }
  return list;
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY = 24 * HOUR;

/** 按时区输出 HH:mm（可带 :ss） */
export function formatClock(t: number, tzOffsetMinutes: number, withSeconds = false): string {
  const d = new Date(t + tzOffsetMinutes * 60000);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withSeconds ? `${hm}:${pad(d.getUTCSeconds())}` : hm;
}

/** 该时区当天零点（UTC 毫秒） */
export function dayStartOf(t: number, tzOffsetMinutes: number): number {
  const tz = tzOffsetMinutes * 60000;
  return Math.floor((t + tz) / DAY) * DAY - tz;
}

/** 日期页签文字：今天 / 昨天 / 明天 + 月-日，更早的是 月-日 + 周几 */
export function dayLabel(dayStart: number, todayStart: number, tzOffsetMinutes: number): { main: string; sub: string } {
  const d = new Date(dayStart + tzOffsetMinutes * 60000);
  const md = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const diff = Math.round((dayStart - todayStart) / DAY);
  if (diff === 0) return { main: '今天', sub: md };
  if (diff === -1) return { main: '昨天', sub: md };
  if (diff === 1) return { main: '明天', sub: md };
  return { main: md, sub: WEEKDAYS[d.getUTCDay()] };
}

/** 时长 m:ss，超过一小时 h:mm:ss */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 回看请求的时间窗口；整段都不可回看（未开始 / 超出可回看时长）返回 null。
 * 不限制单次时长：服务器只返回一部分（如咪咕最多 8 小时）时，播放器加载后按实际时长修正结束时间。
 */
export function playbackWindow(seg: Segment, now: number, maxAge = CATCHUP_MAX_AGE): { start: number; end: number } | null {
  const start = Math.max(seg.start, now - maxAge + MAX_AGE_MARGIN);
  const end = Math.min(seg.end, now - LIVE_GUARD);
  return end > start ? { start, end } : null;
}
