/** @jest-environment node */

jest.mock("@/services/api", () => ({
  api: {
    getLiveSource: jest.fn(),
  },
}));

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import { api } from "@/services/api";
import { useSettingsStore } from "@/stores/settingsStore";

const mockGetLiveSource = api.getLiveSource as jest.Mock;

describe("settingsStore.fetchLiveSource", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ m3uUrl: "", m3uUa: "" });
  });

  it("未登录（接口返回 UNAUTHORIZED）时不抛出，直播源保持为空", async () => {
    mockGetLiveSource.mockRejectedValue(new Error("UNAUTHORIZED"));

    await expect(useSettingsStore.getState().fetchLiveSource()).resolves.toBeUndefined();
    expect(useSettingsStore.getState().m3uUrl).toBe("");
  });

  it("取到直播源时写入地址和 UA", async () => {
    mockGetLiveSource.mockResolvedValue({ data: [{ url: "http://live/a.m3u", ua: "okhttp" }] });

    await useSettingsStore.getState().fetchLiveSource();

    expect(useSettingsStore.getState().m3uUrl).toBe("http://live/a.m3u");
    expect(useSettingsStore.getState().m3uUa).toBe("okhttp");
  });
});
