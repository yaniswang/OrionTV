import { EpgProgram } from '../epg';
import { segmentAt, nextSegment, prevSegment, daySegments, playbackWindow, HOUR, LIVE_GUARD, CATCHUP_MAX_AGE, formatClock, dayStartOf, dayLabel, formatDuration } from '../liveTimeline';

const TZ = 480;
const bj = (d: number, h: number, mi = 0, s = 0) => Date.UTC(2026, 10, d, h - 8, mi, s);
const P = (s: number, e: number, title: string): EpgProgram => ({ start: s, end: e, title });

// 11-08 只有跨零点的一条；11-09 上午连续三条
const PROGRAMS: EpgProgram[] = [
  P(bj(8, 23, 51), bj(9, 0, 33), '三大队(6)'),
  P(bj(9, 9, 22), bj(9, 10, 12), '江海潮生第22集'),
  P(bj(9, 10, 12), bj(9, 11, 1), '江海潮生第23集'),
  P(bj(9, 11, 1), bj(9, 11, 47), '江海潮生第24集'),
];

describe('segmentAt', () => {
  it('落在节目里返回节目', () => {
    expect(segmentAt(PROGRAMS, bj(9, 10, 30), TZ)).toEqual({ start: bj(9, 10, 12), end: bj(9, 11, 1), title: '江海潮生第23集' });
  });

  it('没有节目时返回所在整点时段（按时区对齐）', () => {
    expect(segmentAt(PROGRAMS, bj(7, 19, 30), TZ)).toEqual({ start: bj(7, 19), end: bj(7, 20), title: null });
    expect(segmentAt(undefined, bj(9, 11, 10), TZ)).toEqual({ start: bj(9, 11), end: bj(9, 12), title: null });
  });

  it('整点时段被相邻节目截断', () => {
    expect(segmentAt(PROGRAMS, bj(8, 23, 10), TZ)).toEqual({ start: bj(8, 23), end: bj(8, 23, 51), title: null });
    expect(segmentAt(PROGRAMS, bj(9, 0, 40), TZ)).toEqual({ start: bj(9, 0, 33), end: bj(9, 1), title: null });
  });
});

describe('nextSegment / prevSegment', () => {
  it('节目之间连续切换', () => {
    const cur = segmentAt(PROGRAMS, bj(9, 10, 30), TZ);
    expect(nextSegment(PROGRAMS, cur, TZ).title).toBe('江海潮生第24集');
    expect(prevSegment(PROGRAMS, cur, TZ).title).toBe('江海潮生第22集');
  });

  it('节目和整点时段之间切换', () => {
    const first = segmentAt(PROGRAMS, bj(9, 9, 30), TZ);
    expect(prevSegment(PROGRAMS, first, TZ)).toEqual({ start: bj(9, 9), end: bj(9, 9, 22), title: null });
    const slot = segmentAt(PROGRAMS, bj(8, 23, 10), TZ);
    expect(nextSegment(PROGRAMS, slot, TZ).title).toBe('三大队(6)');
  });

  it('没有节目单时按整点切换', () => {
    const cur = segmentAt(undefined, bj(7, 19, 30), TZ);
    expect(nextSegment(undefined, cur, TZ)).toEqual({ start: bj(7, 20), end: bj(7, 21), title: null });
    expect(prevSegment(undefined, cur, TZ)).toEqual({ start: bj(7, 18), end: bj(7, 19), title: null });
  });
});

describe('daySegments', () => {
  it('完全没有节目的一天是 24 个整点时段', () => {
    const list = daySegments(PROGRAMS, bj(7, 0), TZ);
    expect(list).toHaveLength(24);
    expect(list[0]).toEqual({ start: bj(7, 0), end: bj(7, 1), title: null });
    expect(list.every((s) => s.title === null)).toBe(true);
  });

  it('只有少量节目的一天：整点时段 + 节目，跨零点的节目归开始那天', () => {
    const list = daySegments(PROGRAMS, bj(8, 0), TZ);
    expect(list).toHaveLength(25);
    expect(list[23]).toEqual({ start: bj(8, 23), end: bj(8, 23, 51), title: null });
    expect(list[24].title).toBe('三大队(6)');
  });

  it('次日开头被跨零点节目占住的部分不重复列出', () => {
    const list = daySegments(PROGRAMS, bj(9, 0), TZ);
    expect(list[0]).toEqual({ start: bj(9, 0, 33), end: bj(9, 1), title: null });
  });
});

