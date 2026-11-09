/** 直播页共用的配色和小部件（与交互稿 Temp/epg-design 一致） */
import React from "react";
import { View, Text, StyleSheet, Pressable, StyleProp, ViewStyle } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { Colors } from "@/constants/Colors";

export const LC = {
  panel: "rgba(10, 12, 16, 0.95)",
  text: "#F2F4F7",
  muted: "#A3ACB9",
  dim: "#7F8896",
  soft: "#D5DAE1",
  line: "#2c323b",
  row: "#232830",
  /** 与应用主色一致 */
  accent: Colors.dark.primary,
  /** 大行（频道、节目单）焦点的底色，配左侧主色竖条 */
  focusRow: "#26332d",
  /** 焦点上的文字 */
  onAccent: "#FFFFFF",
  onAccentMuted: "rgba(255, 255, 255, 0.85)",
  /** 主色的半透明描边 */
  accentLine: "rgba(0, 187, 94, 0.5)",
  live: "#FF5A5F",
  liveText: "#FF7A7E",
  catchup: "#5AA9FF",
  catchupText: "#8EC4FF",
  dark: "#0B0D11",
};

/**
 * 底部控制条（信息条、时移 / 回看进度条）：与剧集控制条一样贴底通栏、半透明黑。
 * 剧集控制条几乎全是按钮用 0.4；直播这里文字多，0.4 在亮画面上看不清，用 0.6
 */
export const BOTTOM_STRIP: ViewStyle = { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0, 0, 0, 0.6)" };

/** 遥控器按键提示：[OK] 频道与节目单 */
export function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <View style={styles.hint}>
      <View style={styles.kc}><Text style={styles.kcText}>{k}</Text></View>
      <Text style={styles.hintText}>{label}</Text>
    </View>
  );
}

export function LivePill({ text = "直播" }: { text?: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: "rgba(255, 90, 95, 0.16)" }]}>
      <View style={styles.liveDot} />
      <Text style={[styles.pillText, { color: LC.liveText }]}>{text}</Text>
    </View>
  );
}

export function CatchupPill() {
  return (
    <View style={[styles.pill, styles.pillOutline]}>
      <Text style={[styles.pillText, { color: LC.catchupText }]}>回看</Text>
    </View>
  );
}

export function ProgressBar({ progress, height = 6, color = LC.accent }: { progress: number; height?: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }]}>
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: color }} />
    </View>
  );
}

/**
 * 触屏圆按钮，默认 48×48。
 * ghost：无底色（与剧集控制条一致，用在半透明控制条上）；size：高度（手机控制条用 44）
 */
export function RoundButton({ onPress, label, children, primary = false, ghost = false, size = 48, style }: {
  onPress: () => void;
  label: string;
  children?: React.ReactNode;
  primary?: boolean;
  ghost?: boolean;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        { minWidth: size, minHeight: size, borderRadius: size / 2, paddingHorizontal: size / 3 },
        children ? [styles.roundIcon, { width: size }] : null,
        ghost && styles.roundGhost,
        primary && styles.roundPrimary,
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      {children ?? <Text style={[styles.roundText, size < 48 && styles.roundTextSmall, primary && styles.roundTextPrimary]}>{label}</Text>}
    </Pressable>
  );
}

/** 触屏顶栏：返回 + 右侧扩展（投屏等） */
export function TouchTopBar({ onBack, right }: { onBack: () => void; right?: React.ReactNode }) {
  return (
    <View style={styles.topBar} pointerEvents="box-none">
      <RoundButton onPress={onBack} label="返回"><ChevronLeft color={LC.text} size={24} /></RoundButton>
      <View style={{ flex: 1 }} pointerEvents="none" />
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { flexDirection: "row", alignItems: "center" },
  kc: {
    minWidth: 36,
    paddingHorizontal: 8,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: "#3a414c",
    borderRadius: 6,
    backgroundColor: "#1b1f26",
    alignItems: "center",
    marginRight: 8,
  },
  kcText: { color: LC.text, fontSize: 13 },
  hintText: { color: LC.muted, fontSize: 14 },
  pill: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 1, borderRadius: 999 },
  pillOutline: { borderWidth: 1, borderColor: "rgba(90, 169, 255, 0.6)" },
  pillText: { fontSize: 13, fontWeight: "500" },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: LC.live, marginRight: 6 },
  track: { backgroundColor: LC.line, overflow: "hidden" },
  round: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  roundIcon: { paddingHorizontal: 0 },
  roundGhost: { backgroundColor: "transparent" },
  // 主按钮用应用主色
  roundPrimary: { backgroundColor: LC.accent },
  roundText: { color: LC.text, fontSize: 16 },
  roundTextSmall: { fontSize: 14 },
  roundTextPrimary: { color: LC.onAccent, fontWeight: "700" },
  topBar: { position: "absolute", top: 20, left: 24, right: 24, flexDirection: "row", alignItems: "center" },
});
