import React, { useState } from "react";
import { View, Text, StyleSheet, Platform, Pressable } from "react-native";
import { SkipBack, Rewind, Pause, Play, FastForward, SkipForward } from "lucide-react-native";
import { Segment, formatClock, formatDuration, dayLabel, dayStartOf } from "@/services/liveTimeline";
import { LC, KeyHint, LivePill, RoundButton, BOTTOM_STRIP } from "./LiveUI";

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
  // 触屏按钮：手机上与剧集控制条一样无底色、稍小
  const btnSize = p.compact ? 44 : 48;
  const iconSize = p.compact ? 20 : 22;
  const gap = p.compact ? styles.gapCompact : styles.gap;

  return (
    <View style={[styles.bar, p.compact && styles.barCompact]}>
      <View style={[styles.titleRow, p.compact && styles.titleRowCompact]}>
        <Text style={[styles.channel, p.compact && styles.channelCompact]}>{p.channelName}</Text>
        <Text style={[styles.title, p.compact && styles.titleCompact]} numberOfLines={1}>{segTitle(seg, tz)}</Text>
        {seg.title !== null && <Text style={[styles.range, p.compact && styles.rangeCompact]}>{formatClock(seg.start, tz)} – {formatClock(seg.end, tz)}</Text>}
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
        style={[styles.trackTouch, p.compact && styles.trackTouchCompact]}
      >
        <View style={[styles.track, p.compact && styles.trackCompact]} pointerEvents="none">
          <View style={[styles.done, { width: frac(position), backgroundColor: color }]} />
          {isShift && <View style={[styles.unavail, { left: frac(now) }]} />}
          {isShift && <View style={[styles.edge, { left: frac(now) }]} />}
          <View style={[styles.knob, p.compact && styles.knobCompact, { left: frac(position) }]} />
          <View style={[styles.bubbleWrap, p.compact && styles.bubbleWrapCompact, { left: frac(position) }]}>
            <Text style={[styles.bubble, p.compact && styles.bubbleCompact]}>{formatClock(position, tz, true)}</Text>
          </View>
        </View>
      </Pressable>
      {/* 手机：起止时间 / 时长并进按钮行中间，「上一个 / 下一个」节目名不显示（两端按钮就是上下一个节目） */}
      {!p.compact && <View style={styles.labels}>
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
      </View>}
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
          <RoundButton label="上一个节目" ghost size={btnSize} onPress={p.onPrevSegment}><SkipBack color={LC.text} size={iconSize} /></RoundButton>
          <RoundButton label="后退 30 秒" ghost size={btnSize} onPress={p.onBack} style={gap}><Rewind color={LC.text} size={iconSize} /></RoundButton>
          <RoundButton label={p.paused ? "继续" : "暂停"} ghost size={btnSize} onPress={p.onTogglePause} style={gap}>
            {p.paused ? <Play color={LC.text} size={iconSize} /> : <Pause color={LC.text} size={iconSize} />}
          </RoundButton>
          <RoundButton label="前进 30 秒" ghost size={btnSize} onPress={p.onForward} style={gap}><FastForward color={LC.text} size={iconSize} /></RoundButton>
          <RoundButton label="下一个节目" ghost size={btnSize} onPress={p.onNextSegment} style={gap}><SkipForward color={LC.text} size={iconSize} /></RoundButton>
          <View style={styles.ctrlCenter}>
            {p.compact && (isShift ? (
              <Text style={styles.label} numberOfLines={1}>
                {formatClock(seg.start, tz)} – {formatClock(seg.end, tz)} · <Text style={{ color: LC.liveText }}>直播 {formatClock(now, tz)}</Text>
              </Text>
            ) : (
              <Text style={styles.label} numberOfLines={1}>{formatDuration(position - seg.start)} / {formatDuration(dur)}</Text>
            ))}
          </View>
          <RoundButton label="节目单" ghost size={btnSize} onPress={p.onOpenEpg} />
          <RoundButton label="回到直播" primary size={btnSize} onPress={p.onGoLive} style={gap} />
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
  // 与剧集控制条一致：贴底通栏、半透明黑；内容离屏幕边缘的距离与原来的卡片一致（电视留出安全区）
  bar: {
    ...BOTTOM_STRIP,
    paddingTop: 22,
    paddingBottom: 56,
    paddingHorizontal: 68,
    gap: 14,
  },
  // 手机：横屏只有 360～410dp 高，原来约 185dp 挡住近一半画面；合并成标题、进度条、按钮三行
  barCompact: { paddingTop: 10, paddingBottom: 6, paddingHorizontal: 20, gap: 6 },
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: 14 },
  titleRowCompact: { gap: 10 },
  channel: { fontSize: 20, fontWeight: "700", color: LC.text },
  channelCompact: { fontSize: 15 },
  title: { fontSize: 18, color: LC.text, flexShrink: 1 },
  titleCompact: { fontSize: 14 },
  range: { fontSize: 14, color: LC.muted, fontVariant: ["tabular-nums"] },
  rangeCompact: { fontSize: 12 },
  trackTouch: { marginTop: 26 },
  trackTouchCompact: { marginTop: 22 },
  track: { height: 8, borderRadius: 4, backgroundColor: LC.line },
  trackCompact: { height: 6, borderRadius: 3 },
  done: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 4 },
  unavail: { position: "absolute", right: 0, top: 0, bottom: 0, backgroundColor: "#1d2229", borderTopRightRadius: 4, borderBottomRightRadius: 4 },
  edge: { position: "absolute", top: -6, bottom: -6, width: 3, marginLeft: -1, backgroundColor: LC.live, borderRadius: 2 },
  knob: { position: "absolute", top: -6, width: 20, height: 20, marginLeft: -10, borderRadius: 10, backgroundColor: LC.text },
  knobCompact: { top: -5, width: 16, height: 16, marginLeft: -8, borderRadius: 8 },
  bubbleWrap: { position: "absolute", bottom: 18, width: 100, marginLeft: -50, alignItems: "center" },
  bubbleWrapCompact: { bottom: 14 },
  bubble: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: 6, overflow: "hidden", backgroundColor: LC.text, color: LC.dark, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  bubbleCompact: { fontSize: 12, paddingHorizontal: 8 },
  labels: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 13, color: LC.muted, fontVariant: ["tabular-nums"] },
  // 回看：左「上一个」、中间时长居中、右「下一个」；两侧等宽，中间才真正居中
  side: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  sideRight: { justifyContent: "flex-end" },
  center: { marginHorizontal: 16 },
  hints: { flexDirection: "row", flexWrap: "wrap", gap: 22 },
  ctrls: { flexDirection: "row", alignItems: "center" },
  ctrlCenter: { flex: 1, alignItems: "center", paddingHorizontal: 8, minWidth: 0 },
  gap: { marginLeft: 10 },
  gapCompact: { marginLeft: 4 },
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
