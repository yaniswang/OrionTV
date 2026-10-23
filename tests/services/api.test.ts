/** @jest-environment node */

jest.mock("react-native-sse", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    addEventListener: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import EventSource from "react-native-sse";
import { API } from "@/services/api";

const mockEventSource = EventSource as unknown as jest.Mock;

const fetchMock = jest.fn();

const okJson = (body: unknown) => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  json: async () => body,
});

const userAgentOf = (call: unknown[]) =>
  ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.["User-Agent"];

describe("发往服务器的请求统一带 UA=OrionTV", () => {
  let api: API;

  beforeEach(() => {
    fetchMock.mockReset();
    mockEventSource.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
    api = new API("http://luna");
  });

  it("普通接口（含带自定义头的 POST）", async () => {
    fetchMock.mockResolvedValue(okJson({ success: true }));

    await api.getFavorites();
    await api.addFavorite("a+1", {} as never);

    expect(userAgentOf(fetchMock.mock.calls[0])).toBe("OrionTV");
    expect(userAgentOf(fetchMock.mock.calls[1])).toBe("OrionTV");
    // 原有的请求头不能被覆盖掉
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });

  it("修改密码", async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));

    await api.changePassword("old", "new");

    expect(userAgentOf(fetchMock.mock.calls[0])).toBe("OrionTV");
  });

  it("config.json", async () => {
    fetchMock.mockResolvedValue(okJson({ danmakuApiUrl: "", m3u8Proxy: "" }));

    await api.getAppConfig();

    expect(userAgentOf(fetchMock.mock.calls[0])).toBe("OrionTV");
  });

  it("搜索 SSE", async () => {
    await AsyncStorage.setItem("authCookies", "auth=token123; Path=/");

    await api.searchVideosWs("q");

    const headers = mockEventSource.mock.calls[0][1].headers;
    expect(headers["User-Agent"]).toBe("OrionTV");
    expect(headers.Cookie).toBe("auth=token123;");
  });

  it("海报图片代理地址附带的请求头", () => {
    expect(api.getImageProxySource("http://img/a.jpg")).toEqual({
      uri: "http://luna/api/image-proxy?url=http%3A%2F%2Fimg%2Fa.jpg",
      headers: { "User-Agent": "OrionTV" },
    });
  });
});
