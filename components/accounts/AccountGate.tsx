import React, { useEffect } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, View } from "react-native";
import useAccountStore from "@/stores/accountStore";
import useAuthStore from "@/stores/authStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAccountLoginEnabled } from "@/hooks/useMultiAccount";
import { Colors } from "@/constants/Colors";
import { AccountAvatar } from "./AccountAvatar";
import { AccountPickerModal } from "./AccountPickerModal";
import { AccountPanel } from "./AccountPanel";
import { AccountFormModal } from "./AccountFormModal";

/** 切换账号期间的全屏等待页 */
const AccountSwitchingOverlay: React.FC = () => {
  const switchingTo = useAccountStore((state) => state.switchingTo);

  return (
    <Modal visible={!!switchingTo} animationType="fade">
      <View style={styles.switching}>
        {switchingTo && (
          <>
            <AccountAvatar username={switchingTo.username} color={switchingTo.color} size={120} />
            <ActivityIndicator size="large" color={Colors.dark.primary} style={styles.spinner} />
            <Text style={styles.switchingTitle}>正在切换到 {switchingTo.username}</Text>
            <Text style={styles.switchingDescription}>同步播放记录和收藏…</Text>
          </>
        )}
      </View>
    </Modal>
  );
};

/**
 * 多账号入口：接管登录与登录失效处理，并挂载选择页、账号面板与登录表单（TV、PAD、手机一致）。
 * 服务器不支持多用户（localstorage）时什么都不渲染，保持原有的登录弹窗流程。
 */
export const AccountGate: React.FC = () => {
  const enabled = useAccountLoginEnabled();
  const loaded = useAccountStore((state) => state.loaded);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const isLoginModalVisible = useAuthStore((state) => state.isLoginModalVisible);
  const apiBaseUrl = useSettingsStore((state) => state.apiBaseUrl);

  useEffect(() => {
    useAccountStore.getState().load();
  }, []);

  useEffect(() => {
    useAccountStore.getState().setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    if (enabled && loaded && isLoggedIn) {
      useAccountStore.getState().handleLaunch();
    }
  }, [enabled, loaded, isLoggedIn, apiBaseUrl]);

  useEffect(() => {
    if (enabled && loaded && isLoginModalVisible) {
      useAccountStore.getState().handleLoginRequired();
    }
  }, [enabled, loaded, isLoginModalVisible]);

  if (!enabled) return null;

  return (
    <>
      <AccountPickerModal />
      <AccountPanel />
      <AccountFormModal />
      <AccountSwitchingOverlay />
    </>
  );
};

const styles = StyleSheet.create({
  switching: {
    flex: 1,
    backgroundColor: "#0f1012",
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    marginTop: 28,
  },
  switchingTitle: {
    color: "#f2f2f2",
    fontSize: 28,
    fontWeight: "bold",
    marginTop: 20,
  },
  switchingDescription: {
    color: "#a3a3a8",
    fontSize: 16,
    marginTop: 8,
  },
});
