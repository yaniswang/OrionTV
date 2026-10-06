const mockEventSourceState = {
  instances: [] as any[],
};

jest.mock("react-native-sse", () => {
  class MockEventSource {
    url: string;
    options: any;
    closed = false;
    private listeners: Record<string, ((event: any) => void)[]> = {};

    constructor(url: string, options: any) {
      this.url = url;
      this.options = options;
      mockEventSourceState.instances.push(this);
    }

    addEventListener(type: string, listener: (event: any) => void) {
      (this.listeners[type] = this.listeners[type] || []).push(listener);
    }

    removeEventListener(type: string, listener: (event: any) => void) {
      this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== listener);
    }

    close() {
      this.closed = true;
    }

    emit(type: string, event: any) {
      if (this.closed) return;
      [...(this.listeners[type] || [])].forEach((listener) => listener(event));
    }
  }
  return MockEventSource;
});

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => "auth=token123;"),
  setItem: jest.fn(async () => undefined),
}));

import { API } from "@/services/api";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("API.searchVideosWsStream", () => {
  beforeEach(() => {
    mockEventSourceState.instances.length = 0;
  });

  it("每个源搜完实时回调，complete 后结束", async () => {
    const api = new API("http://demo");
    const received: any[] = [];
    let resolved = false;

    const finished = api
      .searchVideosWsStream("凡人修仙传", (message) => received.push(message))
      .then(() => {
        resolved = true;
      });

    await flush();
    const es = mockEventSourceState.instances[0];
    expect(es.url).toBe(`http://demo/api/search/ws?q=${encodeURIComponent("凡人修仙传")}`);
    expect(es.options.headers.Cookie).toBe("auth=token123;");

    es.emit("message", { data: JSON.stringify({ type: "source_result", results: [{ title: "A" }] }) });
    expect(received).toHaveLength(1);
    expect(resolved).toBe(false);

    es.emit("message", { data: JSON.stringify({ type: "complete" }) });
    await finished;
    expect(resolved).toBe(true);
    expect(es.closed).toBe(true);
  });

  it("中断后关闭连接且不再回调", async () => {
    const api = new API("http://demo");
    const controller = new AbortController();
    const received: any[] = [];

    const finished = api.searchVideosWsStream("凡人修仙传", (message) => received.push(message), controller.signal);

    await flush();
    const es = mockEventSourceState.instances[0];

    controller.abort();
    await finished;
    expect(es.closed).toBe(true);

    es.emit("message", { data: JSON.stringify({ type: "source_result", results: [{ title: "A" }] }) });
    expect(received).toHaveLength(0);
  });

  it("已经中断时不再建立连接", async () => {
    const api = new API("http://demo");
    const controller = new AbortController();
    controller.abort();

    await api.searchVideosWsStream("凡人修仙传", () => undefined, controller.signal);

    expect(mockEventSourceState.instances).toHaveLength(0);
  });
});
