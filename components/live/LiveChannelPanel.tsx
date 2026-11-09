import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform, Image, TVFocusGuideView, BackHandler } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { ChevronLeft } from "lucide-react-native";
import { Channel } from "@/services/m3u";
import { EpgData, EpgProgram, findChannelPrograms, programIndexAt } from "@/services/epg";
import { Segment, daySegments, dayStartOf, dayLabel, formatClock, HOUR, catchupMaxAge } from "@/services/liveTimeline";
import { LC, KeyHint, LivePill, CatchupPill, ProgressBar, RoundButton } from "./LiveUI";

const DAY = 24 * HOUR;
/** 没写 catchup-days 时日期页签往前显示的天数 */
const DEFAULT_PAST_DAYS = 7;

interface Props {
  channels: Channel[];
  groups: string[];
  grouped: Record<string, Channel[]>;
  currentChannel: Channel;
  epg: EpgData | null;
  /** 统计时区（北京时间）：日期分界、整点时段 */
  tz: number;
  /** 显示时区（设备时区）：界面上的时间 */
  displayTz: number;
  /** 频道能否回看：声明了回看参数，且没被检测为不支持 */
  hasCatchup: (ch: Channel) => boolean;
  /** 没有任何节目单和回看能力时退回两列 */
  showEpgColumn: boolean;
  /** 手机：屏幕窄，分组列放宽、字号缩小，避免分组名被截断 */
  compact?: boolean;
  /** 菜单键打开：焦点直接进节目单 */
  focusEpg: boolean;
  /** 正在播放的段开头（回看中），用于高亮；直播为 null */
  playingSegStart: number | null;
  headerRight?: React.ReactNode;
  onSelectChannel: (channel: Channel, closePanel: boolean) => void;
  onPlaySegment: (channel: Channel, seg: Segment) => void;
  onClose: () => void;
  onBack: () => void;
}

type RowState = "past" | "now" | "future";
interface EpgRow { seg: Segment; state: RowState; playable: boolean }

const isTV = Platform.isTV;

/** 分组名估算宽度：汉字按 1 个字号宽，其余按 0.6 个（渲染前没法测量文字宽度） */
const estimateTextWidth = (text: string, fontSize: number) =>
  Array.from(text).reduce((sum, ch) => sum + (/[⺀-鿿＀-￯]/.test(ch) ? 1 : 0.6) * fontSize, 0);

/** 电视上分组焦点停留多久后频道列才换成该分组 */
const GROUP_SWITCH_DELAY = 200;
/** 电视上频道焦点停留多久后右侧节目单才换成该频道 */
const EPG_SWITCH_DELAY = 200;

/** 分组列宽度跟着最长的分组名走，限制在这个范围内 */
const GROUP_COLUMN_MIN = 64;
const GROUP_COLUMN_MAX = 180;

type GuideRef = React.ElementRef<typeof TVFocusGuideView>;

/**
 * 每一列一个焦点引导：焦点从别的列进来时，落到这一列的「当前项」（选中的分组 / 浏览中的频道 / 选中的日期 / 直播中或回看中的节目），
 * 而不是按位置就近落到同一高度的随便哪一项。当前项不在屏幕上时由 autoFocus 回到上次停留的位置。
 * 列表项异步渲染，挂载时再设置目标。
 */
function useColumnFocus() {
  const guide = useRef<GuideRef | null>(null);
  const target = useRef<View | null>(null);
  const apply = () => guide.current?.setDestinations(target.current ? [target.current] : []);
  const guideRef = useCallback((v: GuideRef | null) => {
    guide.current = v;
    apply();
  }, []);
  const targetRef = useCallback((v: View | null) => {
    target.current = v;
    apply();
  }, []);
  return { guideRef, targetRef, target };
}

/** 当前节目（频道列每行显示） */
function currentProgram(epg: EpgData | null, ch: Channel, now: number): EpgProgram | null {
  if (!epg) return null;
  const list = findChannelPrograms(epg, ch);
  if (!list) return null;
  const idx = programIndexAt(list, now);
  return idx >= 0 ? list[idx] : null;
}

