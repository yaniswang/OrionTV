import { buildCatchupUrl, catchupTemplate } from '../catchup';

const SOURCE = '?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}';
const bj = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);

describe('buildCatchupUrl', () => {
  it('append：在直播地址后拼回放参数，时间按给定时区格式化', () => {
    const url = buildCatchupUrl('https://a/u/651632648', { mode: 'append', source: SOURCE }, bj(2026, 11, 8, 23, 51), bj(2026, 11, 9, 0, 33), 480);
    expect(url).toBe('https://a/u/651632648?playbackbegin=20261108235100&playbackend=20261109003300');
  });

  it('append：直播地址已带查询参数时，用 & 连接', () => {
    const url = buildCatchupUrl('https://a/x?token=1', { mode: 'append', source: SOURCE }, bj(2026, 11, 9, 9, 58, 55), bj(2026, 11, 9, 10, 3, 55), 480);
    expect(url).toBe('https://a/x?token=1&playbackbegin=20261109095855&playbackend=20261109100355');
  });

  it('default：回放参数本身就是完整地址', () => {
    const url = buildCatchupUrl('https://a/x', { mode: 'default', source: 'https://b/x?s=${(b)yyyyMMddHHmmss}' }, bj(2026, 11, 9, 1, 2, 3), bj(2026, 11, 9, 2, 0), 480);
    expect(url).toBe('https://b/x?s=20261109010203');
  });

  it('catchupTemplate：只拼地址不填时间（交给原生时移代理反复填）', () => {
    expect(catchupTemplate('https://a/x', { mode: 'append', source: SOURCE })).toBe(`https://a/x${SOURCE}`);
    expect(catchupTemplate('https://a/x?token=1', { mode: 'append', source: SOURCE })).toBe(`https://a/x?token=1&${SOURCE.slice(1)}`);
    expect(catchupTemplate('https://a/x', { mode: 'default', source: 'https://b/x?s=${(b)yyyyMMddHHmmss}' })).toBe('https://b/x?s=${(b)yyyyMMddHHmmss}');
  });

  it('时区不同，同一时刻格式化结果不同', () => {
    const url = buildCatchupUrl('https://a/x', { mode: 'append', source: SOURCE }, bj(2026, 11, 9, 8, 0), bj(2026, 11, 9, 9, 0), 0);
    expect(url).toBe('https://a/x?playbackbegin=20261109000000&playbackend=20261109010000');
  });
});
