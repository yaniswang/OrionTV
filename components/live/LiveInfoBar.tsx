import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Image, Platform } from "react-native";
import { EpgProgram, programIndexAt } from "@/services/epg";
import { formatClock } from "@/services/liveTimeline";
import { Channel } from "@/services/m3u";
import { LC, KeyHint, LivePill, ProgressBar, RoundButton } from "./LiveUI";

interface Props {
  channel: Channel;
  channelNo: number;
  programs: EpgProgram[] | undefined;
  tz: number;
  canTimeshift: boolean;
  compact: boolean;
  onPrevChannel: () => void;
  onNextChannel: () => void;
  onOpenPanel: () => void;
}

/** 直播信息条：换台后显示，进度按当前时间走 */
export default function LiveInfoBar({ channel, channelNo, programs, tz, canTimeshift, compact, onPrevChannel, onNextChannel, onOpenPanel }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const idx = programs ? programIndexAt(programs, now) : -1;
  const current = idx >= 0 ? programs![idx] : null;
  const next = programs ? (idx >= 0 ? programs[idx + 1] : programs.find((p) => p.start > now)) : undefined;

  return (
    <View style={[styles.bar, compact && styles.barCompact]}>
      <View style={styles.noCol}>
        <Text style={styles.no}>{String(channelNo).padStart(3, "0")}</Text>
        <View style={styles.logo}>
          {channel.logo ? <Image source={{ uri: channel.logo }} style={styles.logoImg} /> : null}
        </View>
      </View>
      <View style={styles.main}>
        <View style={styles.row}>
          <Text style={styles.name} numberOfLines={1}>{channel.name}</Text>
          <LivePill />
          <Text style={styles.group}>{channel.group}</Text>
        </View>
        {current && (
          <>
            <View style={styles.row}>
              <Text style={styles.time}>{formatClock(current.start, tz)} – {formatClock(current.end, tz)}</Text>
              <Text style={styles.title} numberOfLines={1}>{current.title}</Text>
            </View>
            <ProgressBar progress={(now - current.start) / (current.end - current.start)} />
          </>
        )}
        {next && (
          <View style={styles.row}>
            <Text style={styles.nextLabel}>下一个</Text>
            <Text style={styles.nextLabel}>{formatClock(next.start, tz)}</Text>
            <Text style={styles.nextTitle} numberOfLines={1}>{next.title}</Text>
          </View>
        )}
      </View>
      {Platform.isTV ? (
        <View style={styles.hints}>
          <KeyHint k="▲▼" label="换台" />
          <KeyHint k="OK" label="频道与节目单" />
          {canTimeshift && <KeyHint k="◀" label="时移回看" />}
        </View>
      ) : (
        <View style={styles.buttons}>
          <RoundButton label="上一台" onPress={onPrevChannel} />
          <RoundButton label="下一台" onPress={onNextChannel} style={styles.gap} />
          <RoundButton label="频道" primary onPress={onOpenPanel} style={styles.gap} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 36,
    paddingVertical: 24,
    paddingHorizontal: 28,
    borderRadius: 16,
    backgroundColor: LC.bar,
    flexDirection: "row",
    alignItems: "center",
  },
  barCompact: { left: 24, right: 24, bottom: 20, paddingVertical: 16, paddingHorizontal: 20 },
  noCol: { width: 96, alignItems: "center", marginRight: 24 },
  no: { fontSize: 36, fontWeight: "700", color: LC.accent, marginBottom: 8 },
  logo: { width: 80, height: 44, borderRadius: 8, backgroundColor: LC.row, overflow: "hidden" },
  logoImg: { width: "100%", height: "100%", resizeMode: "contain" },
  main: { flex: 1, minWidth: 0, justifyContent: "center", gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  name: { fontSize: 24, fontWeight: "700", color: LC.text, flexShrink: 1 },
  group: { fontSize: 14, color: LC.muted },
  time: { fontSize: 16, color: LC.muted, fontVariant: ["tabular-nums"] },
  title: { fontSize: 20, fontWeight: "500", color: LC.text, flex: 1 },
  nextLabel: { fontSize: 15, color: LC.muted },
  nextTitle: { fontSize: 15, color: LC.soft, flex: 1 },
  hints: { marginLeft: 24, gap: 10 },
  buttons: { flexDirection: "row", marginLeft: 20 },
  gap: { marginLeft: 10 },
});
