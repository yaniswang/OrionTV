import React, { useState } from "react";
import { View, Text, StyleSheet, Platform, Pressable } from "react-native";
import { SkipBack, Rewind, Pause, Play, FastForward, SkipForward } from "lucide-react-native";
import { Segment, formatClock, formatDuration, dayLabel, dayStartOf } from "@/services/liveTimeline";
import { LC, KeyHint, LivePill, RoundButton } from "./LiveUI";

interface BarProps {
  channelName: string;
  seg: Segment;
  /** 当前（或正在选择的）播放时刻，UTC 毫秒 */
  position: number;
  /** 直播点，UTC 毫秒 */
  now: number;
  tz: number;
  paused: boolean;
  /** 上一段 / 下一段；下一段就是直播中的节目时 nextIsLive 为 true */
  prevSeg: Segment | null;
  nextSeg: Segment | null;
  nextIsLive: boolean;
  compact: boolean;
  onPrevSegment: () => void;
  onBack: () => void;
  onTogglePause: () => void;
  onForward: () => void;
  onNextSegment: () => void;
  onGoLive: () => void;
  onOpenEpg: () => void;
  /** 触屏点击进度条跳到某个时刻（UTC 毫秒） */
  onSeekTo: (t: number) => void;
}

const segTitle = (seg: Segment, tz: number) => seg.title ?? `${formatClock(seg.start, tz)} – ${formatClock(seg.end, tz)}`;

/** 时移 / 回看进度条 */
export default function LiveSeekBar(p: BarProps) {
  const { seg, position, now, tz } = p;
  const dur = seg.end - seg.start;
  const isShift = seg.end > now;
  const frac = (t: number) => `${Math.max(0, Math.min(1, (t - seg.start) / dur)) * 100}%` as const;
  const color = isShift ? LC.accent : LC.catchup;
  const [trackWidth, setTrackWidth] = useState(0);

  return (
    <View style={[styles.bar, p.compact && styles.barCompact]}>
      <View style={styles.titleRow}>
        <Text style={styles.channel}>{p.channelName}</Text>
        <Text style={styles.title} numberOfLines={1}>{segTitle(seg, tz)}</Text>
        {seg.title !== null && <Text style={styles.range}>{formatClock(seg.start, tz)} – {formatClock(seg.end, tz)}</Text>}
      </View>
      {/* 触屏点击进度条跳转；里面的元素不接收触摸，点击位置才是相对整条进度条的 */}
      <Pressable
        disabled={Platform.isTV}
        accessibilityRole="adjustable"
        accessibilityLabel="播放进度"
        hitSlop={{ top: 18, bottom: 18 }}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        onPress={(e) => {
          if (trackWidth <= 0) return;
          const f = Math.max(0, Math.min(1, e.nativeEvent.locationX / trackWidth));
          p.onSeekTo(seg.start + f * dur);
        }}
        style={styles.trackTouch}
      >
        <View style={styles.track} pointerEvents="none">
          <View style={[styles.done, { width: frac(position), backgroundColor: color }]} />
          {isShift && <View style={[styles.unavail, { left: frac(now) }]} />}
          {isShift && <View style={[styles.edge, { left: frac(now) }]} />}
          <View style={[styles.knob, { left: frac(position) }]} />
          <View style={[styles.bubbleWrap, { left: frac(position) }]}>
            <Text style={styles.bubble}>{formatClock(position, tz, true)}</Text>
          </View>
        </View>
      </Pressable>
      <View style={styles.labels}>
        {isShift ? (
          <>
            <Text style={styles.label}>{formatClock(seg.start, tz)}</Text>
            <Text style={[styles.label, { color: LC.liveText }]}>直播 {formatClock(now, tz)}</Text>
            <Text style={styles.label}>{formatClock(seg.end, tz)}</Text>
          </>
        ) : (
          <>
            <View style={styles.side}>
              {p.prevSeg && <Text style={styles.label} numberOfLines={1}>上一个：{segTitle(p.prevSeg, tz)}</Text>}
            </View>
            <Text style={[styles.label, styles.center]}>{formatDuration(position - seg.start)} / {formatDuration(dur)}</Text>
            <View style={[styles.side, styles.sideRight]}>
              {p.nextSeg && <Text style={styles.label} numberOfLines={1}>下一个：{segTitle(p.nextSeg, tz)}</Text>}
              {p.nextSeg && p.nextIsLive && <View style={{ marginLeft: 6 }}><LivePill text="直播中" /></View>}
            </View>
          </>
        )}
      </View>
      {Platform.isTV ? (
        <View style={styles.hints}>
          <KeyHint k="◀▶" label="快退 / 快进（长按加速）" />
          <KeyHint k="OK" label={p.paused ? "继续" : "暂停"} />
          <KeyHint k="▲▼" label="上 / 下一个节目" />
          <KeyHint k="长按 OK" label="节目单" />
          <KeyHint k="返回" label="回到直播" />
        </View>
      ) : (
        <View style={styles.ctrls}>
          <RoundButton label="上一个节目" onPress={p.onPrevSegment}><SkipBack color={LC.text} size={22} /></RoundButton>
          <RoundButton label="后退 30 秒" onPress={p.onBack} style={styles.gap}><Rewind color={LC.text} size={22} /></RoundButton>
          <RoundButton label={p.paused ? "继续" : "暂停"} onPress={p.onTogglePause} style={styles.gap}>
            {p.paused ? <Play color={LC.text} size={22} /> : <Pause color={LC.text} size={22} />}
          </RoundButton>
          <RoundButton label="前进 30 秒" onPress={p.onForward} style={styles.gap}><FastForward color={LC.text} size={22} /></RoundButton>
          <RoundButton label="下一个节目" onPress={p.onNextSegment} style={styles.gap}><SkipForward color={LC.text} size={22} /></RoundButton>
          <View style={{ flex: 1 }} />
          <RoundButton label="节目单" onPress={p.onOpenEpg} />
          <RoundButton label="回到直播" primary onPress={p.onGoLive} style={styles.gap} />
        </View>
      )}
    </View>
  );
}