const GroupRow = memo(React.forwardRef<View, { name: string; selected: boolean; compact: boolean; onPick: (g: string) => void; onFocusPick: (g: string) => void }>(function GroupRow({ name, selected, compact, onPick, onFocusPick }, ref) {
  return (
    <Pressable
      ref={ref}
      onFocus={isTV ? () => onFocusPick(name) : undefined}
      onPress={() => onPick(name)}
      style={({ focused }) => [styles.row, compact && styles.groupRowCompact, selected && styles.rowSel, focused && styles.rowFocus]}
    >
      {({ focused }) => (
        <Text style={[styles.groupText, compact && styles.groupTextCompact, selected && { color: LC.accent }, focused && { color: LC.dark }]} numberOfLines={1}>{name}</Text>
      )}
    </Pressable>
  );
}));

const ChannelRow = memo(
  React.forwardRef<View, {
    channel: Channel;
    no: number;
    playing: boolean;
    browsing: boolean;
    program: EpgProgram | null;
    now: number;
    onFocusChannel: (c: Channel) => void;
    onPressChannel: (c: Channel) => void;
  }>(function ChannelRow({ channel, no, playing, browsing, program, now, onFocusChannel, onPressChannel }, ref) {
    return (
      <Pressable
        ref={ref}
        onFocus={isTV ? () => onFocusChannel(channel) : undefined}
        onPress={() => onPressChannel(channel)}
        style={({ focused }) => [styles.row, styles.chRow, browsing && styles.rowSel, focused && styles.rowFocus]}
      >
        {({ focused }) => (
          <>
            <View style={styles.chTop}>
              <Text style={[styles.chNo, focused && { color: "#3c4450" }]}>{String(no).padStart(3, "0")}</Text>
              {channel.logo ? <Image source={{ uri: channel.logo }} style={styles.chLogo} /> : null}
              <Text style={[styles.chName, playing && { color: LC.accent }, focused && { color: LC.dark }]} numberOfLines={1}>{channel.name}</Text>
              {playing && <View style={styles.eq}><View style={[styles.eqBar, { height: 6 }]} /><View style={[styles.eqBar, { height: 12 }]} /><View style={[styles.eqBar, { height: 9 }]} /></View>}
            </View>
            {program && (
              <>
                <Text style={[styles.chProg, focused && { color: "#3c4450" }]} numberOfLines={1}>{program.title}</Text>
                <View style={styles.chBar}><ProgressBar height={3} progress={(now - program.start) / (program.end - program.start)} /></View>
              </>
            )}
          </>
        )}
      </Pressable>
    );
  }),
);

