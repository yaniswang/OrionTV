import React from "react";
import { StyleProp, StyleSheet, Text, View, ViewStyle } from "react-native";
import { getAccountTextColor } from "@/constants/AccountColors";

interface AccountAvatarProps {
  username: string;
  color: string;
  size: number;
  /** 右下角的「!」标记，表示需要重新登录 */
  showAlert?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** 账号头像：彩色圆底 + 用户名首字 */
export const AccountAvatar: React.FC<AccountAvatarProps> = ({ username, color, size, showAlert, style }) => {
  const initial = (Array.from(username.trim())[0] ?? "?").toUpperCase();
  const badgeSize = Math.round(size * 0.26);

  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        style,
      ]}
    >
      <Text style={{ color: getAccountTextColor(color), fontSize: size * 0.42, fontWeight: "bold" }}>{initial}</Text>
      {showAlert && (
        <View
          style={[
            styles.badge,
            { width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2, borderWidth: Math.max(2, size * 0.03) },
          ]}
        >
          <Text style={[styles.badgeText, { fontSize: badgeSize * 0.6 }]}>!</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    backgroundColor: "#f0a63a",
    borderColor: "#0f1012",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#2a1800",
    fontWeight: "bold",
  },
});
