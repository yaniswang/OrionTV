import Toast from "react-native-toast-message";
import { api } from "@/services/api";
import { DanmakuDisplaySettingsManager } from "@/services/storage";
import useDanmakuStore from "../danmakuStore";

jest.mock("react-native-toast-message", () => ({
  show: jest.fn(),
}));

jest.mock("@/services/api", () => ({
  api: {
    searchDanmaku: jest.fn(),
    getDanmakuEpisodes: jest.fn(),
    getDanmakuComments: jest.fn(),
  },
}));

jest.mock("@/services/storage", () => ({
  DanmakuDisplaySettingsManager: {
    get: jest.fn(async () => ({ area: 0.25, density: "medium" })),
    save: jest.fn(async () => undefined),
  },
}));

const mockedToast = Toast as jest.Mocked<typeof Toast>;
const mockedApi = api as jest.Mocked<typeof api>;

describe("danmakuStore loadForPlayback toasts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useDanmakuStore.getState().reset();
  });

  it("搜索并应用弹幕后提示对应源的弹幕数量已就绪", async () => {
    mockedApi.searchDanmaku.mockResolvedValue({
      success: true,
      errorCode: 0,
      errorMessage: "",
      animes: [
        {
          animeId: 1,
          animeTitle: "权力的游戏",
          type: "tv",
          typeDescription: "tv",
          source: "iqiyi",
          episodeCount: 10,
        },
        {
          animeId: 2,
          animeTitle: "权力的游戏",
          type: "tv",
          typeDescription: "tv",
          source: "bilibili",
          episodeCount: 10,
        },
      ],
    });
    mockedApi.getDanmakuEpisodes.mockImplementation(async (animeId: number) => ({
      success: true,
      errorCode: 0,
      errorMessage: "",
      bangumi: {
        bangumiId: String(animeId),
        animeTitle: "权力的游戏",
        episodes: [{ episodeId: animeId * 100, episodeTitle: "第1集" }],
      },
    }));
    mockedApi.getDanmakuComments.mockImplementation(async (episodeId: number) => {
      if (episodeId === 100) {
        return {
          count: 3,
          comments: [
            { p: "1,1,25,16777215,0,0,0,1", m: "少", cid: 1 },
            { p: "2,1,25,16777215,0,0,0,2", m: "量", cid: 2 },
            { p: "3,1,25,16777215,0,0,0,3", m: "弹幕", cid: 3 },
          ],
        };
      }
      return {
        count: 1888,
        comments: Array.from({ length: 1888 }, (_, i) => ({
          p: `${i},1,25,16777215,0,0,0,${i}`,
          m: `弹幕${i}`,
          cid: i,
        })),
      };
    });

    await useDanmakuStore.getState().loadForPlayback({
      title: "权力的游戏",
      year: "2011",
      episodeIndex: 0,
      episodeTitle: "第1集",
    });

    expect(mockedToast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        text1: "1888个弹幕已就绪~",
        visibilityTime: 2000,
        autoHide: true,
      })
    );
    expect(mockedToast.show).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text1: "xxx个弹幕已就绪~",
      })
    );
    const sources = useDanmakuStore.getState().sources;
    expect(sources.find((item) => item.source === "bilibili")?.commentCount).toBe(1888);
    expect(sources.find((item) => item.source === "iqiyi")?.commentCount).toBe(3);
    expect(useDanmakuStore.getState().count).toBe(1888);
  });

  it("弹幕源弹窗搜索结果会带上各源弹幕条数", async () => {
    useDanmakuStore.setState({
      showModal: true,
      episodeIndex: 0,
      videoEpisodeTitle: "第1集",
      videoTitle: "权力的游戏",
    });
    mockedApi.searchDanmaku.mockResolvedValue({
      success: true,
      errorCode: 0,
      errorMessage: "",
      animes: [
        {
          animeId: 2,
          animeTitle: "权力的游戏",
          type: "tv",
          typeDescription: "tv",
          source: "bilibili",
          episodeCount: 10,
        },
      ],
    });
    mockedApi.getDanmakuEpisodes.mockResolvedValue({
      success: true,
      errorCode: 0,
      errorMessage: "",
      bangumi: {
        bangumiId: "2",
        animeTitle: "权力的游戏",
        episodes: [{ episodeId: 200, episodeTitle: "第1集" }],
      },
    });
    mockedApi.getDanmakuComments.mockResolvedValue({
      count: 1888,
      comments: [{ p: "1,1,25,16777215,0,0,0,1", m: "弹幕", cid: 1 }],
    });

    await useDanmakuStore.getState().search("权力的游戏");

    expect(useDanmakuStore.getState().sources[0].commentCount).toBe(1888);
  });

  it("未找到弹幕时提示未找到弹幕", async () => {
    mockedApi.searchDanmaku.mockResolvedValue({
      success: true,
      errorCode: 0,
      errorMessage: "",
      animes: [],
    });

    await useDanmakuStore.getState().loadForPlayback({
      title: "不存在的剧",
      episodeIndex: 0,
    });

    expect(mockedToast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        text1: "未找到弹幕",
        visibilityTime: 2000,
        autoHide: true,
      })
    );
  });

  it("搜到源但没有弹幕内容时仍提示未找到弹幕", async () => {
    mockedApi.searchDanmaku.mockResolvedValue({
      success: true,
      errorCode: 0,
      errorMessage: "",
      animes: [
        {
          animeId: 1,
          animeTitle: "权力的游戏",
          type: "tv",
          typeDescription: "tv",
          source: "bilibili",
          episodeCount: 10,
        },
      ],
    });
    mockedApi.getDanmakuEpisodes.mockResolvedValue({
      success: true,
      errorCode: 0,
      errorMessage: "",
      bangumi: {
        bangumiId: "1",
        animeTitle: "权力的游戏",
        episodes: [{ episodeId: 101, episodeTitle: "第1集" }],
      },
    });
    mockedApi.getDanmakuComments.mockResolvedValue({
      count: 0,
      comments: [],
    });

    await useDanmakuStore.getState().loadForPlayback({
      title: "权力的游戏",
      episodeIndex: 0,
      episodeTitle: "第1集",
    });

    expect(mockedToast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        text1: "未找到弹幕",
        visibilityTime: 2000,
        autoHide: true,
      })
    );
    expect(mockedToast.show).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text1: expect.stringContaining("已就绪"),
      })
    );
  });
});

