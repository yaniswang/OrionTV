import AsyncStorage from "@react-native-async-storage/async-storage";
import { API, api } from "@/services/api";
import { SearchHistoryManager } from "@/services/storage";
import { storageConfig } from "@/services/storageConfig";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

describe("search history", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storageConfig.setStorageType("redis");
  });

  afterAll(() => {
    storageConfig.setStorageType(undefined);
  });

  it("本地存储按 keyword 删除单条历史", async () => {
    storageConfig.setStorageType("localstorage");
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify(["凡人", "斗罗大陆"]));

    await SearchHistoryManager.remove("凡人");

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      "mytv_search_history",
      JSON.stringify(["斗罗大陆"])
    );
  });

  it("远程存储单条删除传 keyword，清空不传 keyword", async () => {
    const deleteSearchHistory = jest
      .spyOn(api, "deleteSearchHistory")
      .mockResolvedValue({ success: true });

    await SearchHistoryManager.remove(" 凡人 ");
    await SearchHistoryManager.clear();

    expect(deleteSearchHistory).toHaveBeenNthCalledWith(1, "凡人");
    expect(deleteSearchHistory).toHaveBeenNthCalledWith(2);
    deleteSearchHistory.mockRestore();
  });

  it("deleteSearchHistory 按是否传 keyword 生成正确请求地址", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ success: true }),
    });
    global.fetch = fetchMock as any;
    const testApi = new API("http://demo");

    await testApi.deleteSearchHistory("凡人 修仙传");
    await testApi.deleteSearchHistory();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://demo/api/searchhistory?keyword=${encodeURIComponent("凡人 修仙传")}`,
      { method: "DELETE" }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://demo/api/searchhistory",
      { method: "DELETE" }
    );
  });
});