/** 左上角角标：时移显示落后直播多久，回看显示日期和开始时间 */
/** tz：判断「今天 / 昨天」用的统计时区（北京时间）；displayTz：显示时间用的设备时区 */
export function PlaybackBadge({ seg, position, now, tz, displayTz, touch }: { seg: Segment; position: number; now: number; tz: number; displayTz: number; touch: boolean }) {
  const isShift = seg.end > now;
  const day = dayLabel(dayStartOf(position, tz), dayStartOf(now, tz), tz);
  return (
    <View style={[styles.badge, touch && styles.badgeTouch]} pointerEvents="none">
      <Text style={[styles.badgeKey, { backgroundColor: isShift ? LC.accent : LC.catchup }]}>{isShift ? "时移" : "回看"}</Text>
      <Text style={styles.badgeText}>
        {isShift ? `落后直播 ${formatDuration(now - position)}` : `${day.main} ${formatClock(position, displayTz)}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 36,
    paddingTop: 22,
    paddingBottom: 20,
    paddingHorizontal: 28,
    borderRadius: 16,
    backgroundColor: LC.bar,
    gap: 14,
  },
  barCompact: { left: 24, right: 24, bottom: 16, paddingTop: 14, paddingBottom: 14, paddingHorizontal: 20, gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: 14 },
  channel: { fontSize: 20, fontWeight: "700", color: LC.text },
  title: { fontSize: 18, color: LC.text, flexShrink: 1 },
  range: { fontSize: 14, color: LC.muted, fontVariant: ["tabular-nums"] },
  trackTouch: { marginTop: 26 },
  track: { height: 8, borderRadius: 4, backgroundColor: LC.line },
  done: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 4 },
  unavail: { position: "absolute", right: 0, top: 0, bottom: 0, backgroundColor: "#1d2229", borderTopRightRadius: 4, borderBottomRightRadius: 4 },
  edge: { position: "absolute", top: -6, bottom: -6, width: 3, marginLeft: -1, backgroundColor: LC.live, borderRadius: 2 },
  knob: { position: "absolute", top: -6, width: 20, height: 20, marginLeft: -10, borderRadius: 10, backgroundColor: LC.text },
  bubbleWrap: { position: "absolute", bottom: 18, width: 100, marginLeft: -50, alignItems: "center" },
  bubble: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: 6, overflow: "hidden", backgroundColor: LC.text, color: LC.dark, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  labels: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 13, color: LC.muted, fontVariant: ["tabular-nums"] },
  // 回看：左「上一个」、中间时长居中、右「下一个」；两侧等宽，中间才真正居中
  side: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  sideRight: { justifyContent: "flex-end" },
  center: { marginHorizontal: 16 },
  hints: { flexDirection: "row", flexWrap: "wrap", gap: 22 },
  ctrls: { flexDirection: "row", alignItems: "center" },
  gap: { marginLeft: 10 },
  badge: {
    position: "absolute",
    top: 28,
    left: 40,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: "rgba(10, 12, 16, 0.85)",
  },
  badgeTouch: { left: 88, top: 22 },
  badgeKey: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: 6, overflow: "hidden", fontWeight: "700", fontSize: 15, color: LC.dark, marginRight: 12 },
  badgeText: { fontSize: 16, color: LC.text, fontVariant: ["tabular-nums"] },
});
