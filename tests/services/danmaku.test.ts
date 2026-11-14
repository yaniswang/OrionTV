/** @jest-environment node */

import {
  fetchDanmakuComments,
  fetchDanmakuBangumiEpisodes,
  formatDanmakuEpisodeTitle,
  parseDanmakuComment,
  parseDanmakuComments,
  sortDanmakuAnimeCandidates,
  type DanmakuAnime,
} from "@/services/danmaku";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const respond = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(data)),
  });

describe("danmaku service", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("解析弹弹play的 p/m 字段", () => {
    expect(parseDanmakuComment({ p: "12.50,1,16777215,abc", m: "  前方高能  " })).toEqual({
      time: 12.5,
      text: "前方高能",
      color: "#ffffff",
      mode: 1,
    });
    expect(parseDanmakuComment({ p: "3,1,16711680", m: "红色" })?.color).toBe("#ff0000");
    expect(parseDanmakuComment({ p: "1,1,0", m: "   " })).toBeNull();
  });

  it("按时间排序", () => {
    const result = parseDanmakuComments([
      { p: "5,1,0", m: "b" },
      { p: "1,1,0", m: "a" },
    ]);
    expect(result.map((item) => item.text)).toEqual(["a", "b"]);
  });

  it("剧集标题展示：去掉平台前缀，标题已含集号时不重复", () => {
    expect(
      formatDanmakuEpisodeTitle({ episodeTitle: "【bilibili1】 第27话 魔道争锋6", episodeNumber: 27 }),
    ).toBe("第27话 魔道争锋6");
    expect(formatDanmakuEpisodeTitle({ episodeTitle: "【qq】 白日提灯 相守结局", episodeNumber: 41 })).toBe(
      "第41集 白日提灯 相守结局",
    );
    expect(formatDanmakuEpisodeTitle({ episodeTitle: "【qq】 小剧场EP01" })).toBe("小剧场EP01");
  });

  it("按年份、集数接近度、正差和原始顺序排序", () => {
    const animes: DanmakuAnime[] = [
      { animeId: 1, animeTitle: "不同年份同集数", startDate: "2021-01-01", episodeCount: 41 },
      { animeId: 2, animeTitle: "同年集数不足", startDate: "2020-01-01", episodeCount: 30 },
      { animeId: 3, animeTitle: "同年集数相同", startDate: "2020-01-01", episodeCount: 41 },
      { animeId: 4, animeTitle: "同年集数较多", startDate: "2020-01-01", episodeCount: 65 },
      { animeId: 5, animeTitle: "同年集数略多", startDate: "2020-01-01", episodeCount: 50 },
      { animeId: 6, animeTitle: "缺少年份同集数", episodeCount: 41 },
      { animeId: 7, animeTitle: "缺集数", startDate: "2021-01-01" },
      { animeId: 8, animeTitle: "不同年份同集数后续", startDate: "2021-01-01", episodeCount: 41 },
    ];

    expect(
      sortDanmakuAnimeCandidates(animes, "2020", 41).map((anime) => anime.animeId),
    ).toEqual([3, 5, 2, 4, 1, 6, 8, 7]);
  });

  it("集数绝对差优先，同差值时正差优先于负差", () => {
    const animes: DanmakuAnime[] = [
      { animeId: 10, animeTitle: "集数相同", startDate: "2020-01-01", episodeCount: 41 },
      { animeId: 11, animeTitle: "正差9", startDate: "2020-01-01", episodeCount: 50 },
      { animeId: 12, animeTitle: "负差11", startDate: "2020-01-01", episodeCount: 30 },
      { animeId: 13, animeTitle: "正差4", startDate: "2020-01-01", episodeCount: 45 },
      { animeId: 14, animeTitle: "正差59", startDate: "2020-01-01", episodeCount: 100 },
      { animeId: 15, animeTitle: "负差5", startDate: "2020-01-01", episodeCount: 36 },
      { animeId: 16, animeTitle: "正差5", startDate: "2020-01-01", episodeCount: 46 },
    ];

    expect(
      sortDanmakuAnimeCandidates(animes, "2020", 41).map((anime) => anime.animeId),
    ).toEqual([10, 13, 16, 15, 11, 12, 14]);
  });

  it("通过 bangumi 接口获取剧集", async () => {
    fetchMock.mockReturnValueOnce(
      respond({
        success: true,
        bangumi: {
          animeId: 11,
          animeTitle: "白日提灯(2026)【国产剧】from tencent",
          episodes: [{ episodeId: 101, episodeTitle: "第1集", episodeNumber: "1" }],
        },
      }),
    );

    const episodes = await fetchDanmakuBangumiEpisodes(
      "https://danmu.example.com/token",
      11,
    );

    expect(episodes.map((item) => item.episodeId)).toEqual([101]);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v2/bangumi/11");
  });

  it("最终通过命中集的 episodeId 请求弹幕", async () => {
    fetchMock.mockReturnValueOnce(
      respond({
        success: true,
        videoDuration: 1154,
        comments: [{ p: "1.5,1,16777215,[bilibili1]", m: "测试弹幕" }],
      }),
    );

    const result = await fetchDanmakuComments(
      "https://danmu.example.com/token",
      10007,
    );

    expect(result.comments).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://danmu.example.com/token/api/v2/comment/10007?format=json&duration=true",
    );
  });
});
