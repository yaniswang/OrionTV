import React from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { Plus } from "lucide-react-native";
import useAccountStore, { selectServerAccounts } from "@/stores/accountStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { SavedAccount } from "@/services/storage";
import { Colors } from "@/constants/Colors";
import { ModalToastRoot } from "@/utils/Toast";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { AccountAvatar } from "./AccountAvatar";

const AVATAR_SIZE = 120;
const MOBILE_AVATAR_SIZE = 88;

/** 最近使用时间的简短描述 */
const formatLastUsed = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return "刚刚";
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

/** 当前账号登出或失效、需要重新选择账号时显示的「谁在看」 */
export const AccountPickerModal: React.FC = () => {
  const isMobile = useResponsiveLayout().deviceType === "mobile";
  const avatarSize = isMobile ? MOBILE_AVATAR_SIZE : AVATAR_SIZE;
  const itemStyle = isMobile ? [styles.item, styles.itemMobile] : styles.item;
  const isVisible = useAccountStore((state) => state.isPickerVisible);
  const currentId = useAccountStore((state) => state.currentId);
  const accounts = useAccountStore(useShallow(selectServerAccounts));
  const { hidePicker, switchTo, openAddForm } = useAccountStore.getState();
  const apiBaseUrl = useSettingsStore((state) => state.apiBaseUrl);

  const lastUsedId = accounts.reduce<SavedAccount | null>(
    (latest, a) => (!latest || a.lastUsedAt > latest.lastUsedAt ? a : latest),
    null
  )?.id;
  const focusId = currentId ?? lastUsedId;

  // 和旧登录弹窗一样允许返回键关闭，未登录时也能先去设置里改服务器地址
  const handleRequestClose = hidePicker;

  const renderSubtitle = (account: SavedAccount) => {
    if (!account.password || account.needsReauth) {
      return <Text style={[styles.subtitle, styles.warning]}>需重新登录</Text>;
    }
    if (account.id === lastUsedId) {
      return <Text style={styles.subtitle}>上次使用</Text>;
    }
    return <Text style={styles.subtitle}>{formatLastUsed(account.lastUsedAt)}</Text>;
  };

  return (
    <Modal visible={isVisible} animationType="fade" onRequestClose={handleRequestClose}>
      <ModalToastRoot>
        <View style={styles.container}>
          <Text style={styles.logo}>
            Orion<Text style={{ color: Colors.dark.primary }}>TV</Text>
          </Text>

          <View style={styles.heading}>
            <Text style={[styles.title, isMobile && styles.titleMobile]}>谁在看？</Text>
            <Text style={styles.description}>播放记录和收藏跟随账号</Text>
          </View>

          <View style={styles.list}>
            {accounts.map((account) => (
              <Pressable
                key={account.id}
                style={itemStyle}
                onPress={() => switchTo(account.id)}
                hasTVPreferredFocus={account.id === focusId}
              >
                {({ focused }) => (
                  <>
                    <View style={[styles.avatarRing, focused && styles.avatarRingFocused]}>
                      <AccountAvatar
                        username={account.username}
                        color={account.color}
                        size={avatarSize}
                        showAlert={!account.password || account.needsReauth}
                      />
                    </View>
                    <Text style={[styles.name, focused && styles.nameFocused]} numberOfLines={1}>
                      {account.username}
                    </Text>
                    {renderSubtitle(account)}
                  </>
                )}
              </Pressable>
            ))}

            <Pressable style={itemStyle} onPress={openAddForm} hasTVPreferredFocus={!focusId}>
              {({ focused }) => (
                <>
                  <View style={[styles.avatarRing, focused && styles.avatarRingFocused]}>
                    <View style={[styles.addAvatar, { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }]}>
                      <Plus color="#a3a3a8" size={44} />
                    </View>
                  </View>
                  <Text style={[styles.name, focused && styles.nameFocused]}>添加账号</Text>
                  <Text style={styles.subtitle}> </Text>
                </>
              )}
            </Pressable>
          </View>

          <View style={styles.footer}>
            <Text style={styles.hint}>{Platform.isTV ? "← → 选择　OK 进入" : "点按头像进入"}</Text>
          </View>

          {!!apiBaseUrl && <Text style={styles.server}>服务器 · {apiBaseUrl}</Text>}
        </View>
      </ModalToastRoot>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f1012",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  logo: {
    position: "absolute",
    top: 32,
    left: 48,
    color: "#f2f2f2",
    fontSize: 22,
    fontWeight: "bold",
  },
  heading: {
    alignItems: "center",
    marginBottom: 48,
  },
  title: {
    color: "#f2f2f2",
    fontSize: 40,
    fontWeight: "bold",
    lineHeight: 52,
  },
  description: {
    color: "#a3a3a8",
    fontSize: 17,
    marginTop: 8,
  },
  list: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    maxWidth: 1000,
  },
  titleMobile: {
    fontSize: 30,
    lineHeight: 40,
  },
  itemMobile: {
    width: 120,
    marginHorizontal: 10,
  },
  item: {
    width: 160,
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 24,
  },
  avatarRing: {
    padding: 5,
    borderRadius: AVATAR_SIZE,
    borderWidth: 4,
    borderColor: "transparent",
  },
  avatarRingFocused: {
    borderColor: Colors.dark.primary,
    transform: [{ scale: 1.08 }],
  },
  addAvatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: "#55575e",
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    color: "#c9c9ce",
    fontSize: 20,
    marginTop: 14,
  },
  nameFocused: {
    color: "#ffffff",
    fontWeight: "bold",
  },
  subtitle: {
    color: "#a3a3a8",
    fontSize: 14,
    marginTop: 4,
  },
  warning: {
    color: "#f0a63a",
  },
  footer: {
    alignItems: "center",
    marginTop: 24,
  },
  hint: {
    color: "#8c8c92",
    fontSize: 14,
  },
  server: {
    position: "absolute",
    left: 48,
    bottom: 28,
    color: "#8c8c92",
    fontSize: 13,
  },
});
