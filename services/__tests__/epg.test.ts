import { parseXmltv, parseXmltvAsync, findChannelPrograms, programIndexAt } from '../epg';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
    <channel id="CCTV1综合">
        <display-name lang="zh">CCTV1综合</display-name>
    </channel>
    <channel id="cctv5">
        <display-name lang="zh">CCTV5体育</display-name>
    </channel>
    <programme channel="CCTV1综合" start="20261109110100 +0800" stop="20261109114700 +0800">
        <title lang="zh">江海潮生第24集</title>
    </programme>
    <programme channel="CCTV1综合" start="20261109101200 +0800" stop="20261109110100 +0800">
        <title lang="zh">江海潮生第23集</title>
    </programme>
    <programme channel="cctv5" start="20261109103100 +0800" stop="20261109115500 +0800">
        <title lang="zh">A &amp; B &lt;决赛&gt; &#39;x&#39;</title>
    </programme>
    <programme channel="CCTV1综合" start="bad" stop="20261109120000 +0800">
        <title lang="zh">坏数据</title>
    </programme>
</tv>`;

// 北京时间 → UTC 毫秒
const bj = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 8, mi);

describe('parseXmltv', () => {
  const epg = parseXmltv(XML);

  it('按频道 id 归组、按开始时间排序，时间换算成 UTC 毫秒', () => {
    const list = epg.programs.get('CCTV1综合')!;
    expect(list.map((p) => p.title)).toEqual(['江海潮生第23集', '江海潮生第24集']);
    expect(list[0].start).toBe(bj(2026, 11, 9, 10, 12));
    expect(list[0].end).toBe(bj(2026, 11, 9, 11, 1));
  });

  it('解码标题里的 XML 实体', () => {
    expect(epg.programs.get('cctv5')![0].title).toBe("A & B <决赛> 'x'");
  });

  it('丢弃时间格式不对的节目', () => {
    expect(epg.programs.get('CCTV1综合')!.some((p) => p.title === '坏数据')).toBe(false);
  });

  it('记录节目单时区（分钟）', () => {
    expect(epg.tzOffsetMinutes).toBe(480);
  });

  it('display-name 也能作为频道名查到节目', () => {
    expect(epg.nameToId.get('CCTV5体育')).toBe('cctv5');
  });
});

describe('parseXmltvAsync', () => {
  it('分片解析（每片 0ms，强制每批都让出）结果与同步解析一致', async () => {
    const big = XML.replace('</tv>', XML.match(/<programme[\s\S]*<\/programme>/)![0].repeat(300) + '</tv>');
    const sync = parseXmltv(big);
    const async = await parseXmltvAsync(big, 0);
    expect(Array.from(async.programs.entries())).toEqual(Array.from(sync.programs.entries()));
    expect(Array.from(async.nameToId.entries())).toEqual(Array.from(sync.nameToId.entries()));
    expect(async.tzOffsetMinutes).toBe(sync.tzOffsetMinutes);
  });
});

describe('findChannelPrograms', () => {
  const epg = parseXmltv(XML);

  it('优先 tvg-id', () => {
    expect(findChannelPrograms(epg, { tvgId: 'cctv5', tvgName: 'x', name: 'y' })![0].start).toBe(bj(2026, 11, 9, 10, 31));
  });

  it('tvg-id 对不上时用 tvg-name，再用频道名（含 display-name）', () => {
    expect(findChannelPrograms(epg, { tvgId: 'none', tvgName: 'CCTV1综合', name: 'y' })).toHaveLength(2);
    expect(findChannelPrograms(epg, { name: 'CCTV5体育' })).toHaveLength(1);
  });

  it('都对不上返回 undefined', () => {
    expect(findChannelPrograms(epg, { name: '成都少儿' })).toBeUndefined();
  });
});

describe('programIndexAt', () => {
  const list = parseXmltv(XML).programs.get('CCTV1综合')!;

  it('返回包含该时刻的节目下标，开始含、结束不含', () => {
    expect(programIndexAt(list, bj(2026, 11, 9, 11, 10))).toBe(1);
    expect(programIndexAt(list, bj(2026, 11, 9, 11, 1))).toBe(1);
    expect(programIndexAt(list, bj(2026, 11, 9, 10, 12))).toBe(0);
  });

  it('不在任何节目里返回 -1', () => {
    expect(programIndexAt(list, bj(2026, 11, 9, 9, 0))).toBe(-1);
    expect(programIndexAt(list, bj(2026, 11, 9, 11, 47))).toBe(-1);
  });
});
