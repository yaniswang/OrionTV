/** @jest-environment node */

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

jest.mock("@/services/danmaku", () => ({
  ...jest.requireActual("@/services/danmaku"),
  fetchDanmakuComments: jest.fn(),
}));

import { fetchDanmakuComments } from "@/services/danmaku";
import { useDanmakuStore } from "@/stores/danmakuStore";
import { useSettingsStore } from "@/stores/settingsStore";

const mockFetchComments = fetchDanmakuComments as jest.Mock;

const match = {
  episodeId: 900001,
  animeId: 1,
  animeTitle: "测试番剧",
  episodeTitle: "第1集",
};

describe("danmakuStore.loadEpisode 缓存", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ danmakuApiUrl: "https://danmu.example.com" });
  });

  it("0 条结果不缓存，再次加载会重新请求", async () => {
    mockFetchComments
      .mockResolvedValueOnce({ comments: [], videoDuration: 0 })
      .mockResolvedValueOnce({
        comments: [{ time: 1, text: "a", color: "#ffffff", mode: 1 }],
        videoDuration: 60,
      });

    await useDanmakuStore.getState().loadEpisode(match);
    expect(useDanmakuStore.getState().comments).toHaveLength(0);

    await useDanmakuStore.getState().loadEpisode(match);
    expect(mockFetchComments).toHaveBeenCalledTimes(2);
    expect(useDanmakuStore.getState().comments).toHaveLength(1);
  });

  it("有弹幕的结果会缓存，再次加载不重复请求", async () => {
    const cachedMatch = { ...match, episodeId: 900002 };
    mockFetchComments.mockResolvedValueOnce({
      comments: [{ time: 1, text: "a", color: "#ffffff", mode: 1 }],
      videoDuration: 60,
    });

    await useDanmakuStore.getState().loadEpisode(cachedMatch);
    await useDanmakuStore.getState().loadEpisode(cachedMatch);
    expect(mockFetchComments).toHaveBeenCalledTimes(1);
    expect(useDanmakuStore.getState().comments).toHaveLength(1);
  });
});
