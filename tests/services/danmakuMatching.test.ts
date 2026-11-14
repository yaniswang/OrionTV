/** @jest-environment node */

import {
  buildDanmakuSources,
  parsePlaybackEpisodeNumber,
  parsePlaybackEpisodeNumbers,
  resolveEpisodeForSearch,
  romanFallbackKeyword,
  type DanmakuAnime,
  type DanmakuEpisode,
} from "@/services/danmaku";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const BASE = "https://danmu.example.com/token";

const respond = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(data)),
  });

const ep = (episodeId: number, episodeTitle: string, url = `https://v.example.com/${episodeId}.html`): DanmakuEpisode => ({
  episodeId,
  episodeTitle,
  url,
});

/** 按 URL 路由的接口桩：search 按关键词、bangumi 按 animeId */
const mockApi = (
  searches: Record<string, Partial<DanmakuAnime>[]>,
  bangumis: Record<number, DanmakuEpisode[]>,
) => {
  fetchMock.mockImplementation((url: string) => {
    const search = url.match(/search\/anime\?keyword=([^&]+)/);
    if (search) {
      const keyword = decodeURIComponent(search[1]);
      return respond({ success: true, animes: searches[keyword] || [] });
    }
    const bangumi = url.match(/bangumi\/(\d+)/);
    if (bangumi) {
      const animeId = Number(bangumi[1]);
      return respond({
        success: true,
        bangumi: { animeId, animeTitle: "", episodes: bangumis[animeId] || [] },
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
};

const requestedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

describe("片源集号解析", () => {
  it.each([
    ["第01集【总第125集】", 0, 52, 125],
    ["第001集", 0, 200, 1],
    ["第30集完结", 29, 30, 30],
    ["第12集已完结", 11, 12, 12],
    ["第5集.", 4, 52, 5],
    ["第12话", 11, 24, 12],
    ["01", 0, 30, 1],
    ["EP07", 6, 12, 7],
    ["正片", 0, 1, 1],
    ["HD中字", 0, 1, 1],
  ])("%s -> %d", (title, index, total, expected) => {
    expect(parsePlaybackEpisodeNumber(title, index, total)).toBe(expected);
  });

  it.each([
    ["第1-20集", 0, 4],
    ["第61-80集完结", 3, 4],
    ["全集", 0, 2],
    ["采访1", 0, 13],
    ["独家花絮1", 0, 6],
    ["小剧场EP01", 0, 3],
    ["正片", 0, 3],
  ])("%s 不是可匹配的正片", (title, index, total) => {
    expect(parsePlaybackEpisodeNumber(title, index, total)).toBeNull();
  });

  it("没有分集标题时按位置", () => {
    expect(parsePlaybackEpisodeNumber("", 7, 30)).toBe(8);
    expect(parsePlaybackEpisodeNumber(undefined, 0, 30)).toBe(1);
  });

  it("开头是数字加集/话，没有第字", () => {
    expect(parsePlaybackEpisodeNumber("001集：英雄之子是废物？", 0, 184)).toBe(1);
    expect(parsePlaybackEpisodeNumber("12集蛋生的孩子", 11, 132)).toBe(12);
  });

  it("第N 后面没有集字", () => {
    expect(parsePlaybackEpisodeNumber("第18", 17, 25)).toBe(18);
  });
});

describe("片源整列表集号解析", () => {
  it("多版本电影都算第 1 集", () => {
    expect(parsePlaybackEpisodeNumbers(["HD国语", "HD中字"])).toEqual([1, 1]);
    expect(parsePlaybackEpisodeNumbers(["HD国语", "HD双语", "HD中字"])).toEqual([1, 1, 1]);
  });

  it("分上中下部的电影不算", () => {
    expect(parsePlaybackEpisodeNumbers(["上", "中", "下"])).toEqual([null, null, null]);
    expect(parsePlaybackEpisodeNumbers(["HD上", "HD下"])).toEqual([null, null]);
  });

  it("标题都一样的是连续剧，不算多版本", () => {
    expect(parsePlaybackEpisodeNumbers(["AI中字", "AI中字", "AI中字"])).toEqual([null, null, null]);
  });

  it("超过 3 条没有集号的列表不算多版本", () => {
    expect(parsePlaybackEpisodeNumbers(["甲", "乙", "丙", "丁"])).toEqual([null, null, null, null]);
  });

  it("预告不算，正片算第 1 集", () => {
    expect(parsePlaybackEpisodeNumbers(["正片", "预告片"])).toEqual([1, null]);
  });

  it("有集号的列表逐条解析，与单条解析一致", () => {
    const titles = ["第1集", "虚天战纪", "第2集", ""];
    expect(parsePlaybackEpisodeNumbers(titles)).toEqual([1, null, 2, 4]);
  });
});

describe("罗马数字兜底关键词", () => {
  it("中文之间的英文罗马数字换成全角", () => {
    expect(romanFallbackKeyword("斗罗大陆II绝世唐门")).toBe("斗罗大陆Ⅱ绝世唐门");
    expect(romanFallbackKeyword("某剧III")).toBe("某剧Ⅲ");
  });

  it("英文片名和阿拉伯数字不动", () => {
    expect(romanFallbackKeyword("Running Man II")).toBe("Running Man II");
    expect(romanFallbackKeyword("斗罗大陆2绝世唐门")).toBe("斗罗大陆2绝世唐门");
  });
});

describe("弹幕源整理", () => {
  const anime = (source: string, animeTitle = "测试"): DanmakuAnime => ({ animeId: 1, animeTitle, source });

  it("B 站乱序、重制版和预告：集号取标题，预告归为番外", () => {
    const [source] = buildDanmakuSources(anime("bilibili"), [
      ep(10489, "【bilibili1】 第22话 魔道争锋1"),
      ep(10540, "【bilibili1】 第1话 凡人风起天南1重制版"),
      ep(10561, "【bilibili1】 第73话 星海飞驰序章1"),
      ep(10613, "【bilibili1】 星海飞驰第1集预告"),
    ]);
    expect(source.platform).toBe("bilibili");
    expect(source.byNumber.get(1)?.episodeId).toBe(10540);
    expect(source.byNumber.get(22)?.episodeId).toBe(10489);
    expect(source.byNumber.get(73)?.episodeId).toBe(10561);
    expect(source.extras.map((item) => item.episodeId)).toEqual([10613]);
    // 正片按集号排序
    expect(source.main.map((item) => item.number)).toEqual([1, 22, 73]);
  });

  it("360 多平台拼接：按标题前缀拆成多个平台，集号各自从 1 开始", () => {
    const sources = buildDanmakuSources(anime("360"), [
      ep(12536, "【qiyi】 第1集"),
      ep(12537, "【qiyi】 第2集"),
      ep(12582, "【qq】 第1集"),
      ep(12583, "【qq】 第2集"),
    ]);
    expect(sources.map((item) => item.platform)).toEqual(["qq", "qiyi"]);
    const qq = sources.find((item) => item.platform === "qq");
    expect(qq?.byNumber.get(1)?.episodeId).toBe(12582);
    expect(qq?.isBackup).toBe(true);
  });

  it("没有集号的结局集保持原样，不编集号；小剧场和采访归为番外", () => {
    const [source] = buildDanmakuSources(anime("tencent"), [
      ep(10082, "【qq】 白日提灯 第40集 思胥万千归墟大婚哭成泪人"),
      ep(10083, "【qq】 白日提灯 相守结局"),
      ep(10084, "【qq】 小剧场EP01"),
      ep(10089, "【qq】 采访13"),
    ]);
    expect(source.byNumber.has(41)).toBe(false);
    expect(source.main.map((item) => item.number)).toEqual([40]);
    expect(source.extras.map((item) => item.episodeId)).toEqual([10083, 10084, 10089]);
  });

  it("集号重复时取第一条，混入的别的系列不覆盖正片", () => {
    const [source] = buildDanmakuSources(anime("tencent"), [
      ep(1, "【qq】 斗罗大陆Ⅱ绝世唐门 第1话"),
      ep(180, "【qq】 斗罗大陆Ⅱ绝世唐门 斗罗大陆·戴沐白篇第1集"),
    ]);
    expect(source.byNumber.get(1)?.episodeId).toBe(1);
  });

  it("整组都没有集号时按位置编号", () => {
    const [source] = buildDanmakuSources(anime("renren"), [ep(1, "【renren】 AI中字"), ep(2, "【renren】 AI中字")]);
    expect(source.byNumber.get(2)?.episodeId).toBe(2);
  });
});

describe("自动匹配", () => {
  beforeEach(() => fetchMock.mockReset());

  it("年份必须相同：没有同年份候选时不匹配，也不取剧集列表", async () => {
    mockApi({ 大主宰年番: [{ animeId: 1, animeTitle: "大主宰年番(2023)【3D动漫】from iqiyi", startDate: "2023-01-01", source: "iqiyi", episodeCount: 99 }] }, {});
    const match = await resolveEpisodeForSearch(BASE, "大主宰年番", 0, { year: "2022", episodeCount: 99, episodeNumber: 1 });
    expect(match).toBeNull();
    expect(requestedUrls().some((url) => url.includes("/bangumi/"))).toBe(false);
  });

  it("片源没有年份时不自动匹配", async () => {
    mockApi({}, {});
    const match = await resolveEpisodeForSearch(BASE, "某剧", 0, { year: "unknown", episodeNumber: 1 });
    expect(match).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("剧名相同时原站优先于 360", async () => {
    mockApi(
      {
        白日提灯: [
          { animeId: 360, animeTitle: "白日提灯(2026)【电视剧】from 360", startDate: "2026-01-01", source: "360", episodeCount: 41 },
          { animeId: 869117, animeTitle: "白日提灯(2026)【国产剧】from tencent", startDate: "2026-01-01", source: "tencent", episodeCount: 65 },
        ],
      },
      {
        360: [ep(10041, "【qq】 第41集")],
        869117: [ep(10082, "【qq】 白日提灯 第40集"), ep(10083, "【qq】 白日提灯 相守结局"), ep(10084, "【qq】 小剧场EP01")],
      },
    );
    const match = await resolveEpisodeForSearch(BASE, "白日提灯", 39, { year: "2026", episodeCount: 41, episodeNumber: 40 });
    expect(match).toMatchObject({ episodeId: 10082, animeId: 869117, episodeNumber: 40, platform: "qq", source: "tencent" });
  });

  it("原站没有当前集时用 360 备份", async () => {
    mockApi(
      {
        凡人修仙传: [
          { animeId: 2208394, animeTitle: "凡人修仙传(2020)【动漫】from bilibili", startDate: "2020-01-01", source: "bilibili", episodeCount: 3 },
          { animeId: 243158, animeTitle: "凡人修仙传(2020)【动漫】from 360", startDate: "2020-01-01", source: "360", episodeCount: 5 },
        ],
      },
      {
        2208394: [ep(1, "【bilibili1】 第1话"), ep(2, "【bilibili1】 第2话"), ep(3, "【bilibili1】 第3话")],
        243158: [1, 2, 3, 4, 5].map((n) => ep(100 + n, `【bilibili1】 第${n}集`)),
      },
    );
    const match = await resolveEpisodeForSearch(BASE, "凡人修仙传", 4, { year: "2020", episodeCount: 5, episodeNumber: 5 });
    expect(match).toMatchObject({ episodeId: 105, animeId: 243158, platform: "bilibili", source: "360" });
  });

  it("360 拼接列表按平台优先级选 B 站", async () => {
    mockApi(
      { 咒术回战: [{ animeId: 229700, animeTitle: "咒术回战(2020)【动漫】from 360", startDate: "2020-01-01", source: "360", episodeCount: 96 }] },
      {
        229700: [
          ep(1, "【imgo】 第3集"),
          ep(25, "【youku】 第3集"),
          ep(49, "【qiyi】 第3集"),
          ep(73, "【bilibili1】 第3集"),
        ],
      },
    );
    const match = await resolveEpisodeForSearch(BASE, "咒术回战", 2, { year: "2020", episodeCount: 24, episodeNumber: 3 });
    expect(match).toMatchObject({ episodeId: 73, platform: "bilibili", episodeNumber: 3 });
  });

  it("剧名不同的原站衍生作品不会抢在同名 360 之前", async () => {
    mockApi(
      {
        "长相思 第二季": [
          { animeId: 1, animeTitle: "长相思 动态漫画(2024)【2D动漫】from iqiyi", startDate: "2024-01-01", source: "iqiyi", episodeCount: 24 },
          { animeId: 2, animeTitle: "长相思 第二季(2024)【电视剧】from 360", startDate: "2024-01-01", source: "360", episodeCount: 23 },
        ],
      },
      { 1: [ep(11, "【qiyi】 第5集")], 2: [ep(21, "【qq】 第5集")] },
    );
    const match = await resolveEpisodeForSearch(BASE, "长相思 第二季", 4, { year: "2024", episodeCount: 24, episodeNumber: 5 });
    expect(match?.animeId).toBe(2);
  });

  it("没有同名候选时按集数最接近的候选", async () => {
    mockApi(
      {
        凡人修仙传第一季: [
          { animeId: 1, animeTitle: "凡人修仙传 解说版(2020)【电视剧】from 360", startDate: "2020-01-01", source: "360", episodeCount: 2 },
          { animeId: 2, animeTitle: "凡人修仙传(2020)【动漫】from 360", startDate: "2020-01-01", source: "360", episodeCount: 17 },
        ],
      },
      { 1: [ep(11, "【youku】 第3集")], 2: [ep(23, "【bilibili1】 第3集")] },
    );
    const match = await resolveEpisodeForSearch(BASE, "凡人修仙传第一季", 2, { year: "2020", episodeCount: 17, episodeNumber: 3 });
    expect(match?.episodeId).toBe(23);
  });

  it("搜不到同年份候选时用罗马数字兜底再搜一次", async () => {
    mockApi(
      {
        "斗罗大陆Ⅱ绝世唐门": [
          { animeId: 7, animeTitle: "斗罗大陆Ⅱ绝世唐门(2023)【3D动漫】from tencent", startDate: "2023-01-01", source: "tencent", episodeCount: 185 },
        ],
      },
      { 7: [ep(71, "【qq】 斗罗大陆Ⅱ绝世唐门 第1话")] },
    );
    const match = await resolveEpisodeForSearch(BASE, "斗罗大陆II绝世唐门", 0, { year: "2023", episodeCount: 185, episodeNumber: 1 });
    expect(match?.episodeId).toBe(71);
    expect(requestedUrls().filter((url) => url.includes("search/anime"))).toHaveLength(2);
  });

  it("片源没有集号也没有标题时不匹配", async () => {
    mockApi({}, {});
    const match = await resolveEpisodeForSearch(BASE, "某剧", 0, { year: "2020", episodeNumber: null });
    expect(match).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const bairiSearch = {
    白日提灯: [
      { animeId: 360, animeTitle: "白日提灯(2026)【电视剧】from 360", startDate: "2026-01-01", source: "360", episodeCount: 41 },
      { animeId: 869117, animeTitle: "白日提灯(2026)【国产剧】from tencent", startDate: "2026-01-01", source: "tencent", episodeCount: 65 },
    ],
  };
  const bairiBangumi = {
    360: [ep(10040, "【qq】 第40集"), ep(10041, "【qq】 第41集")],
    869117: [
      ep(10082, "【qq】 白日提灯 第40集 思胥万千归墟大婚哭成泪人"),
      ep(10083, "【qq】 白日提灯 相守结局"),
      ep(10084, "【qq】 小剧场EP01"),
    ],
  };

  it("番外在番外里按名称找：相守结局", async () => {
    mockApi(bairiSearch, bairiBangumi);
    const match = await resolveEpisodeForSearch(BASE, "白日提灯", 0, {
      year: "2026",
      episodeCount: 41,
      episodeNumber: null,
      episodeTitle: "相守结局",
    });
    expect(match).toMatchObject({ episodeId: 10083, platform: "qq", source: "tencent" });
    expect(match?.episodeNumber).toBeUndefined();
  });

  it("番外名称比较忽略空格和标点", async () => {
    mockApi(bairiSearch, bairiBangumi);
    const match = await resolveEpisodeForSearch(BASE, "白日提灯", 41, {
      year: "2026",
      episodeCount: 44,
      episodeNumber: null,
      episodeTitle: "小剧场 EP01",
    });
    expect(match?.episodeId).toBe(10084);
  });

  it("番外不会去正片里找，找不到同名番外就不匹配", async () => {
    mockApi(bairiSearch, bairiBangumi);
    const match = await resolveEpisodeForSearch(BASE, "白日提灯", 0, {
      year: "2026",
      episodeCount: 41,
      episodeNumber: null,
      episodeTitle: "思胥万千归墟大婚哭成泪人",
    });
    expect(match).toBeNull();
  });
});

describe("手动选择记忆", () => {
  beforeEach(() => fetchMock.mockReset());

  const tencentList = [
    ep(1, "【qq】 第1集"),
    ep(2, "【qq】 第2集"),
    ep(3, "【qq】 第3集"),
    ep(4, "【qq】 第4集"),
    ep(5, "【qiyi】 第3集"),
  ];

  it("只选站点：在该平台按集号对齐，不再搜索", async () => {
    mockApi({}, { 214056: tencentList });
    const match = await resolveEpisodeForSearch(BASE, "庆余年", 2, {
      year: "2019",
      episodeNumber: 3,
      savedSelection: { animeId: 214056, animeTitle: "庆余年(2019)【电视剧】from 360", source: "360", platform: "qq", mode: "auto", version: 2 },
    });
    expect(match).toMatchObject({ episodeId: 3, platform: "qq", episodeNumber: 3 });
    expect(requestedUrls().some((url) => url.includes("search/anime"))).toBe(false);
  });

  it("固定偏移：播放第 3 集对应弹幕第 1 集，之后换集保持偏移", async () => {
    mockApi({}, { 214056: tencentList });
    const savedSelection = {
      animeId: 214056,
      animeTitle: "庆余年(2019)【电视剧】from 360",
      source: "360",
      platform: "qq",
      mode: "offset" as const,
      episodeId: 1,
      episodeNumber: 1,
      playbackEpisodeNumber: 3,
      version: 2 as const,
    };
    const same = await resolveEpisodeForSearch(BASE, "庆余年", 2, { year: "2019", episodeNumber: 3, savedSelection });
    const next = await resolveEpisodeForSearch(BASE, "庆余年", 5, { year: "2019", episodeNumber: 6, savedSelection });
    expect(same?.episodeId).toBe(1);
    expect(next?.episodeId).toBe(4);
  });

  it("固定偏移超出范围时不匹配，也不退回自动搜索", async () => {
    mockApi({}, { 214056: tencentList });
    const match = await resolveEpisodeForSearch(BASE, "庆余年", 9, {
      year: "2019",
      episodeNumber: 10,
      savedSelection: { animeId: 214056, animeTitle: "x", platform: "qq", mode: "offset", episodeNumber: 1, playbackEpisodeNumber: 3, version: 2 },
    });
    expect(match).toBeNull();
    expect(requestedUrls().some((url) => url.includes("search/anime"))).toBe(false);
  });

  it("旧版记忆（偏移按列表位置算）只保留番剧，按集号自动对齐", async () => {
    mockApi({}, { 214056: tencentList });
    const match = await resolveEpisodeForSearch(BASE, "庆余年", 2, {
      year: "2019",
      episodeNumber: 3,
      savedSelection: { animeId: 214056, animeTitle: "x", source: "360", episodeNumber: 49, playbackEpisodeNumber: 1 },
    });
    // 没有平台信息时按平台优先级：腾讯优先于爱奇艺
    expect(match).toMatchObject({ episodeId: 3, platform: "qq" });
  });
});