describe("danmaku display settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useDanmakuStore.setState({
      area: 0.25,
      density: "medium",
      comments: [{ text: "x", time: 1, color: "#ffffff", mode: 0 }],
      count: 1,
    });
  });

  it("setArea / setDensity 写入 store 并持久化", async () => {
    await useDanmakuStore.getState().setArea(0.5);
    await useDanmakuStore.getState().setDensity("sparse");
    expect(useDanmakuStore.getState().area).toBe(0.5);
    expect(useDanmakuStore.getState().density).toBe("sparse");
    expect(DanmakuDisplaySettingsManager.save).toHaveBeenCalledWith({ area: 0.5, density: "medium" });
    expect(DanmakuDisplaySettingsManager.save).toHaveBeenCalledWith({ area: 0.5, density: "sparse" });
  });

  it("hydrate 用本地缓存覆盖默认值", async () => {
    (DanmakuDisplaySettingsManager.get as jest.Mock).mockResolvedValueOnce({
      area: 0.75,
      density: "unlimited",
    });
    await useDanmakuStore.getState().hydrateDisplaySettings();
    expect(useDanmakuStore.getState().area).toBe(0.75);
    expect(useDanmakuStore.getState().density).toBe("unlimited");
  });

  it("reset 不清显示区域和密度", () => {
    useDanmakuStore.setState({ area: 0.75, density: "sparse" });
    useDanmakuStore.getState().reset();
    expect(useDanmakuStore.getState().area).toBe(0.75);
    expect(useDanmakuStore.getState().density).toBe("sparse");
    expect(useDanmakuStore.getState().comments).toEqual([]);
  });
});