describe('时间格式化', () => {
  it('formatClock 按时区输出时:分，可带秒', () => {
    expect(formatClock(bj(9, 7, 5, 9), TZ)).toBe('07:05');
    expect(formatClock(bj(9, 7, 5, 9), TZ, true)).toBe('07:05:09');
  });

  it('dayStartOf 返回该时区当天零点', () => {
    expect(dayStartOf(bj(9, 0, 10), TZ)).toBe(bj(9, 0));
    expect(dayStartOf(bj(9, 23, 59), TZ)).toBe(bj(9, 0));
  });

  it('dayLabel：今天 / 昨天 / 明天，其余为 月-日 + 周几', () => {
    const today = bj(9, 0);
    expect(dayLabel(today, today, TZ)).toEqual({ main: '今天', sub: '11-09' });
    expect(dayLabel(bj(8, 0), today, TZ)).toEqual({ main: '昨天', sub: '11-08' });
    expect(dayLabel(bj(10, 0), today, TZ)).toEqual({ main: '明天', sub: '11-10' });
    expect(dayLabel(bj(6, 0), today, TZ)).toEqual({ main: '11-06', sub: '周五' });
  });

  it('formatDuration：分:秒，超过一小时带小时', () => {
    expect(formatDuration(150 * 1000)).toBe('2:30');
    expect(formatDuration(49 * 60 * 1000)).toBe('49:00');
    expect(formatDuration(HOUR + 5 * 60 * 1000 + 3000)).toBe('1:05:03');
  });
});

describe('playbackWindow', () => {
  const now = bj(9, 11, 10);

  it('已播完的节目：整段', () => {
    expect(playbackWindow({ start: bj(9, 10, 12), end: bj(9, 11, 1), title: 'x' }, now)).toEqual({ start: bj(9, 10, 12), end: bj(9, 11, 1) });
  });

  it('正在播的节目：结束时间截到直播点前', () => {
    expect(playbackWindow({ start: bj(9, 11, 1), end: bj(9, 11, 47), title: 'x' }, now)).toEqual({ start: bj(9, 11, 1), end: now - LIVE_GUARD });
  });

  it('还没开始的节目不能播', () => {
    expect(playbackWindow({ start: bj(9, 11, 47), end: bj(9, 12), title: 'x' }, now)).toBeNull();
  });

  it('超出 7 天的部分截掉，完全超出返回 null', () => {
    const earliest = now - CATCHUP_MAX_AGE;
    const w = playbackWindow({ start: earliest - 30 * 60000, end: earliest + 30 * 60000, title: null }, now)!;
    expect(w.start).toBeGreaterThan(earliest);
    expect(w.end).toBe(earliest + 30 * 60000);
    expect(playbackWindow({ start: earliest - 2 * HOUR, end: earliest - HOUR, title: null }, now)).toBeNull();
  });

  it('长节目不截断：按段的完整起止请求（服务器只返回一部分时由实际时长修正）', () => {
    const w = playbackWindow({ start: bj(8, 0), end: bj(8, 12), title: 'x' }, now)!;
    expect(w).toEqual({ start: bj(8, 0), end: bj(8, 12) });
  });

  it('可回看天数按频道传入（catchup-days）', () => {
    const maxAge = 3 * 24 * HOUR;
    expect(playbackWindow({ start: bj(5, 20), end: bj(5, 21), title: null }, now, maxAge)).toBeNull();
    expect(playbackWindow({ start: bj(7, 20), end: bj(7, 21), title: null }, now, maxAge)).toEqual({ start: bj(7, 20), end: bj(7, 21) });
  });
});
