/** @jest-environment node */

import {
  fetchDanmakuComments,
  fetchDanmakuBangumiEpisodes,
  formatDanmakuEpisodeTitle,
  getDanmakuEpisodeNumber,
  parseEpisodeNumber,
  parseDanmakuComment,
  parseDanmakuComments,
  resolveEpisodeForSearch,
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

  it("解析播放源集标题里的集号", () => {
    expect(parseEpisodeNumber("第12集 婉儿家中")).toBe(12);
    expect(parseEpisodeNumber("S02E12")).toBe(12);
    expect(parseEpisodeNumber("EP07")).toBe(7);
    expect(parseEpisodeNumber("12")).toBe(12);
    expect(parseEpisodeNumber("预告")).toBeNull();
  });

  it("弹幕剧集集数严格使用 episodeNumber", () => {
    expect(
      getDanmakuEpisodeNumber({
        episodeNumber: "6",
      }),
    ).toBe(6);
    expect(getDanmakuEpisodeNumber({})).toBeNull();
    expect(
      formatDanmakuEpisodeTitle({
        episodeTitle: "【bilibili1】 第27话 魔道争锋6",
        episodeNumber: "6",
      }),
    ).toBe("第6集 第27话 魔道争锋6");
    expect(
      formatDanmakuEpisodeTitle({
        episodeTitle: "【qq】 第12集",
        episodeNumber: "12",
      }),
    ).toBe("第12集");
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

  it("统一通过搜索接口排序并只取第一条番剧", async () => {
    fetchMock
      .mockReturnValueOnce(
        respond({
          success: true,
          animes: [
            { animeId: 10, animeTitle: "测试剧(2021)", startDate: "2021-01-01", episodeCount: 100 },
            {
              animeId: 20,
              animeTitle: "测试剧(2020)",
              startDate: "2020-01-01",
              episodeCount: 41,
              source: "bilibili",
            },
            { animeId: 30, animeTitle: "测试剧(2020)短版", startDate: "2020-01-01", episodeCount: 30 },
          ],
        }),
      )
      .mockReturnValueOnce(
        respond({
          success: true,
          bangumi: {
            animeId: 20,
            animeTitle: "测试剧(2020)",
            episodes: [{ episodeId: 201, episodeTitle: "第11集", episodeNumber: "11" }],
          },
        }),
      );

    const match = await resolveEpisodeForSearch(
      "https://danmu.example.com/token",
      "测试剧",
      10,
      { year: "2020", episodeCount: 41, episodeNumber: 11 },
    );

    expect(match).toEqual({
      episodeId: 201,
      animeId: 20,
      animeTitle: "测试剧(2020)",
      episodeTitle: "第11集",
      episodeNumber: 11,
      source: "bilibili",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v2/search/anime?keyword=");
    expect(fetchMock.mock.calls[1][0]).toContain("/api/v2/bangumi/20");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v2/match"))).toBe(false);
  });

  it("有手动选择记忆时直接在该番剧中取集", async () => {
    fetchMock.mockReturnValueOnce(
      respond({
        success: true,
        bangumi: {
          animeId: 238380,
          animeTitle: "白日提灯(2026)【电视剧】from 360",
          episodes: [{ episodeId: 12839, episodeTitle: "【qq】 第12集", episodeNumber: "12" }],
        },
      }),
    );

    const match = await resolveEpisodeForSearch(
      "https://danmu.example.com/token",
      "白日提灯",
      11,
      {
        episodeNumber: 12,
        savedSelection: {
          animeId: 238380,
          animeTitle: "白日提灯(2026)【电视剧】from 360",
          source: "360",
        },
      },
    );

    expect(match?.episodeId).toBe(12839);
    expect(match?.source).toBe("360");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v2/bangumi/238380");
  });

  it("手动选择记住具体集号，并在后续播放集上保持偏移", async () => {
    const bangumiResponse = respond({
      success: true,
      bangumi: {
        animeId: 2208394,
        animeTitle: "凡人修仙传：风起天南(2020)【国漫】from bilibili",
        episodes: Array.from({ length: 8 }, (_, index) => ({
          episodeId: 10002 + index,
          episodeTitle: `第${index + 1}话`,
          episodeNumber: String(index + 1),
        })),
      },
    });
    fetchMock
      .mockReturnValueOnce(bangumiResponse)
      .mockReturnValueOnce(
        respond({
          success: true,
          bangumi: {
            animeId: 2208394,
            animeTitle: "凡人修仙传：风起天南(2020)【国漫】from bilibili",
            episodes: Array.from({ length: 8 }, (_, index) => ({
              episodeId: 10002 + index,
              episodeTitle: `第${index + 1}话`,
              episodeNumber: String(index + 1),
            })),
          },
        }),
      );
    const savedSelection = {
      animeId: 2208394,
      animeTitle: "凡人修仙传：风起天南(2020)【国漫】from bilibili",
      source: "bilibili",
      episodeId: 10003,
      episodeNumber: 2,
      playbackEpisodeNumber: 6,
    };

    const reopened = await resolveEpisodeForSearch(
      "https://danmu.example.com/token",
      "凡人修仙传",
      5,
      { episodeNumber: 6, savedSelection },
    );
    const nextEpisode = await resolveEpisodeForSearch(
      "https://danmu.example.com/token",
      "凡人修仙传",
      7,
      { episodeNumber: 8, savedSelection },
    );

    expect(reopened?.episodeId).toBe(10003);
    expect(reopened?.episodeNumber).toBe(2);
    expect(nextEpisode?.episodeId).toBe(10005);
    expect(nextEpisode?.episodeNumber).toBe(4);
  });

  it("第一条番剧没有当前集时直接返回未匹配", async () => {
    fetchMock
      .mockReturnValueOnce(
        respond({
          success: true,
          animes: [
            {
              animeId: 20,
              animeTitle: "测试剧(2020)",
              startDate: "2020-01-01",
              episodeCount: 41,
            },
            {
              animeId: 30,
              animeTitle: "备用候选",
              startDate: "2020-01-01",
              episodeCount: 41,
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        respond({
          success: true,
          bangumi: {
            animeId: 20,
            animeTitle: "测试剧(2020)",
              episodes: [{ episodeId: 201, episodeTitle: "第1集", episodeNumber: "1" }],
          },
        }),
      );

    const match = await resolveEpisodeForSearch(
      "https://danmu.example.com/token",
      "测试剧",
      10,
      { year: "2020", episodeCount: 41, episodeNumber: 11 },
    );

    expect(match).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("集数优先按 bangumi 的 episodeNumber 命中", async () => {
    fetchMock
      .mockReturnValueOnce(
        respond({
          success: true,
          animes: [
            {
              animeId: 2208394,
              animeTitle: "凡人修仙传：风起天南(2020)【国漫】from bilibili",
              startDate: "2020-01-01",
              episodeCount: 309,
              source: "bilibili",
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        respond({
          success: true,
          bangumi: {
            animeId: 2208394,
            animeTitle: "凡人修仙传：风起天南(2020)【国漫】from bilibili",
            episodes: [
              {
                episodeId: 10007,
                episodeTitle: "【bilibili1】 第27话 魔道争锋6",
                episodeNumber: "6",
              },
              {
                episodeId: 10058,
                episodeTitle: "【bilibili1】 第6话 凡人风起天南6重制版",
                episodeNumber: "57",
              },
            ],
          },
        }),
      );

    const match = await resolveEpisodeForSearch(
      "https://danmu.example.com/token",
      "凡人修仙传",
      5,
      { year: "2020", episodeCount: 309, episodeNumber: 6 },
    );

    expect(match?.episodeId).toBe(10007);
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
