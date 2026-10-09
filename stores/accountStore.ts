import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "@/services/api";
import {
  AccountManager,
  AccountsData,
  LoginCredentialsManager,
  SavedAccount,
} from "@/services/storage";
import { pickAccountColor } from "@/constants/AccountColors";
import useAuthStore from "./authStore";
import useHomeStore from "./homeStore";
import { useSettingsStore } from "./settingsStore";
import Toast from "@/utils/Toast";
import Logger from "@/utils/Logger";

const logger = Logger.withTag("AccountStore");

export type AccountFormState =
  | { mode: "add" }
  | { mode: "reauth"; accountId: string }
  | { mode: "changePassword"; accountId: string };

interface AccountState extends AccountsData {
  /** 是否启用多账号并由新的账号表单接管登录（服务器有用户体系即启用，各设备一致），由 AccountGate 写入 */
  enabled: boolean;
  loaded: boolean;
  isPickerVisible: boolean;
  isPanelVisible: boolean;
  form: AccountFormState | null;
  switchingTo: SavedAccount | null;
  /** 正在处理登录失效，避免重复触发 */
  isRecovering: boolean;
  /** 每次换了账号（切换、添加、重新登录）后递增，搜索、收藏页据此重新加载本账号的数据 */
  accountVersion: number;

  setEnabled: (enabled: boolean) => void;
  load: () => Promise<void>;
  showPicker: () => void;
  hidePicker: () => void;
  showPanel: () => void;
  hidePanel: () => void;
  openAddForm: () => void;
  openReauthForm: (accountId: string) => void;
  openChangePasswordForm: (accountId: string) => void;
  closeForm: () => void;

  recordLogin: (username: string, password: string, color?: string) => Promise<SavedAccount>;
  addAccount: (username: string, password: string, color: string) => Promise<void>;
  reauth: (accountId: string, password: string) => Promise<void>;
  /** 用保存的密码作为旧密码修改服务器上的密码，失败时抛出错误交给表单提示 */
  changePassword: (accountId: string, newPassword: string) => Promise<void>;
  switchTo: (accountId: string) => Promise<void>;
  logoutAccount: (accountId: string) => Promise<void>;
  /** 登出当前账号；未由账号表单接管时退回原来的登出逻辑 */
  logoutCurrent: () => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;

  handleLaunch: () => Promise<void>;
  handleLoginRequired: () => Promise<void>;
}

const makeAccountId = (serverUrl: string, username: string) => `${serverUrl}::${username}`;

const getServerUrl = () => useSettingsStore.getState().apiBaseUrl;

/** 当前服务器下保存的账号 */
export const selectServerAccounts = (state: AccountState) => {
  const serverUrl = useSettingsStore.getState().apiBaseUrl;
  return state.accounts.filter((a) => a.serverUrl === serverUrl);
};

/** 当前登录的账号（必须属于当前服务器） */
export const selectCurrentAccount = (state: AccountState) =>
  selectServerAccounts(state).find((a) => a.id === state.currentId) ?? null;

const isUnauthorized = (error: unknown) => error instanceof Error && error.message === "UNAUTHORIZED";

