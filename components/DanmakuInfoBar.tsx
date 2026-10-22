import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AlertCircle, ChevronDown, RefreshCw, Search } from "lucide-react-native";
import {
  DANMAKU_EMPTY_ERROR,
  DANMAKU_NO_MATCH_ERROR,
  useDanmakuStore,
} from "@/stores/danmakuStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { cleanDanmakuTitle, formatDanmakuEpisodeTitle } from "@/services/danmaku";
import usePlayerStore from "@/stores/playerStore";

/** 与播放面板底部控制条背景一致（PlayerControls controlsOverlay） */
const CONTROL_BACKGROUND = "rgba(0, 0, 0, 0.4)";
const ERROR_COLOR = "#ffcf66";

/** 弹幕条数加千分位，如 19,061 */
const formatCount = (count: number): string =>
  String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const formatLoadedAt = (timestamp: number | null): string => {
  if (!timestamp) return "--";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** 弹幕源给出的视频时长（秒），格式与播放器时间一致 */
const formatDuration = (seconds: number | null): string => {
  if (!seconds || seconds <= 0) return "--";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
};

interface DanmakuInfoBarProps {
  pillRef?: React.RefObject<View>;
  downFocusTag?: number;
  preferFocus?: boolean;
  /** 所在面板是否可见；面板常驻不卸载，隐藏时需收起详情 */
  visible?: boolean;
}

export const DanmakuInfoBar: React.FC<DanmakuInfoBarProps> = ({
  pillRef,
  downFocusTag,
  preferFocus,
  visible = true,
}) => {
  const enabled = useDanmakuStore((state) => state.enabled);
  const comments = useDanmakuStore((state) => state.comments);
  const loading = useDanmakuStore((state) => state.loading);
  const error = useDanmakuStore((state) => state.error);
  const match = useDanmakuStore((state) => state.match);
  const matchMode = useDanmakuStore((state) => state.matchMode);
  const loadedAt = useDanmakuStore((state) => state.loadedAt);
  const videoDuration = useDanmakuStore((state) => state.videoDuration);
  const reload = useDanmakuStore((state) => state.reload);
  const danmakuApiUrl = useSettingsStore((state) => state.danmakuApiUrl);
  const setShowManual = usePlayerStore((state) => state.setShowDanmakuManualModal);
  const setDetailOpen = usePlayerStore((state) => state.setDanmakuDetailOpen);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);

  // 详情展开期间控制面板不自动隐藏，只能由返回键或点击面板以外区域关闭
  useEffect(() => {
    setDetailOpen(expanded);
  }, [expanded, setDetailOpen]);
  useEffect(() => () => setDetailOpen(false), [setDetailOpen]);

  if (!enabled) return null;

  const count = comments.length;
  const configured = !!danmakuApiUrl.trim();
  // 没匹配到、匹配到但 0 条都不是加载失败，只有网络/接口错误才算失败
  const unmatched = !loading && count === 0 && error === DANMAKU_NO_MATCH_ERROR;
  const empty =
    !loading && count === 0 && (!error || error === DANMAKU_EMPTY_ERROR);
  const failed = !!error && count === 0 && !unmatched && !empty;
  const baseStatusText = !configured
    ? "未配置弹幕API"
    : loading
      ? "弹幕加载中…"
      : unmatched
        ? "无匹配弹幕"
        : failed
          ? "弹幕加载失败"
          : empty
            ? "暂无弹幕"
            : `弹幕 ${count} 条`;
  // 胶囊空间有限，只显示状态，来源平台见详情
  const statusText = baseStatusText;
  const dotColor =
    failed
      ? "#ff6b6b"
      : unmatched || empty || !configured
        ? "#ffd166"
        : "#00bb5e";
  const sourceText = match
    ? `${cleanDanmakuTitle(match.animeTitle)}${
        match.episodeTitle ? ` · ${formatDanmakuEpisodeTitle(match)}` : ""
      }`
    : "--";
  return (
    <View style={styles.container} pointerEvents="box-none">
      <View style={styles.content}>
        <View style={styles.row}>
          <Pressable
            ref={pillRef}
            hasTVPreferredFocus={preferFocus}
            style={({ focused }) => [
              styles.pill,
              focused && styles.focused,
            ]}
            nextFocusDown={downFocusTag}
            onPress={() => setExpanded((value) => !value)}
            accessibilityLabel="查看弹幕加载详情"
          >
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
            <Text style={styles.pillText}>{statusText}</Text>
            <ChevronDown
              size={14}
              color="rgba(255,255,255,0.62)"
              style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}
            />
          </Pressable>

          <Pressable
            style={({ focused }) => [styles.iconButton, focused && styles.focused]}
            nextFocusDown={downFocusTag}
            onPress={() => void reload()}
            disabled={loading || !configured}
            accessibilityLabel="刷新弹幕"
          >
            {loading ? (
              <ActivityIndicator size="small" color="#00bb5e" />
            ) : (
              <RefreshCw size={15} color="white" />
            )}
          </Pressable>

          <Pressable
            style={({ focused }) => [styles.manualButton, focused && styles.focused]}
            nextFocusDown={downFocusTag}
            onPress={() => setShowManual(true)}
            accessibilityLabel="手动匹配弹幕"
          >
            <Search size={13} color="rgba(255,255,255,0.9)" />
            <Text style={styles.manualText}>手动</Text>
          </Pressable>
        </View>

        {expanded && (
          // 绝对定位时可用宽度受信息条本身限制，文字会被截断；套一层足够宽的透明承载层，
          // 面板在里面按内容自然展开，每行完整显示
          <View style={styles.detailHost} pointerEvents="box-none">
            <View style={styles.detail}>
              <Text style={styles.detailTitle}>弹幕加载详情</Text>
              {/* 关键数字放大：条数与时长 */}
              <View style={styles.statRow}>
                <View style={styles.stat}>
                  <Text style={styles.statValue}>{formatCount(count)}</Text>
                  <Text style={styles.statLabel}>弹幕数</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.stat}>
                  <Text style={styles.statValue}>{formatDuration(videoDuration)}</Text>
                  <Text style={styles.statLabel}>时长</Text>
                </View>
              </View>
              <DetailRow label="弹幕标题" value={sourceText} />
              <DetailRow label="来源平台" value={match?.source || "--"} />
              <DetailRow
                label="匹配模式"
                value={
                  matchMode === "manual"
                    ? "手动匹配"
                    : matchMode === "auto"
                      ? "自动匹配"
                      : "--"
                }
              />
              <DetailRow label="最近加载" value={formatLoadedAt(loadedAt)} />
              {!!error && (
                <View style={styles.errorRow}>
                  <AlertCircle size={13} color={ERROR_COLOR} />
                  <Text style={styles.detailError}>{error}</Text>
                </View>
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  );
};

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.detailRow}>
    <Text style={styles.detailLabel}>{label}</Text>
    <Text style={styles.detailValue}>
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  // 接在播放面板标题栏结尾，与标题同一行
  container: {
    flexShrink: 0,
    marginLeft: 8,
    zIndex: 20,
  },
  content: {
    alignItems: "flex-start",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pill: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 13,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: CONTROL_BACKGROUND,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  pillText: {
    color: "white",
    fontSize: 14,
    fontWeight: "bold",
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: CONTROL_BACKGROUND,
    alignItems: "center",
    justifyContent: "center",
  },
  manualButton: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: CONTROL_BACKGROUND,
  },
  manualText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 13,
  },
  focused: {
    borderColor: "#00bb5e",
    backgroundColor: "rgba(0,187,94,0.2)",
  },
  // 详情浮在胶囊下方，不撑高标题栏；承载层远宽于任何屏幕，面板按内容自然展开、不换行
  detailHost: {
    position: "absolute",
    top: 44,
    left: 0,
    width: 4000,
    alignItems: "flex-start",
  },
  // 浮在视频画面上，底色比控制条更深以保证文字可读
  detail: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(18,20,22,0.92)",
  },
  detailTitle: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  statRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: 10,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.16)",
  },
  stat: {
    alignItems: "flex-start",
  },
  statValue: {
    color: "white",
    fontSize: 20,
    fontWeight: "bold",
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    marginTop: 2,
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 30,
    marginHorizontal: 18,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  // 两列：标签统一宽度偏暗，数值左对齐偏亮；每行单行不换行，由内容撑开面板宽度
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 3,
  },
  detailLabel: {
    flexShrink: 0,
    width: 64,
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
  },
  detailValue: {
    flexShrink: 0,
    color: "rgba(255,255,255,0.92)",
    fontSize: 13,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.16)",
  },
  detailError: {
    flexShrink: 0,
    color: ERROR_COLOR,
    fontSize: 12,
  },
});

export default DanmakuInfoBar;
