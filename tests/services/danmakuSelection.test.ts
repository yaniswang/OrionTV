/** @jest-environment node */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { DanmakuSelectionManager } from "@/services/storage";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

describe("DanmakuSelectionManager", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it("使用 source+id 作为手动匹配的存储 Key", async () => {
    await DanmakuSelectionManager.save("jszyapi.com", 1189, {
      animeId: 243158,
      animeTitle: "凡人修仙传(2020)【动漫】from 360",
      source: "360",
      episodeId: 10007,
      episodeNumber: 6,
      playbackEpisodeNumber: 6,
    });

    expect(await DanmakuSelectionManager.get("jszyapi.com", 1189)).toMatchObject({
      animeId: 243158,
      animeTitle: "凡人修仙传(2020)【动漫】from 360",
      source: "360",
      episodeId: 10007,
      episodeNumber: 6,
      playbackEpisodeNumber: 6,
    });
    expect(await DanmakuSelectionManager.get("another-source", 1189)).toBeNull();

    const raw = await AsyncStorage.getItem("mytv_danmaku_selections");
    expect(Object.keys(JSON.parse(raw || "{}"))).toContain("jszyapi.com+1189");
  });
});