const useAccountStore = create<AccountState>((set, get) => {
  const persist = async () => {
    const { accounts, currentId } = get();
    await AccountManager.save({ accounts, currentId });
  };

  const updateAccount = (accountId: string, patch: Partial<SavedAccount>) => {
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, ...patch } : a)),
    }));
  };

  /** 换了账号之后：同步登录状态、旧版凭据，并刷新首页的播放记录 */
  const afterAccountChanged = async (account: SavedAccount) => {
    await LoginCredentialsManager.save({ username: account.username, password: account.password ?? "" });
    useAuthStore.setState({ isLoggedIn: true, isLoginModalVisible: false });
    set((state) => ({ accountVersion: state.accountVersion + 1 }));
    await useHomeStore.getState().refreshPlayRecords();
  };

  /** 从已登录的账号换过去时提示「已切换」，否则就是一次普通登录 */
  const successText = (account: SavedAccount, wasLoggedIn: boolean) =>
    wasLoggedIn ? `已切换到 ${account.username}` : "登录成功";

  /** 当前没有可用账号时：有保存的账号就显示选择页，否则打开登录表单（首次登录） */
  const fallbackToLogin = () => {
    // 账号表单接管登录，旧的登录弹窗不再出现
    useAuthStore.setState({ isLoginModalVisible: false });
    if (selectServerAccounts(get()).length > 0) {
      set({ isPickerVisible: true, form: null });
    } else {
      set({ isPickerVisible: false, form: { mode: "add" } });
    }
  };

  return {
    accounts: [],
    currentId: null,
    enabled: false,
    loaded: false,
    isPickerVisible: false,
    isPanelVisible: false,
    form: null,
    switchingTo: null,
    isRecovering: false,
    accountVersion: 0,

    setEnabled: (enabled) => set({ enabled }),

    load: async () => {
      const data = await AccountManager.get();
      set({ ...data, loaded: true });
    },

    showPicker: () => set({ isPickerVisible: true, isPanelVisible: false }),
    hidePicker: () => set({ isPickerVisible: false }),
    showPanel: () => set({ isPanelVisible: true }),
    hidePanel: () => set({ isPanelVisible: false }),
    openAddForm: () => set({ form: { mode: "add" }, isPanelVisible: false, isPickerVisible: false }),
    openReauthForm: (accountId) =>
      set({ form: { mode: "reauth", accountId }, isPanelVisible: false, isPickerVisible: false }),
    openChangePasswordForm: (accountId) =>
      set({ form: { mode: "changePassword", accountId }, isPanelVisible: false, isPickerVisible: false }),
    closeForm: () => {
      set({ form: null });
      if (useAuthStore.getState().isLoggedIn) return;
      // 未登录时取消：有保存的账号回到选择页；首次登录则和旧登录弹窗一样直接关闭，方便去设置里改服务器地址
      useAuthStore.setState({ isLoginModalVisible: false });
      if (selectServerAccounts(get()).length > 0) {
        set({ isPickerVisible: true });
      }
    },

    recordLogin: async (username, password, color) => {
      const serverUrl = getServerUrl();
      const id = makeAccountId(serverUrl, username);
      const existing = get().accounts.find((a) => a.id === id);
      const account: SavedAccount = existing
        ? { ...existing, password, color: color ?? existing.color, lastUsedAt: Date.now(), needsReauth: false }
        : {
            id,
            serverUrl,
            username,
            password,
            color: color ?? pickAccountColor(selectServerAccounts(get()).map((a) => a.color)),
            lastUsedAt: Date.now(),
          };
      set((state) => ({
        accounts: existing ? state.accounts.map((a) => (a.id === id ? account : a)) : [...state.accounts, account],
        currentId: id,
      }));
      await persist();
      return account;
    },

    addAccount: async (username, password, color) => {
      const wasLoggedIn = useAuthStore.getState().isLoggedIn;
      // 登录会让服务器下发新账号的 cookie，覆盖掉当前账号的
      await api.login(username, password);
      const account = await get().recordLogin(username, password, color);
      set({ form: null });
      await afterAccountChanged(account);
      Toast.show({ type: "success", text1: successText(account, wasLoggedIn) });
    },

    reauth: async (accountId, password) => {
      const account = get().accounts.find((a) => a.id === accountId);
      if (!account) return;
      const wasLoggedIn = useAuthStore.getState().isLoggedIn;
      await api.login(account.username, password);
      const updated = await get().recordLogin(account.username, password);
      set({ form: null });
      await afterAccountChanged(updated);
      Toast.show({ type: "success", text1: successText(updated, wasLoggedIn) });
    },

    changePassword: async (accountId, newPassword) => {
      const account = get().accounts.find((a) => a.id === accountId);
      if (!account?.password) return;
      await api.changePassword(account.password, newPassword);
      const updated = await get().recordLogin(account.username, newPassword);
      await LoginCredentialsManager.save({ username: updated.username, password: newPassword });
      // 服务器改密码后旧 cookie 仍有效，这里用新密码重新登录换一份 cookie；失败不影响密码已修改的结果
      try {
        await api.login(updated.username, newPassword);
      } catch (error) {
        logger.error("Re-login after changing password failed:", error);
      }
      set({ form: null });
      Toast.show({ type: "success", text1: "密码已修改", text2: "本机保存的密码已同步更新" });
    },

    switchTo: async (accountId) => {
      const account = get().accounts.find((a) => a.id === accountId);
      if (!account || get().switchingTo) return;

      if (account.id === get().currentId && useAuthStore.getState().isLoggedIn) {
        set({ isPickerVisible: false, isPanelVisible: false });
        return;
      }
      if (!account.password || account.needsReauth) {
        get().openReauthForm(account.id);
        return;
      }

      set({ switchingTo: account, isPickerVisible: false, isPanelVisible: false });
      try {
        await api.login(account.username, account.password);
        const updated = await get().recordLogin(account.username, account.password);
        await afterAccountChanged(updated);
        Toast.show({ type: "success", text1: `已切换到 ${updated.username}` });
      } catch (error) {
        logger.error("Failed to switch account:", error);
        if (isUnauthorized(error)) {
          updateAccount(account.id, { needsReauth: true });
          await persist();
          get().openReauthForm(account.id);
        } else {
          Toast.show({ type: "error", text1: "切换失败", text2: "请检查网络或服务器地址是否可用" });
          if (!useAuthStore.getState().isLoggedIn) {
            set({ isPickerVisible: true });
          }
        }
      } finally {
        set({ switchingTo: null });
      }
    },

    logoutAccount: async (accountId) => {
      const account = get().accounts.find((a) => a.id === accountId);
      if (!account) return;
      const isCurrent = account.id === get().currentId;

      updateAccount(accountId, { password: undefined, needsReauth: false });
      if (!isCurrent) {
        await persist();
        return;
      }

      set({ currentId: null, isPanelVisible: false });
      await persist();
      try {
        await api.logout();
      } catch (error) {
        logger.error("Failed to logout:", error);
        await AsyncStorage.setItem("authCookies", "");
      }
      // 登出后登录弹窗不再自动带出密码
      await LoginCredentialsManager.save({ username: account.username, password: "" });
      useAuthStore.setState({ isLoggedIn: false, isLoginModalVisible: false });
      await useHomeStore.getState().refreshPlayRecords();
      fallbackToLogin();
    },

    logoutCurrent: async () => {
      const current = selectCurrentAccount(get());
      if (get().enabled && current) {
        await get().logoutAccount(current.id);
      } else {
        await useAuthStore.getState().logout();
      }
    },

    removeAccount: async (accountId) => {
      if (accountId === get().currentId) {
        await get().logoutAccount(accountId);
      }
      set((state) => ({
        accounts: state.accounts.filter((a) => a.id !== accountId),
      }));
      await persist();
      if (!useAuthStore.getState().isLoggedIn) {
        fallbackToLogin();
      }
    },

    // 打开应用时固定沿用上次登录的账号（原生 cookie 仍属于它），这里只补记旧版本的凭据
    handleLaunch: async () => {
      const state = get();
      if (!state.enabled || !state.loaded || !useAuthStore.getState().isLoggedIn) return;
      if (selectCurrentAccount(state)) return;

      // 旧版本只保存了一份凭据：已登录时把它补记为当前账号
      const credentials = await LoginCredentialsManager.get();
      if (credentials?.username && credentials.password) {
        await get().recordLogin(credentials.username, credentials.password);
      }
    },

    handleLoginRequired: async () => {
      const state = get();
      if (!state.enabled || !state.loaded || state.isRecovering || state.switchingTo || state.form) return;
      set({ isRecovering: true });
      try {
        const current = selectCurrentAccount(state);
        if (current?.password && !current.needsReauth) {
          // 登录失效时先用保存的密码静默重登
          try {
            await api.login(current.username, current.password);
            const updated = await get().recordLogin(current.username, current.password);
            await afterAccountChanged(updated);
            return;
          } catch (error) {
            logger.error("Silent re-login failed:", error);
            if (isUnauthorized(error)) {
              updateAccount(current.id, { needsReauth: true });
              await persist();
              useAuthStore.setState({ isLoginModalVisible: false });
              get().openReauthForm(current.id);
              return;
            }
            // 网络问题时换账号也一样会失败，提示后交给选择页或登录表单
            Toast.show({ type: "error", text1: "登录失败", text2: "请检查网络或服务器地址是否可用" });
          }
        }
        fallbackToLogin();
      } finally {
        set({ isRecovering: false });
      }
    },
  };
});

export default useAccountStore;
