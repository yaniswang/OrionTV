import AsyncStorage from "@react-native-async-storage/async-storage";
import EventSource from "react-native-sse";

// region: --- Interface Definitions ---
export interface DoubanItem {
  title: string;
  poster: string;
  rate?: string;
}

export interface DoubanResponse {
  code: number;
  message: string;
  list: DoubanItem[];
}

export interface LiveSourceItem {
  key: string;
  name: string;
  url: string;
  ua: string;
}

export interface LiveSourceResponse {
  success: boolean;
  data: Array<LiveSourceItem>;
}


export interface VideoDetail {
  id: string;
  title: string;
  poster: string;
  source: string;
  source_name: string;
  desc?: string;
  type?: string;
  year?: string;
  area?: string;
  director?: string;
  actor?: string;
  remarks?: string;
}

export interface SearchResult {
  id: number;
  q?: string;
  title: string;
  poster: string;
  episodes: string[];
  source: string;
  source_name: string;
  source_count?: number;
  class?: string;
  year: string;
  desc?: string;
  type_name?: string;
}

export interface Favorite {
  cover: string;
  title: string;
  source_name: string;
  total_episodes: number;
  episode_index: number;
  progress: number;
  search_title: string;
  year: string;
  save_time?: number;
}

export interface PlayRecord {
  title: string;
  search_title: string | null;
  source_name: string;
  cover: string;
  index: number;
  total_episodes: number;
  play_time: number;
  total_time: number;
  save_time: number;
  year: string;
}

export interface ApiSite {
  key: string;
  api: string;
  name: string;
  detail?: string;
}

export interface ServerConfig {
  SiteName: string;
  StorageType: "localstorage" | "redis" | string;
}

/** 站长放在服务器 public 目录的 config.json：弹幕 API 与 M3U8 代理只从这里来 */
export interface AppConfig {
  danmakuApiUrl: string;
  m3u8Proxy: string;
}

/** 发往服务器的请求统一带的 UA：服务器前面的反代（Lucky）按它放行 */
export const SERVER_USER_AGENT = "OrionTV";

const withServerUserAgent = (headers?: HeadersInit): Record<string, string> => ({
  ...(headers as Record<string, string> | undefined),
  "User-Agent": SERVER_USER_AGENT,
});

/** 修改密码时服务器返回的错误，message 为可直接展示的提示 */
export class ChangePasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangePasswordError";
  }
}

export class API {
  public baseURL: string = "";

  constructor(baseURL?: string) {
    if (baseURL) {
      this.baseURL = baseURL;
    }
  }

  public setBaseUrl(url: string) {
    this.baseURL = url;
  }

