import { create } from "zustand";
import { SettingsManager } from "@/services/storage";
import { api, ServerConfig } from "@/services/api";
import { storageConfig } from "@/services/storageConfig";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Logger from "@/utils/Logger";
import useDetailStore from "./detailStore";
import { clearSpeedTestCache } from "@/services/m3u8";

const logger = Logger.withTag('SettingsStore');

interface SettingsState {
  apiBaseUrl: string;
  /** 来自服务器 config.json，不在本地保存 */
  m3u8Proxy: string;
  /** 来自服务器 config.json，不在本地保存；为空则不加载弹幕 */
  danmakuApiUrl: string;
  adFilterEnabled: boolean;
  m3uUrl: string;
  m3uUa: string;
  remoteInputEnabled: boolean;
  videoSource: {
    enabledAll: boolean;
    sources: {
      [key: string]: boolean;
    };
  };
  isModalVisible: boolean;
  serverConfig: ServerConfig | null;
  isLoadingServerConfig: boolean;
  loadSettings: () => Promise<void>;
  fetchServerConfig: () => Promise<void>;
  fetchLiveSource: () => Promise<void>;
  fetchAppConfig: () => Promise<void>;
  setApiBaseUrl: (url: string) => void;
  setAdFilterEnabled: (enabled: boolean) => void;
  setRemoteInputEnabled: (enabled: boolean) => void;
  saveSettings: () => Promise<void>;
  setVideoSource: (config: { enabledAll: boolean; sources: { [key: string]: boolean } }) => void;
  showModal: () => void;
  hideModal: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  apiBaseUrl: "",
  m3u8Proxy: '',
  danmakuApiUrl: "",
  adFilterEnabled: false,
  m3uUrl: "",
  m3uUa: '',
  remoteInputEnabled: false,
  isModalVisible: false,
  serverConfig: null,
  isLoadingServerConfig: false,
  videoSource: {
    enabledAll: true,
    sources: {},
  },
  loadSettings: async () => {
    const settings = await SettingsManager.get();
    set({
      apiBaseUrl: settings.apiBaseUrl,
      adFilterEnabled: settings.adFilterEnabled || false,
      remoteInputEnabled: settings.remoteInputEnabled || false,
      videoSource: settings.videoSource || {
        enabledAll: true,
        sources: {},
      },
    });
    if (settings.apiBaseUrl) {
      api.setBaseUrl(settings.apiBaseUrl);
      await get().fetchServerConfig();
    }
  },
  fetchServerConfig: async () => {
    set({ isLoadingServerConfig: true });
    try {
      const config = await api.getServerConfig();
      if (config) {
        storageConfig.setStorageType(config.StorageType);
        set({ serverConfig: config });
      }
    } catch (error) {
      set({ serverConfig: null });
      logger.error("Failed to fetch server config:", error);
    } finally {
      set({ isLoadingServerConfig: false });
    }
  },
  // 直播源接口需要登录，由 RootLayout 在登录后调用
  fetchLiveSource: async () => {
    try {
      const ret = await api.getLiveSource();
      const sources = ret.data;
      if (sources.length>0) {
        const source = sources[0];
        set({ 
          m3uUrl: source.url,
          m3uUa: source.ua
        });
        logger.info(`Live source url: ${source.url}, ua: ${source.ua}`);
      }
    } catch (error) {
      logger.warn("Failed to fetch live source:", error);
    }
  },
  // config.json 在服务端需要登录，由 RootLayout 在登录后调用
  fetchAppConfig: async () => {
    try {
      const config = await api.getAppConfig();
      const danmakuApiUrl = config?.danmakuApiUrl.trim() ?? "";
      const rawProxy = config?.m3u8Proxy.trim() ?? "";
      const m3u8Proxy = rawProxy && (rawProxy.endsWith("/") ? rawProxy : `${rawProxy}/`);
      if (m3u8Proxy !== get().m3u8Proxy) {
        // 代理地址变了，旧的完整测速结果不能继续复用
        clearSpeedTestCache();
        useDetailStore.setState({ detail: null });
      }
      set({ danmakuApiUrl, m3u8Proxy });
      logger.info(`App config: danmaku=${danmakuApiUrl ? "on" : "off"}, m3u8Proxy=${m3u8Proxy || "none"}`);
    } catch (error) {
      logger.warn("Failed to fetch app config:", error);
    }
  },
  setApiBaseUrl: (url) => set({ apiBaseUrl: url }),
  setAdFilterEnabled: (enabled) => set({ adFilterEnabled: enabled }),
  setRemoteInputEnabled: (enabled) => set({ remoteInputEnabled: enabled }),
  setVideoSource: (config) => set({ videoSource: config }),
  saveSettings: async () => {
    const { apiBaseUrl, adFilterEnabled, remoteInputEnabled, videoSource } = get();

    const currentSettings = await SettingsManager.get()
    const currentApiBaseUrl = currentSettings.apiBaseUrl;
    let processedApiBaseUrl = apiBaseUrl.trim();
    if (processedApiBaseUrl.endsWith("/")) {
      processedApiBaseUrl = processedApiBaseUrl.slice(0, -1);
    }

    if (!/^https?:\/\//i.test(processedApiBaseUrl)) {
      const hostPart = processedApiBaseUrl.split("/")[0];
      // Simple check for IP address format.
      const isIpAddress = /^((\d{1,3}\.){3}\d{1,3})(:\d+)?$/.test(hostPart);
      // Check if the domain includes a port.
      const hasPort = /:\d+/.test(hostPart);

      if (isIpAddress || hasPort) {
        processedApiBaseUrl = "http://" + processedApiBaseUrl;
      } else {
        processedApiBaseUrl = "https://" + processedApiBaseUrl;
      }
    }

    await SettingsManager.save({
      apiBaseUrl: processedApiBaseUrl,
      adFilterEnabled,
      remoteInputEnabled,
      videoSource,
    });
    if ( currentApiBaseUrl !== processedApiBaseUrl) {
      await AsyncStorage.setItem('authCookies', '');
    }
    api.setBaseUrl(processedApiBaseUrl);
    // Also update the URL in the state so the input field shows the processed URL
    set({
      isModalVisible: false,
      apiBaseUrl: processedApiBaseUrl,
    });
    await get().fetchServerConfig();
  },
  showModal: () => set({ isModalVisible: true }),
  hideModal: () => set({ isModalVisible: false }),
}));
