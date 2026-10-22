import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ChevronDown, RefreshCw, Search } from "lucide-react-native";
import { useDanmakuStore } from "@/stores/danmakuStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { cleanDanmakuTitle, formatDanmakuEpisodeTitle } from "@/services/danmaku";
import usePlayerStore from "@/stores/playerStore";

const formatLoadedAt = (timestamp: number | null): string => {
  if (!timestamp) return "--";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

interface DanmakuInfoBarProps {
  pillRef?: React.RefObject<View>;
  downFocusTag?: number;
  preferFocus?: boolean;
}

export const DanmakuInfoBar: React.FC<DanmakuInfoBarProps> = ({ pillRef, downFocusTag, preferFocus }) => {
  const enabled = useDanmakuStore((state) => state.enabled);
  const comments = useDanmakuStore((state) => state.comments);
  const loading = useDanmakuStore((state) => state.loading);
  const error = useDanmakuStore((state) => state.error);
  const match = useDanmakuStore((state) => state.match);
  const matchMode = useDanmakuStore((state) => state.matchMode);
  const loadedAt = useDanmakuStore((state) => state.loadedAt);
  const reload = useDanmakuStore((state) => state.reload);
  const danmakuApiUrl = useSettingsStore((state) => state.danmakuApiUrl);
  const setShowManual = usePlayerStore((state) => state.setShowDanmakuManualModal);
  const [expanded, setExpanded] = useState(false);

  if (!enabled) return null;

  const count = comments.length;
  const configured = !!danmakuApiUrl.trim();
  const failed = !!error && count === 0;
  const empty = !loading && !error && count === 0;
  const baseStatusText = !configured
    ? "未配置弹幕API"
    : loading
      ? "弹幕加载中…"
      : failed
        ? "弹幕加载失败"
        : empty
          ? "暂无弹幕"
          : `弹幕 ${count} 条`;
  const statusText = `${baseStatusText}${match?.source ? ` · ${match.source}` : ""}`;
  const dotColor =
    failed
      ? "#ff6b6b"
      : empty || !configured
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
          <View style={styles.detail}>
            <Text style={styles.detailTitle}>弹幕加载详情</Text>
            <DetailRow label="总条数" value={String(count)} />
            <DetailRow label="来源" value={sourceText} />
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
            {!!error && <Text style={styles.detailError}>{error}</Text>}
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
  container: {
    position: "absolute",
    top: 20,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 20,
  },
  content: {
    alignItems: "flex-start",
    maxWidth: "94%",
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
    backgroundColor: "rgba(0,0,0,0.72)",
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
    backgroundColor: "rgba(0,0,0,0.72)",
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
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  manualText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 13,
  },
  focused: {
    borderColor: "#00bb5e",
    backgroundColor: "rgba(0,187,94,0.2)",
  },
  detail: {
    maxWidth: "100%",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(0,0,0,0.86)",
  },
  detailTitle: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 13,
    fontWeight: "bold",
    marginBottom: 6,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 2,
  },
  detailLabel: {
    flexShrink: 0,
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
  },
  detailValue: {
    flexShrink: 1,
    color: "rgba(255,255,255,0.92)",
    fontSize: 12,
    textAlign: "right",
  },
  detailError: {
    marginTop: 6,
    color: "#ffb4b4",
    fontSize: 11,
  },
});

export default DanmakuInfoBar;