const EpgRowView = memo(
  React.forwardRef<View, { row: EpgRow; tz: number; now: number; playing: boolean; hasCatchup: boolean; onPress: (row: EpgRow) => void; onFocusChange: (focused: boolean) => void }>(
    function EpgRowView({ row, tz, now, playing, hasCatchup, onPress, onFocusChange }, ref) {
      const { seg, state } = row;
      const label = seg.title ?? "";
      const timeText = seg.title === null
        ? `${formatClock(seg.start, tz)} – ${state === "now" ? "现在" : formatClock(seg.end, tz)}`
        : formatClock(seg.start, tz);
      const grayed = state === "future" || (state === "past" && !row.playable);
      return (
        <Pressable
          ref={ref}
          // 没播的节目焦点可以停（用来翻看预告），但按了没反应
          onPress={() => onPress(row)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          style={({ focused }) => [
            styles.row,
            styles.epRow,
            state === "now" && styles.epNow,
            playing && styles.rowSel,
            focused && styles.rowFocus,
          ]}
        >
          {({ focused }) => (
            <>
              <View style={styles.epLine}>
                <Text style={[styles.epTime, seg.title === null && { width: undefined }, grayed && { color: LC.dim }, focused && { color: LC.dark }]}>{timeText}</Text>
                <Text style={[styles.epTitle, grayed && { color: LC.dim }, focused && { color: LC.dark }]} numberOfLines={1}>{label}</Text>
                {state === "now" ? <LivePill text="直播中" inverted={focused} /> : state === "past" && row.playable && hasCatchup ? <CatchupPill inverted={focused} /> : null}
              </View>
              {state === "now" && seg.title !== null && (
                <View style={styles.epBar}><ProgressBar height={3} progress={(now - seg.start) / (seg.end - seg.start)} /></View>
              )}
            </>
          )}
        </Pressable>
      );
    },
  ),
);

export default function LiveChannelPanel(p: Props) {
  const { epg, tz } = p;
  const [now] = useState(() => Date.now());
  const todayStart = dayStartOf(now, tz);
  const [selectedGroup, setSelectedGroup] = useState(p.currentChannel.group || "Other");
  // 频道列显示的分组：电视上焦点在分组列移动时，停下 GROUP_SWITCH_DELAY 后才换（换整列频道很重，连按时不能每格都换）
  const [listGroup, setListGroup] = useState(selectedGroup);
  const listGroupTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => { if (listGroupTimer.current) clearTimeout(listGroupTimer.current); }, []);
  const pickGroup = useCallback((g: string) => {
    if (listGroupTimer.current) clearTimeout(listGroupTimer.current);
    listGroupTimer.current = null;
    setSelectedGroup(g);
    setListGroup(g);
  }, []);
  const [browse, setBrowse] = useState<Channel>(p.currentChannel);
  // 右侧节目单显示的频道和日期：电视上焦点在频道列移动时，停下 EPG_SWITCH_DELAY 后才换（节目单整列重建很重）。
  // 换频道时日期回到今天，两者放在同一个状态里一次更新
  const [epgView, setEpgView] = useState({ channel: p.currentChannel, day: 0 });
  const epgChannel = epgView.channel;
  const dayOffset = epgView.day;
  const setDayOffset = useCallback((day: number) => setEpgView((v) => (v.day === day ? v : { ...v, day })), []);
  const epgTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => { if (epgTimer.current) clearTimeout(epgTimer.current); }, []);
  const showEpgOf = useCallback((c: Channel, delay: number) => {
    if (epgTimer.current) clearTimeout(epgTimer.current);
    epgTimer.current = null;
    const apply = () => setEpgView((v) => (v.channel === c && v.day === 0 ? v : { channel: c, day: 0 }));
    if (delay > 0) {
      epgTimer.current = setTimeout(() => {
        epgTimer.current = null;
        apply();
      }, delay);
    } else apply();
  }, []);

  const groupFocus = useColumnFocus();
  const channelFocus = useColumnFocus();
  const dayFocus = useColumnFocus();
  const epgFocus = useColumnFocus();
  // 整个节目单列的入口：从频道列按 ▶ 先落到选中的日期，再按 ▼ 才进节目列表
  const epgColFocus = useColumnFocus();
  const initialEpgFocusDone = useRef(false);
  const selectedDayRef = useCallback((v: View | null) => {
    dayFocus.targetRef(v);
    epgColFocus.targetRef(v);
  }, []);
  const channelListRef = useRef<FlashList<Channel>>(null);
  const groupListRef = useRef<FlashList<string>>(null);
  const epgListRef = useRef<FlashList<EpgRow>>(null);

  // 电视打开面板时系统可能先把焦点给第一个分组，此时不能跟着切分组，否则定位不到当前频道
  const focusReady = useRef(!isTV);
  useEffect(() => {
    const timer = setTimeout(() => { focusReady.current = true; }, 400);
    return () => clearTimeout(timer);
  }, []);
  // 行组件都是 memo：传给行的回调要固定，否则每次面板渲染所有可见行都会重画
  const onFocusGroup = useCallback((g: string) => {
    if (!focusReady.current) return;
    setSelectedGroup(g);
    if (listGroupTimer.current) clearTimeout(listGroupTimer.current);
    listGroupTimer.current = setTimeout(() => {
      listGroupTimer.current = null;
      setListGroup(g);
    }, GROUP_SWITCH_DELAY);
  }, []);

  // 返回键逐级后退：节目列表 → 日期 → 频道列；焦点在频道列 / 分组时交给直播页关闭面板
  const epgRowFocused = useRef(false);
  const dayFocused = useRef(false);
  const onEpgRowFocusChange = useCallback((focused: boolean) => {
    epgRowFocused.current = focused;
  }, []);
  useEffect(() => {
    if (!isTV) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const day = dayFocus.target.current;
      if (epgRowFocused.current && day) {
        day.requestTVFocus();
        return true;
      }
      const channelRow = channelFocus.target.current;
      if ((epgRowFocused.current || dayFocused.current) && channelRow) {
        channelRow.requestTVFocus();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const programs = useMemo(() => (epg ? findChannelPrograms(epg, epgChannel) : undefined), [epg, epgChannel]);
  const hasCatchup = p.hasCatchup(epgChannel);
  // m3u 写了 catchup-days 按它，否则 7 天
  const catchupDays = epgChannel.catchup?.days;
  const pastDays = catchupDays ?? DEFAULT_PAST_DAYS;
  const hasTomorrow = !!programs && programs.some((x) => x.start >= todayStart + DAY);
  const dayOffsets = useMemo(() => {
    if (!programs && !hasCatchup) return [];
    const list: number[] = [];
    for (let d = hasCatchup ? -pastDays : 0; d <= (hasTomorrow ? 1 : 0); d++) list.push(d);
    return list;
  }, [programs, hasCatchup, hasTomorrow, pastDays]);

  const rows = useMemo<EpgRow[]>(() => {
    if (dayOffsets.length === 0) return [];
    const dayStart = todayStart + dayOffset * DAY;
    return daySegments(programs, dayStart, tz)
      // 没有节目名的时段只在能回看时有意义，且不列未来的时段
      .filter((seg) => (seg.title !== null) || (hasCatchup && seg.start < now))
      .map((seg) => {
        const state: RowState = seg.end <= now ? "past" : seg.start <= now ? "now" : "future";
        const playable = state === "now" || (state === "past" && hasCatchup && seg.end > now - catchupMaxAge(catchupDays));
        return { seg, state, playable };
      });
  }, [programs, dayOffset, dayOffsets, hasCatchup, todayStart, tz, now]);

  const dayHasTitles = rows.some((r) => r.seg.title !== null);
  const banner = !programs
    ? hasCatchup
      ? epg ? "该频道暂无节目信息，可按时段回看" : "未获取到节目单，可按时段回看"
      : "该频道暂无节目信息"
    : !dayHasTitles && hasCatchup
      ? `${dayLabel(todayStart + dayOffset * DAY, todayStart, tz).main} 没有节目信息，可按时段回看`
      : null;

  const isBrowsingCurrent = epgChannel === p.currentChannel;
  const nowRowIndex = rows.findIndex((r) => r.state === "now");
  const playingIndex = isBrowsingCurrent && p.playingSegStart !== null ? rows.findIndex((r) => r.seg.start === p.playingSegStart) : -1;
  // 没有回看中 / 直播中的行（过去的日期）时落到第一行；落点为空会退回列表回收的旧视图，位置不可控
  const epgAnchor = playingIndex >= 0 ? playingIndex : nowRowIndex >= 0 ? nowRowIndex : 0;

  // 分组列宽度自适应：最长分组名 + 行内边距 + 列内边距，各端一致按实际分组名算
  const groupColumnWidth = useMemo(() => {
    const fontSize = p.compact ? 14 : 16;
    const rowPadding = p.compact ? 8 : 14;
    const colPadding = p.compact ? 4 : 10;
    const longest = Math.max(0, ...p.groups.map((g) => estimateTextWidth(g, fontSize)));
    // 选中 / 聚焦时行会放大一点（TV 焦点缩放），多留几个像素
    return Math.min(GROUP_COLUMN_MAX, Math.max(GROUP_COLUMN_MIN, Math.ceil(longest + rowPadding * 2 + colPadding * 2 + 6)));
  }, [p.groups, p.compact]);

  const groupChannels = p.grouped[listGroup] || [];
  const groupIndex = p.groups.indexOf(selectedGroup);
  const currentIndexInGroup = groupChannels.indexOf(p.currentChannel);
  // 频道列的落点：浏览中的频道；它不在当前分组（刚切了分组）时落到分组第一个频道
  const browseIndexInGroup = groupChannels.indexOf(browse);
  const channelTargetIndex = browseIndexInGroup >= 0 ? browseIndexInGroup : 0;

  const onFocusChannel = useCallback((c: Channel) => {
    setBrowse(c);
    showEpgOf(c, EPG_SWITCH_DELAY);
  }, []);

  // 回调里读最新的 props / 节目单显示的频道
  const latest = useRef({ p, epgChannel });
  latest.current = { p, epgChannel };

  const onPressChannel = useCallback((c: Channel) => {
    setBrowse(c);
    showEpgOf(c, 0);
    // 电视：OK 切台并关闭；触屏：立即切台，面板不关，右侧换成该频道节目单
    latest.current.p.onSelectChannel(c, isTV);
  }, []);

  const onPressRow = useCallback((row: EpgRow) => {
    if (!row.playable) return;
    const { p: cur, epgChannel: ch } = latest.current;
    if (row.state === "now") cur.onSelectChannel(ch, true);
    else cur.onPlaySegment(ch, row.seg);
  }, []);

  // 频道序号：预先建表，不在每行里对全部频道 indexOf
  const channelNo = useMemo(() => new Map(p.channels.map((c, i) => [c, i + 1])), [p.channels]);

  return (
    <View style={StyleSheet.absoluteFill}>
      {!isTV && <Pressable style={styles.peek} onPress={p.onClose} accessibilityLabel="关闭频道面板" />}
      {/* 焦点锁在面板内，不跑到后面的页面上 */}
      <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={[styles.panel, { width: p.showEpgColumn ? "86%" : "47%" }]}>
        <View style={styles.head}>
          {!isTV && <RoundButton label="返回" onPress={p.onBack}><ChevronLeft color={LC.text} size={24} /></RoundButton>}
          <Text style={[styles.headTitle, !isTV && { marginLeft: 8 }]}>频道</Text>
          {p.headerRight}
          {isTV && <Text style={styles.clock}>{formatClock(now, p.displayTz)}</Text>}
        </View>
        <View style={styles.cols}>
          <TVFocusGuideView autoFocus ref={groupFocus.guideRef} style={[styles.col, p.compact && styles.colCompact, { width: groupColumnWidth }]}>
            <Text style={styles.colHead}>分组</Text>
            <FlashList
              ref={groupListRef}
              data={p.groups}
              extraData={selectedGroup}
              estimatedItemSize={44}
              keyExtractor={(g, i) => `${g}-${i}`}
              onLoad={() => { if (groupIndex >= 0) groupListRef.current?.scrollToIndex({ index: groupIndex, animated: false }); }}
              renderItem={({ item }) => (
                <GroupRow
                  ref={item === selectedGroup ? groupFocus.targetRef : undefined}
                  name={item}
                  selected={item === selectedGroup}
                  compact={!!p.compact}
                  onPick={pickGroup}
                  onFocusPick={onFocusGroup}
                />
              )}
            />
          </TVFocusGuideView>
          <TVFocusGuideView autoFocus ref={channelFocus.guideRef} style={[styles.col, styles.colBorder, p.showEpgColumn ? { width: "38%" } : { flex: 1 }]}>
            <Text style={styles.colHead}>{listGroup} · {groupChannels.length}</Text>
            <FlashList
              ref={channelListRef}
              data={groupChannels}
              extraData={browse}
              estimatedItemSize={64}
              drawDistance={1500}
              initialScrollIndex={currentIndexInGroup >= 0 ? currentIndexInGroup : undefined}
              keyExtractor={(c, i) => `${c.id}-${i}`}
              onLoad={() => {
                if (currentIndexInGroup < 0) return;
                channelListRef.current?.scrollToIndex({ index: currentIndexInGroup, animated: false });
                // 与原频道列表一致：列表绘制完再给焦点，不用 hasTVPreferredFocus
                if (isTV && !p.focusEpg) setTimeout(() => channelFocus.target.current?.requestTVFocus(), 100);
              }}
              renderItem={({ item, index }) => (
                <ChannelRow
                  ref={index === channelTargetIndex ? channelFocus.targetRef : undefined}
                  channel={item}
                  no={channelNo.get(item) ?? 0}
                  playing={item === p.currentChannel}
                  browsing={item === browse}
                  program={currentProgram(epg, item, now)}
                  now={now}
                  onFocusChannel={onFocusChannel}
                  onPressChannel={onPressChannel}
                />
              )}
            />
          </TVFocusGuideView>
          {p.showEpgColumn && (
            <TVFocusGuideView autoFocus ref={epgColFocus.guideRef} style={[styles.colEpg, styles.colBorder]}>
              {dayOffsets.length > 0 && (
                <TVFocusGuideView autoFocus ref={dayFocus.guideRef} style={styles.days}>
                  <FlashList
                    horizontal
                    data={dayOffsets}
                    extraData={dayOffset}
                    estimatedItemSize={72}
                    initialScrollIndex={Math.max(0, dayOffsets.indexOf(0) - 3)}
                    keyExtractor={(d) => String(d)}
                    renderItem={({ item }) => {
                      const l = dayLabel(todayStart + item * DAY, todayStart, tz);
                      const sel = item === dayOffset;
                      return (
                        <Pressable
                          ref={sel ? selectedDayRef : undefined}
                          onFocus={isTV ? () => { dayFocused.current = true; setDayOffset(item); } : undefined}
                          onBlur={isTV ? () => { dayFocused.current = false; } : undefined}
                          onPress={() => setDayOffset(item)}
                          style={({ focused }) => [styles.day, sel && styles.rowSel, focused && styles.rowFocus]}
                        >
                          {({ focused }) => (
                            <>
                              <Text style={[styles.dayMain, sel && { color: LC.accent }, focused && { color: LC.dark }]}>{l.main}</Text>
                              <Text style={[styles.daySub, sel && { color: LC.accent }, focused && { color: LC.dark }]}>{l.sub}</Text>
                            </>
                          )}
                        </Pressable>
                      );
                    }}
                  />
                </TVFocusGuideView>
              )}
              {banner && <Text style={styles.banner}>{banner}</Text>}
              <TVFocusGuideView autoFocus ref={epgFocus.guideRef} style={styles.epList}>
                <FlashList
                  key={`${epgChannel.id}-${dayOffset}`}
                  ref={epgListRef}
                  data={rows}
                  estimatedItemSize={52}
                  initialScrollIndex={epgAnchor > 2 ? epgAnchor - 2 : undefined}
                  keyExtractor={(r) => String(r.seg.start)}
                  onLoad={() => {
                    // 长按 OK / 菜单键打开时只在第一次加载给焦点；切换日期、频道时列表会重新加载，不能再抢焦点
                    if (isTV && p.focusEpg && !initialEpgFocusDone.current && isBrowsingCurrent && epgAnchor >= 0) {
                      initialEpgFocusDone.current = true;
                      setTimeout(() => epgFocus.target.current?.requestTVFocus(), 100);
                    }
                  }}
                  renderItem={({ item, index }) => (
                    <EpgRowView
                      ref={index === epgAnchor ? epgFocus.targetRef : undefined}
                      row={item}
                      tz={p.displayTz}
                      now={now}
                      playing={index === playingIndex}
                      hasCatchup={hasCatchup}
                      onPress={onPressRow}
                      onFocusChange={onEpgRowFocusChange}
                    />
                  )}
                />
              </TVFocusGuideView>
            </TVFocusGuideView>
          )}
        </View>
        {isTV && (
          <View style={styles.foot}>
            <KeyHint k="OK" label="播放 / 回看" />
            <KeyHint k="返回" label="关闭" />
          </View>
        )}
      </TVFocusGuideView>
    </View>
  );
}

const styles = StyleSheet.create({
  peek: { ...StyleSheet.absoluteFillObject },
  panel: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: LC.panel },
  head: {
    height: 64,
    paddingHorizontal: Platform.isTV ? 28 : 16,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: LC.line,
    marginTop: Platform.isTV ? 0 : 8,
  },
  headTitle: { flex: 1, fontSize: 20, fontWeight: "700", color: LC.text },
  clock: { fontSize: 18, color: LC.text, fontVariant: ["tabular-nums"] },
  cols: { flex: 1, flexDirection: "row" },
  col: { paddingVertical: 12, paddingHorizontal: 10 },
  colBorder: { borderLeftWidth: 1, borderLeftColor: LC.line },
  colEpg: { flex: 1, minWidth: 0 },
  colHead: { fontSize: 13, color: LC.dim, paddingHorizontal: 12, paddingBottom: 6 },
  row: { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, marginVertical: 2, minHeight: Platform.isTV ? undefined : 48, justifyContent: "center" },
  rowSel: { backgroundColor: LC.row },
  rowFocus: { backgroundColor: LC.text },
  groupText: { fontSize: 16, color: LC.text },
  // 手机：分组列窄，收窄内边距、缩小字号，4～6 个字的分组名能完整显示
  colCompact: { paddingHorizontal: 4 },
  groupRowCompact: { paddingHorizontal: 8 },
  groupTextCompact: { fontSize: 14 },
  chRow: { paddingVertical: 9 },
  chTop: { flexDirection: "row", alignItems: "center" },
  chNo: { width: 36, fontSize: 13, color: LC.dim, fontVariant: ["tabular-nums"] },
  chLogo: { width: 20, height: 20, borderRadius: 4, marginRight: 6, resizeMode: "contain" },
  chName: { flex: 1, fontSize: 17, fontWeight: "500", color: LC.text },
  chProg: { fontSize: 13, color: LC.muted, paddingLeft: 36, marginTop: 4 },
  chBar: { paddingLeft: 36, marginTop: 4 },
  eq: { flexDirection: "row", alignItems: "flex-end", height: 14, gap: 2 },
  eqBar: { width: 3, backgroundColor: LC.accent, borderRadius: 1 },
  days: { height: 64, borderBottomWidth: 1, borderBottomColor: LC.line, paddingHorizontal: 10, justifyContent: "center" },
  day: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, marginHorizontal: 3, alignItems: "center" },
  dayMain: { fontSize: 14, color: LC.muted },
  daySub: { fontSize: 11, color: LC.dim },
  banner: { marginTop: 10, marginHorizontal: 10, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, overflow: "hidden", backgroundColor: "#1b2230", color: "#BFD9F7", fontSize: 13 },
  epList: { flex: 1, paddingHorizontal: 10, paddingTop: 10 },
  epRow: { paddingVertical: 10 },
  epNow: { backgroundColor: "rgba(255, 90, 95, 0.08)" },
  epLine: { flexDirection: "row", alignItems: "center", gap: 12 },
  epTime: { width: 52, fontSize: 15, color: LC.muted, fontVariant: ["tabular-nums"] },
  epTitle: { flex: 1, fontSize: 16, color: LC.soft },
  epBar: { marginTop: 8, paddingLeft: 64 },
  foot: { height: 52, paddingHorizontal: 28, borderTopWidth: 1, borderTopColor: LC.line, flexDirection: "row", alignItems: "center", gap: 22 },
});
