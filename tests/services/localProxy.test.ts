/** @jest-environment node */

const mockWrapUrl = jest.fn(async (url: string, adFilter: boolean) => `${adFilter ? 'noad:' : 'plain:'}${url}`);
const mockWrapUrls = jest.fn(async (urls: string[], adFilter: boolean) =>
  urls.map((url) => `${adFilter ? 'noad:' : 'plain:'}${url}`),
);
const mockGetLanOrigin = jest.fn(async (): Promise<string | null> => "http://192.168.1.5:18923");

jest.mock("@/services/localProxy/native", () => ({
  AD_FILTERED_EVENT: "MediaProxyAdFiltered",
  getNativeMediaProxy: () => ({
    start: jest.fn(async () => ({ origin: "http://127.0.0.1:18923" })),
    stop: jest.fn(async () => undefined),
    getLanOrigin: () => mockGetLanOrigin(),
    wrapUrl: (url: string, adFilter: boolean) => mockWrapUrl(url, adFilter),
    wrapUrls: (urls: string[], adFilter: boolean) => mockWrapUrls(urls, adFilter),
    cancelDownloads: jest.fn(),
  }),
}));

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

import { ensureLocalProxy, mapEpisodesWithLocalProxy, resolvePlayUrl, stopProxyServer, toLanProxyUrl } from "@/services/localProxy";
import { SettingsManager } from "@/services/storage";
import { useSettingsStore } from "@/stores/settingsStore";

describe("localProxy 广告过滤开关", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await stopProxyServer();
    await SettingsManager.save({ adFilterEnabled: false });
    useSettingsStore.setState({ adFilterEnabled: false });
  });

  it("设置里没有开启时走普通路径", async () => {
    const wrapped = await resolvePlayUrl("https://cdn.example.com/a.m3u8");

    expect(mockWrapUrl).toHaveBeenCalledWith("https://cdn.example.com/a.m3u8", false);
    expect(wrapped).toBe("plain:https://cdn.example.com/a.m3u8");
  });

  it("保存过开启后要求原生代理过滤广告", async () => {
    await SettingsManager.save({ adFilterEnabled: true });

    const wrapped = await resolvePlayUrl("https://cdn.example.com/a.m3u8");

    expect(mockWrapUrl).toHaveBeenCalledWith("https://cdn.example.com/a.m3u8", true);
    expect(wrapped).toBe("noad:https://cdn.example.com/a.m3u8");
  });

  it("只切开关但没保存时不生效", async () => {
    // 设置页里的开关只是草稿，没点"保存设置"就不该改变代理行为
    useSettingsStore.setState({ adFilterEnabled: true });

    const wrapped = await resolvePlayUrl("https://cdn.example.com/a.m3u8");

    expect(mockWrapUrl).toHaveBeenCalledWith("https://cdn.example.com/a.m3u8", false);
    expect(wrapped).toBe("plain:https://cdn.example.com/a.m3u8");
  });

  it("剧集列表整批用同一个开关", async () => {
    await SettingsManager.save({ adFilterEnabled: true });
    const episodes = ["https://cdn.example.com/1.m3u8", "https://cdn.example.com/2.mp4"];

    const wrapped = await mapEpisodesWithLocalProxy(episodes);

    expect(mockWrapUrls).toHaveBeenCalledWith(episodes, true);
    expect(wrapped).toEqual(["noad:https://cdn.example.com/1.m3u8", "noad:https://cdn.example.com/2.mp4"]);
  });

  it("非 HLS 地址不经过代理", async () => {
    await SettingsManager.save({ adFilterEnabled: true });

    expect(await resolvePlayUrl("https://cdn.example.com/a.mp4")).toBe("https://cdn.example.com/a.mp4");
    expect(mockWrapUrl).not.toHaveBeenCalled();
  });
});

describe("localProxy 投屏地址", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await stopProxyServer();
  });

  it("本机播放用 127.0.0.1", async () => {
    expect(await ensureLocalProxy()).toBe("http://127.0.0.1:18923");
  });

  it("本机代理地址换成当前局域网地址", async () => {
    await ensureLocalProxy();
    expect(await toLanProxyUrl("http://127.0.0.1:18923/abc/_hls.m3u8")).toBe("http://192.168.1.5:18923/abc/_hls.m3u8");
  });

  it("非本机代理地址原样返回，不查局域网 IP", async () => {
    await ensureLocalProxy();
    expect(await toLanProxyUrl("https://cdn.example.com/a.mp4")).toBe("https://cdn.example.com/a.mp4");
    expect(mockGetLanOrigin).not.toHaveBeenCalled();
  });

  it("取不到局域网 IP 返回 null", async () => {
    await ensureLocalProxy();
    mockGetLanOrigin.mockResolvedValueOnce(null);
    expect(await toLanProxyUrl("http://127.0.0.1:18923/abc/_hls.m3u8")).toBeNull();
  });
});
