import { API } from "@/services/api";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("api.changePassword", () => {
  const api = new API("http://server-a");
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it("以 oldPassword / newPassword 提交到 /api/change-password", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { ok: true }));

    await expect(api.changePassword("old-pw", "new-pw")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith("http://server-a/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPassword: "old-pw", newPassword: "new-pw" }),
    });
  });

  it("失败时抛出服务器返回的错误信息", async () => {
    fetchMock.mockResolvedValue(mockResponse(403, { error: "站长不能通过此接口修改密码" }));

    await expect(api.changePassword("old-pw", "new-pw")).rejects.toMatchObject({
      name: "ChangePasswordError",
      message: "站长不能通过此接口修改密码",
    });
  });

  it("登录失效（401 Unauthorized）时给出中文提示", async () => {
    fetchMock.mockResolvedValue(mockResponse(401, { error: "Unauthorized" }));

    await expect(api.changePassword("old-pw", "new-pw")).rejects.toThrow("登录已失效，请重新登录");
  });
});
