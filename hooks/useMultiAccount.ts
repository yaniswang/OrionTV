import { useSettingsStore } from "@/stores/settingsStore";

/**
 * 是否启用多账号（新的登录表单、账号面板与「谁在看」）：TV、PAD、手机一致，
 * 只要服务器有用户体系即启用；localstorage 模式（只有密码、没有用户）仍使用原来的登录弹窗。
 */
export const useAccountLoginEnabled = () => {
  const serverConfig = useSettingsStore((state) => state.serverConfig);
  return !!serverConfig?.StorageType && serverConfig.StorageType !== "localstorage";
};
