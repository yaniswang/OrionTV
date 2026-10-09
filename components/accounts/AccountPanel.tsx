import React, { useEffect, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyRound, LogOut, Plus } from "lucide-react-native";
import useAccountStore, { selectCurrentAccount, selectServerAccounts } from "@/stores/accountStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { Colors } from "@/constants/Colors";
import { SavedAccount } from "@/services/storage";
import { ModalToastRoot } from "@/utils/Toast";
import { isTVLongPressRelease } from "@/utils/TVLongPress";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { AccountAvatar } from "./AccountAvatar";

/**
 * 账号面板：快速切换、长按删除其他账号、添加账号、修改密码与登出。
 * TV / PAD 由首页顶栏头像打开、显示在右上角；手机由底部「账号」Tab 打开、从底部弹出。
 */
export const AccountPanel: React.FC = () => {
  const isMobile = useResponsiveLayout().deviceType === "mobile";
  const insets = useSafeAreaInsets();
  const isVisible = useAccountStore((state) => state.isPanelVisible);
  const current = useAccountStore(selectCurrentAccount);
  const accounts = useAccountStore(useShallow(selectServerAccounts));
  const { hidePanel, switchTo, openAddForm, openChangePasswordForm, logoutAccount, removeAccount } =
    useAccountStore.getState();
  const apiBaseUrl = useSettingsStore((state) => state.apiBaseUrl);

  const others = accounts.filter((a) => a.id !== current?.id);

  // 从修改密码表单取消回来时，焦点回到「修改密码」行；面板和表单都关掉后恢复默认焦点
  const form = useAccountStore((state) => state.form);
  const [refocusChangePassword, setRefocusChangePassword] = useState(false);
  useEffect(() => {
    if (!isVisible && !form) setRefocusChangePassword(false);
  }, [isVisible, form]);

  // 与 VideoCard.tv 的长按删除一致：长按后用标记跳过随后的 onPress
  const longPressTriggered = useRef(false);

  const handleRowPress = (account: SavedAccount) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    switchTo(account.id);
  };

  const handleRowLongPress = (account: SavedAccount, event: unknown) => {
    // TV 松手时会再发一次长按事件：本次长按到此结束，清掉标记以免吞掉下一次点击
    if (isTVLongPressRelease(event)) {
      longPressTriggered.current = false;
      return;
    }
    longPressTriggered.current = true;
    Alert.alert("删除账号", `确定要从本机删除「${account.username}」吗？保存的密码会一起删除。`, [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => removeAccount(account.id) },
    ]);
  };

  return (
    <Modal visible={isVisible && !!current} transparent animationType="fade" onRequestClose={hidePanel}>
      <ModalToastRoot>
        <Pressable style={styles.overlay} onPress={hidePanel} focusable={false}>
          {current && (
            <Pressable
              style={isMobile ? [styles.sheet, { paddingBottom: insets.bottom + 16 }] : styles.panel}
              focusable={false}
            >
              {isMobile && <View style={styles.sheetHandle} />}
              <View style={styles.header}>
                <AccountAvatar username={current.username} color={current.color} size={56} />
                <View style={styles.headerText}>
                  <Text style={styles.currentName} numberOfLines={1}>
                    {current.username}
                  </Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    当前账号 · {apiBaseUrl}
                  </Text>
                </View>
              </View>
              <View style={styles.divider} />

              {others.length > 0 && (
                <Text style={styles.sectionLabel}>切换到（{Platform.isTV ? "长按 OK" : "长按"}可删除）</Text>
              )}
              {others.map((account, index) => {
                const needsReauth = !account.password || account.needsReauth;
                return (
                  <Pressable
                    key={account.id}
                    onPress={() => handleRowPress(account)}
                    onLongPress={(event) => handleRowLongPress(account, event)}
                    delayLongPress={1000}
                    hasTVPreferredFocus={!refocusChangePassword && index === 0}
                    style={({ focused }) => [styles.row, focused && styles.rowFocused]}
                  >
                    <AccountAvatar username={account.username} color={account.color} size={40} />
                    <Text style={styles.rowText} numberOfLines={1}>
                      {account.username}
                    </Text>
                    {needsReauth && <Text style={styles.warning}>需重新登录</Text>}
                  </Pressable>
                );
              })}

              <Pressable
                onPress={openAddForm}
                hasTVPreferredFocus={!refocusChangePassword && others.length === 0}
                style={({ focused }) => [styles.row, focused && styles.rowFocused]}
              >
                <View style={styles.addIcon}>
                  <Plus color="#a3a3a8" size={20} />
                </View>
                <Text style={styles.rowText}>添加账号</Text>
              </Pressable>

              <View style={[styles.divider, styles.dividerSpaced]} />

              <Pressable
                onPress={() => {
                  setRefocusChangePassword(true);
                  openChangePasswordForm(current.id);
                }}
                hasTVPreferredFocus={refocusChangePassword}
                style={({ focused }) => [styles.row, styles.rowSmall, focused && styles.rowFocused]}
              >
                <KeyRound color="#c9c9ce" size={22} />
                <Text style={styles.actionText} numberOfLines={1}>
                  修改密码
                </Text>
              </Pressable>

              <Pressable
                onPress={() => logoutAccount(current.id)}
                style={({ focused }) => [styles.row, styles.rowSmall, focused && styles.rowFocused]}
              >
                <LogOut color="#c9c9ce" size={22} />
                <Text style={styles.actionText} numberOfLines={1}>
                  登出「{current.username}」
                </Text>
              </Pressable>
            </Pressable>
          )}
        </Pressable>
      </ModalToastRoot>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(5, 5, 7, 0.6)",
  },
  panel: {
    position: "absolute",
    top: 96,
    right: 32,
    width: 380,
    maxWidth: "90%",
    padding: 18,
    borderRadius: 16,
    backgroundColor: "#1c1d21",
    borderWidth: 1,
    borderColor: "#2e3035",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: "#1c1d21",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#3a3c42",
    marginBottom: 14,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: 14,
  },
  headerText: {
    flex: 1,
    marginLeft: 14,
  },
  currentName: {
    color: "#f2f2f2",
    fontSize: 20,
    fontWeight: "bold",
  },
  muted: {
    color: "#a3a3a8",
    fontSize: 13,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: "#2e3035",
  },
  dividerSpaced: {
    marginVertical: 8,
  },
  sectionLabel: {
    color: "#8c8c92",
    fontSize: 13,
    paddingTop: 12,
    paddingBottom: 4,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: 58,
    paddingHorizontal: 12,
    marginVertical: 2,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "transparent",
  },
  rowSmall: {
    height: 50,
  },
  rowFocused: {
    borderColor: Colors.dark.primary,
    backgroundColor: "#26282d",
  },
  rowText: {
    flex: 1,
    color: "#f2f2f2",
    fontSize: 18,
    marginLeft: 14,
  },
  actionText: {
    flex: 1,
    color: "#c9c9ce",
    fontSize: 16,
    marginLeft: 14,
  },
  warning: {
    color: "#f0a63a",
    fontSize: 13,
  },
  addIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: "#55575e",
    alignItems: "center",
    justifyContent: "center",
  },
});
