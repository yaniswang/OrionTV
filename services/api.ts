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
  url: string
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

    const response = await fetch(`${this.baseURL}${url}`, options);

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
    const url = keyword ? `/api/searchhistory?keyword=${keyword}` : "/api/searchhistory";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  getImageProxyUrl(imageUrl: string): string {
    return `${this.baseURL}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
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

  async searchVideosWs(query: string, signal?: AbortSignal) {
    const cookies = await AsyncStorage.getItem('authCookies');
    if(!cookies) {
      throw new Error("No auth cookie!");
    }
    const match = cookies.match(/auth=(.+?);/);
    if (!match) {
      throw new Error("Find auth cookie failed!");
    }
    const auth = match[1];
    const arrMessages = [];
    const es = new EventSource(`${this.baseURL}/api/search/ws?q=${encodeURIComponent(query)}`, {
      headers: {
        Cookie: `auth=${auth};`
      }
    });
    es.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      arrMessages.push(data);
      if(data.type === 'complete' || signal?.aborted) {
        es.close();
      }
    });
    return arrMessages;
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
