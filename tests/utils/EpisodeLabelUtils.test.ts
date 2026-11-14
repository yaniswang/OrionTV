import {
  getEpisodeDisplayOrder,
  getEpisodeGroups,
  getEpisodeRecordInfo,
  getEpisodeTotal,
  getRecordEpisodeBadge,
} from "@/utils/EpisodeLabelUtils";

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `第${from + i}集`);

// 魔都动漫《凡人修仙传》：200 集正片 + 2 条特别篇（第125、126条）
const modu = [...range(1, 124), "虚天战纪", "虚天战纪下", ...range(125, 200)];

describe("片源集数", () => {
  it("取标题里的最大集号，特别篇不算", () => {
    expect(modu).toHaveLength(202);
    expect(getEpisodeTotal(modu, 202)).toBe(200);
  });

  it("总第N集优先", () => {
    expect(getEpisodeTotal(["第01集【总第125集】", "第52集【总第176集】"], 2)).toBe(176);
  });

  it("解析不出集号时用条数", () => {
    expect(getEpisodeTotal(["采访1", "采访2", "采访3"], 3)).toBe(3);
    expect(getEpisodeTotal(undefined, 12)).toBe(12);
    expect(getEpisodeTotal(["", ""], 2)).toBe(2);
  });

  it("单集电影", () => {
    expect(getEpisodeTotal(["正片"], 1)).toBe(1);
  });

  it("综艺日期期号不当作集数", () => {
    expect(getEpisodeTotal(["第20221209期", "第20221216期"], 2)).toBe(2);
  });
});

describe("选集显示顺序", () => {
  it("没有集号的特别篇放到最后，正片保持原顺序", () => {
    const order = getEpisodeDisplayOrder(modu);
    expect(order).toHaveLength(202);
    expect(order.slice(122, 126)).toEqual([122, 123, 126, 127]); // 第123、124集后面直接接第125集
    expect(order.slice(-2)).toEqual([124, 125]); // 虚天战纪、虚天战纪下
  });

  it("整个列表都没有集号时保持原顺序", () => {
    expect(getEpisodeDisplayOrder(["采访1", "花絮", "采访2"])).toEqual([0, 1, 2]);
  });
});

describe("选集分组", () => {
  it("正片按集号每 30 集一组，特别篇单独放进最后的其它组", () => {
    const groups = getEpisodeGroups(modu, 30);
    expect(groups.map((group) => group.label)).toEqual([
      "1-30", "31-60", "61-90", "91-120", "121-150", "151-180", "181-200", "其它",
    ]);
    expect(groups[4].indices.slice(3, 6)).toEqual([123, 126, 127]); // 第124集后面直接接第125集
    expect(groups[6].indices).toHaveLength(20);
    expect(groups[7].indices).toEqual([124, 125]); // 虚天战纪、虚天战纪下
  });

  it("没有特别篇时不出现其它组", () => {
    expect(getEpisodeGroups(range(1, 31), 30).map((group) => group.label)).toEqual(["1-30", "31"]);
  });

  it("整个列表都没有集号时按位置分组", () => {
    const list = Array.from({ length: 32 }, (_, i) => `采访${i + 1}`);
    expect(getEpisodeGroups(list, 30).map((group) => group.label)).toEqual(["1-30", "31-32"]);
  });
});

describe("播放记录分集信息与卡片角标", () => {
  it("正片：真实集号/集数", () => {
    const info = getEpisodeRecordInfo(modu, 201, 202); // 魔都最后一条：第200集
    expect(info).toEqual({ episode_title: "第200集", episode_number: 200, episode_total: 200 });
    expect(getRecordEpisodeBadge(info)).toBe("200/200");
  });

  it("番外：显示原始标题", () => {
    const bairi = ["相守结局", ...range(1, 40)]; // 金鹰：相守结局排在第一条
    const info = getEpisodeRecordInfo(bairi, 0, 41);
    expect(info).toEqual({ episode_title: "相守结局", episode_number: null, episode_total: 40 });
    expect(getRecordEpisodeBadge(info)).toBe("相守结局");
  });

  it("电影（只有一集）不显示角标", () => {
    expect(getRecordEpisodeBadge(getEpisodeRecordInfo(["正片"], 0, 1))).toBe("");
    expect(getRecordEpisodeBadge(getEpisodeRecordInfo(["HD国语", "HD中字"], 1, 2))).toBe("");
  });

  it("标题列表和播放列表条数对不上时不写，按原来的方式显示", () => {
    expect(getEpisodeRecordInfo(modu, 0, 200)).toEqual({});
    expect(getRecordEpisodeBadge({})).toBeUndefined();
    expect(getRecordEpisodeBadge(undefined)).toBeUndefined();
  });
});
