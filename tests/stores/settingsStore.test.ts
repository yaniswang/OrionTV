/** @jest-environment node */

jest.mock("@/services/api", () => ({
  api: {
    getLiveSource: jest.fn(),
    getServerConfig: jest.fn(),
    setBaseUrl: jest.fn(),
  },
}));

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import { api } from "@/services/api";
import { SettingsManager } from "@/services/storage";
import { useSettingsStore } from "@/stores/settingsStore";
import AsyncStorage from "@react-native-async-storage/async-storage";

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

describe("settingsStore 广告过滤开关", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("保存后写入设置，重新读取仍是同一个值", async () => {
    useSettingsStore.setState({ adFilterEnabled: true });
    await useSettingsStore.getState().saveSettings();
    expect((await SettingsManager.get()).adFilterEnabled).toBe(true);

    useSettingsStore.setState({ adFilterEnabled: false });
    await useSettingsStore.getState().saveSettings();
    expect((await SettingsManager.get()).adFilterEnabled).toBe(false);
  });

  it("默认关闭", async () => {
    await AsyncStorage.clear();

    expect((await SettingsManager.get()).adFilterEnabled).toBe(false);
  });

  it("切换开关只是草稿，点保存后才写入设置", async () => {
    await AsyncStorage.clear();

    useSettingsStore.getState().setAdFilterEnabled(true);
    expect(useSettingsStore.getState().adFilterEnabled).toBe(true);
    // 没点保存就不落盘
    expect((await SettingsManager.get()).adFilterEnabled).toBe(false);

    await useSettingsStore.getState().saveSettings();
    expect((await SettingsManager.get()).adFilterEnabled).toBe(true);

    useSettingsStore.getState().setAdFilterEnabled(false);
    await useSettingsStore.getState().saveSettings();
    expect((await SettingsManager.get()).adFilterEnabled).toBe(false);
  });

  it("读取设置时带回已保存的开关状态", async () => {
    await AsyncStorage.clear();
    await SettingsManager.save({ adFilterEnabled: true });

    useSettingsStore.setState({ adFilterEnabled: false });
    await useSettingsStore.getState().loadSettings();

    expect((await SettingsManager.get()).adFilterEnabled).toBe(true);
    expect(useSettingsStore.getState().adFilterEnabled).toBe(true);
  });
});