  private async _fetch(url: string, options: RequestInit = {}): Promise<Response> {
    if (!this.baseURL) {
      throw new Error("API_URL_NOT_SET");
    }

    const response = await fetch(`${this.baseURL}${url}`, {
      ...options,
      headers: withServerUserAgent(options.headers),
    });

    if (response.status === 401) {
      throw new Error("UNAUTHORIZED");
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response;
  }

  async login(username?: string | undefined, password?: string): Promise<{ ok: boolean }> {
    const response = await this._fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    // 存储cookie到AsyncStorage
    const cookies = response.headers.get("Set-Cookie");
    if (cookies) {
      await AsyncStorage.setItem("authCookies", cookies);
    }

    return response.json();
  }

  /** 服务器校验旧密码；失败时抛出服务器返回的错误信息（如「站长不能通过此接口修改密码」） */
  async changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    if (!this.baseURL) {
      throw new Error("API_URL_NOT_SET");
    }
    const response = await fetch(`${this.baseURL}/api/change-password`, {
      method: "POST",
      headers: withServerUserAgent({ "Content-Type": "application/json" }),
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error === "Unauthorized" ? "登录已失效，请重新登录" : data?.error;
      throw new ChangePasswordError(message || `HTTP error! status: ${response.status}`);
    }
    return data;
  }

  async logout(): Promise<{ ok: boolean }> {
    const response = await this._fetch("/api/logout", {
      method: "POST",
    });
    await AsyncStorage.setItem("authCookies", '');
    return response.json();
  }

  async getServerConfig(): Promise<ServerConfig> {
    const response = await this._fetch("/api/server-config");
    return response.json();
  }

  /**
   * 读取服务器的 config.json（服务端中间件要求登录）。
   * 文件不存在返回 null；未登录会被重定向到登录页，解析 JSON 失败而抛错。
   */
  async getAppConfig(): Promise<AppConfig | null> {
    if (!this.baseURL) {
      throw new Error("API_URL_NOT_SET");
    }
    const response = await fetch(`${this.baseURL}/config.json`, {
      headers: withServerUserAgent({ Accept: "application/json" }),
    });
    if (response.status === 404) return null;
    if (response.status === 401) throw new Error("UNAUTHORIZED");
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return {
      danmakuApiUrl: typeof data?.danmakuApiUrl === "string" ? data.danmakuApiUrl : "",
      m3u8Proxy: typeof data?.m3u8Proxy === "string" ? data.m3u8Proxy : "",
    };
  }

  async getFavorites(key?: string): Promise<Record<string, Favorite> | Favorite | null> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url);
    return response.json();
  }

  async addFavorite(key: string, favorite: Omit<Favorite, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, favorite }),
    });
    return response.json();
  }

  async deleteFavorite(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  async getPlayRecords(): Promise<Record<string, PlayRecord>> {
    const response = await this._fetch("/api/playrecords");
    return response.json();
  }

  async savePlayRecord(key: string, record: Omit<PlayRecord, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/playrecords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, record }),
    });
    return response.json();
  }

  async deletePlayRecord(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/playrecords?key=${encodeURIComponent(key)}` : "/api/playrecords";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  async getSearchHistory(): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory");
    return response.json();
  }

  async addSearchHistory(keyword: string): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword }),
    });
    return response.json();
  }

  async deleteSearchHistory(keyword?: string): Promise<{ success: boolean }> {
    const url = keyword ? `/api/searchhistory?keyword=${encodeURIComponent(keyword)}` : "/api/searchhistory";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  /** 海报走服务器的图片代理：图片请求不经过 fetch，UA 要放在 Image 的 source.headers 里 */
  getImageProxySource(imageUrl: string): { uri: string; headers: Record<string, string> } {
    return {
      uri: `${this.baseURL}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`,
      headers: withServerUserAgent(),
    };
  }

  async getDoubanData(
    type: "movie_hot" | "movie_new" | 'movie_high' | 'movie_unpop' | 'movie_all' | 'tv_hot' | 'tv_all' | 'show_hot' | 'show_all',
    tag: string,
    pageSize: number = 16,
    pageStart: number = 0
  ): Promise<DoubanResponse> {
    let url = '';
    if (type === 'movie_hot') {
      url = `/api/douban/categories?kind=movie&category=${encodeURIComponent('热门')}&type=${encodeURIComponent(tag)}&limit=${pageSize}&start=${pageStart}`
    }
    else if(type === 'movie_new') {
      url = `/api/douban/categories?kind=movie&category=${encodeURIComponent('最新')}&type=${encodeURIComponent(tag)}&limit=${pageSize}&start=${pageStart}`
    }
    else if(type === 'movie_high') {
      url = `/api/douban/categories?kind=movie&category=${encodeURIComponent('豆瓣高分')}&type=${encodeURIComponent(tag)}&limit=${pageSize}&start=${pageStart}`
    }
    else if(type === 'movie_unpop') {
      url = `/api/douban/categories?kind=movie&category=${encodeURIComponent('冷门佳片')}&type=${encodeURIComponent(tag)}&limit=${pageSize}&start=${pageStart}`
    }
    else if(type === 'movie_all') {
      url = `/api/douban/recommends?kind=movie&category=${encodeURIComponent(tag==='全部'?'all':tag)}&&format=&region=all&year=all&platform=all&sort=T&label=all&limit=${pageSize}&start=${pageStart}`
    }
    else if(type === 'tv_hot') {
      const mapTvHot = {
        '全部': 'tv',
        '国产': 'tv_domestic',
        '欧美': 'tv_american',
        '日本': 'tv_japanese',
        '韩国': 'tv_korean',
        '动漫': 'tv_animation',
        '纪录片': 'tv_documentary'
      };
      url = `/api/douban/categories?kind=tv&category=tv&type=${encodeURIComponent(mapTvHot[tag])}&limit=${pageSize}&start=${pageStart}`;
    }
    else if(type === 'tv_all') {
      url = `/api/douban/recommends?kind=tv&category=${encodeURIComponent(tag==='全部'?'all':tag)}&format=电视剧&region=all&year=all&platform=all&sort=T&label=all&limit=${pageSize}&start=${pageStart}`;
    }
    else if(type === 'show_hot') {
      const mapShowHot = {
        '全部': 'show',
        '国内': 'show_domestic',
        '国外': 'show_foreign',
      };
      url = `/api/douban/categories?kind=tv&category=show&type=${encodeURIComponent(mapShowHot[tag])}&limit=${pageSize}&start=${pageStart}`;
    }
    else if(type === 'show_all') {
      url = `/api/douban/recommends?kind=tv&category=${encodeURIComponent(tag==='全部'?'all':tag)}&format=综艺&region=all&year=all&platform=all&sort=T&label=all&limit=${pageSize}&start=${pageStart}`;
    }
    const response = await this._fetch(url);
    return response.json();
  }

  async getLiveSource(): Promise<LiveSourceResponse> {
    const url = `/api/live/sources`;
    const response = await this._fetch(url);
    return response.json();
  }

  async searchVideos(query: string): Promise<{ results: SearchResult[] }> {
    const url = `/api/search?q=${encodeURIComponent(query)}`;
    const response = await this._fetch(url);
    return response.json();
  }

  /** 取登录 cookie 里的 auth token：SSE 请求走不了 cookie jar，需要手动带 Cookie 头 */
  private async _getAuthToken(): Promise<string> {
    const cookies = await AsyncStorage.getItem('authCookies');
    if(!cookies) {
      throw new Error("No auth cookie!");
    }
    const match = cookies.match(/auth=(.+?);/);
    if (!match) {
      throw new Error("Find auth cookie failed!");
    }
    return match[1];
  }

  private async _createSearchEventSource(query: string): Promise<EventSource> {
    const auth = await this._getAuthToken();
    return new EventSource(`${this.baseURL}/api/search/ws?q=${encodeURIComponent(query)}`, {
      headers: withServerUserAgent({
        Cookie: `auth=${auth};`
      })
    });
  }

  async searchVideosWs(query: string, signal?: AbortSignal) {
    const arrMessages: any[] = [];
    const es = await this._createSearchEventSource(query);
    es.addEventListener("message", (event) => {
      const data = JSON.parse(event.data || '{}');
      arrMessages.push(data);
      if(data.type === 'complete' || signal?.aborted) {
        es.close();
      }
    });
    return arrMessages;
  }

  /**
   * WS(SSE) 增量搜索：每个源搜完就实时回调一次，收到 complete 或中断时 resolve。
   * 与 searchVideosWs 的区别是结果实时交给调用方，而不是攒完再返回。
   */
  async searchVideosWsStream(
    query: string,
    onMessage: (message: { type: string; results?: SearchResult[] }) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) return;
    const es = await this._createSearchEventSource(query);
    return new Promise<void>((resolve) => {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener?.('abort', close);
        es.close();
        resolve();
      };
      es.addEventListener("message", (event) => {
        const data = JSON.parse(event.data || '{}');
        onMessage(data);
        if(data.type === 'complete') {
          close();
        }
      });
      es.addEventListener("error", close);
      signal?.addEventListener?.('abort', close);
      if (signal?.aborted) {
        close();
      }
    });
  }

  async searchVideo(query: string, resourceId: string, signal?: AbortSignal): Promise<{ results: SearchResult[] }> {
    const url = `/api/search/one?q=${encodeURIComponent(query)}&resourceId=${encodeURIComponent(resourceId)}`;
    const response = await this._fetch(url, { signal });
    const { results } = await response.json();
    return { results: results.filter((item: any) => item.title === query )};
  }

  async getResources(signal?: AbortSignal): Promise<ApiSite[]> {
    const url = `/api/search/resources`;
    const response = await this._fetch(url, { signal });
    return response.json();
  }

  async getVideoDetail(source: string, id: string): Promise<VideoDetail> {
    const url = `/api/detail?source=${source}&id=${id}`;
    const response = await this._fetch(url);
    return response.json();
  }
}

// 默认实例
export let api = new API();
