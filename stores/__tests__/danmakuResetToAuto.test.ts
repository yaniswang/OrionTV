import { useDanmakuStore } from "@/stores/danmakuStore";
import { DanmakuSelectionManager } from "@/services/storage";
import { fetchDanmakuComments, resolveEpisodeForSearch } from "@/services/danmaku";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@/stores/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ danmakuApiUrl: "http://danmu.test" }) },
}));
jest.mock("@/services/danmaku", () => ({
  ...jest.requireActual("@/services/danmaku"),
  resolveEpisodeForSearch: jest.fn(),
  fetchDanmakuComments: jest.fn(),
}));

const autoMatch = {
  episodeId: 2001,
  animeId: 20,
  animeTitle: "自动番剧",
  episodeTitle: "第3集",
  episodeNumber: 3,
  platform: "qq",
};

describe("resetToAuto", () => {
  beforeEach(async () => {
    (resolveEpisodeForSearch as jest.Mock).mockResolvedValue(autoMatch);
    (fetchDanmakuComments as jest.Mock).mockResolvedValue({ comments: [{ time: 1, text: "x" }] });
    await DanmakuSelectionManager.save("src", "100", {
      animeId: 10,
      animeTitle: "手动番剧",
      platform: "bilibili1",
      mode: "auto",
      version: 2,
    });
    useDanmakuStore.setState({
      enabled: true,
      match: { ...autoMatch, episodeId: 1001, animeId: 10, platform: "bilibili1" },
      matchMode: "manual",
      loadedKey: "loaded",
      lastRequest: { title: "剧", source: "src", id: "100", episodeIndex: 2, episodeCount: 10 },
    });
  });

  it("删除手动记忆并按自动规则重新匹配当前集", async () => {
    await useDanmakuStore.getState().resetToAuto();

    expect(await DanmakuSelectionManager.get("src", "100")).toBeNull();
    expect(resolveEpisodeForSearch).toHaveBeenLastCalledWith(
      "http://danmu.test",
      "剧",
      2,
      expect.objectContaining({ savedSelection: null }),
    );
    const state = useDanmakuStore.getState();
    expect(state.match?.episodeId).toBe(2001);
    expect(state.matchMode).toBe("auto");
  });
});
