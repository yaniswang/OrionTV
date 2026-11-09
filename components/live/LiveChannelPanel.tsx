import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform, Image, TVFocusGuideView, BackHandler, ScrollView, FlatList, LayoutChangeEvent } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { ChevronLeft } from "lucide-react-native";
import { Channel } from "@/services/m3u";
import { EpgData, EpgProgram, findChannelPrograms, programIndexAt } from "@/services/epg";
import { Segment, daySegments, dayStartOf, dayLabel, formatClock, HOUR, catchupMaxAge } from "@/services/liveTimeline";
import { LC, KeyHint, LivePill, CatchupPill, ProgressBar, RoundButton } from "./LiveUI";

const DAY = 24 * HOUR;
/** 没写 catchup-days 时日期页签往前显示的天数 */
const DEFAULT_PAST_DAYS = 7;

/** 收藏分组：固定在分组列最上面 */
export const FAVORITE_GROUP = "★ 收藏";

interface Props {
  channels: Channel[];
  groups: string[];
  grouped: Record<string, Channel[]>;
  /** 打开时选中的分组：上次从哪个分组选的台就停在哪个分组 */
  initialGroup: string;
  /** 已收藏的频道 */
  favorites: Map<Channel, string>;
  /** 为空时（没拿到直播源 key）不显示收藏按钮 */
  onToggleFavorite?: (channel: Channel) => void;
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
  /** group：从哪个分组选的 */
  onSelectChannel: (channel: Channel, closePanel: boolean, group: string) => void;
  onPlaySegment: (channel: Channel, seg: Segment, group: string) => void;
  onClose: () => void;
  onBack: () => void;
}

type RowState = "past" | "now" | "future";
interface EpgRow { seg: Segment; state: RowState; playable: boolean }

const isTV = Platform.isTV;

/** 分组名估算宽度：汉字按 1 个字号宽，其余按 0.6 个（渲染前没法测量文字宽度） */
const estimateTextWidth = (text: string, fontSize: number) =>
  Array.from(text).reduce((sum, ch) => sum + (/[⺀-鿿＀-￯]/.test(ch) ? 1 : 0.6) * fontSize, 0);

const NO_CHANNELS: Channel[] = [];

/** 频道行高（含上下 marginVertical 2）：有当前节目时多一行节目名和进度条；小米电视实测 70 / 41 + 4 */
const CH_ROW_HEIGHT = 74;
// 触屏行有 minHeight 48
const CH_ROW_HEIGHT_NO_PROG = Platform.isTV ? 45 : 52;

/** 节目行高（含上下 marginVertical 2）：直播中的行多一条进度条；小米电视实测 92px / 113px（2 倍密度） */
const EPG_ROW_HEIGHT = Platform.isTV ? 46 : 52;
const EPG_ROW_HEIGHT_NOW = 56.5;

/** 电视上分组焦点停留多久后频道列才换成该分组 */
const GROUP_SWITCH_DELAY = 200;
/** 电视上频道焦点停留多久后右侧节目单才换成该频道 */
const EPG_SWITCH_DELAY = 200;
/** 电视上日期焦点停留多久后节目单才换成该日 */
const DAY_SWITCH_DELAY = 200;

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
        <Text style={[styles.groupText, compact && styles.groupTextCompact, selected && { color: LC.accent }, focused && { color: LC.onAccent }]} numberOfLines={1}>{name}</Text>
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
    favorite: boolean;
    /** 在「收藏」分组里刚取消收藏：变淡，离开分组后才消失 */
    removed: boolean;
    program: EpgProgram | null;
    now: number;
    onFocusChannel: (c: Channel) => void;
    onPressChannel: (c: Channel) => void;
    onLayout?: () => void;
  }>(function ChannelRow({ channel, no, playing, browsing, favorite, removed, program, now, onFocusChannel, onPressChannel, onLayout }, ref) {
    return (
      <Pressable
        ref={ref}
        onFocus={isTV ? () => onFocusChannel(channel) : undefined}
        onLayout={onLayout}
        onPress={() => onPressChannel(channel)}
        style={({ focused }) => [styles.row, styles.bigRow, styles.chRow, browsing && styles.rowSel, focused && styles.bigRowFocus, removed && styles.removed]}
      >
        {({ focused }) => (
          <>
            <View style={styles.chTop}>
              <Text style={styles.chNo}>{String(no).padStart(3, "0")}</Text>
              {channel.logo ? <Image source={{ uri: channel.logo }} style={styles.chLogo} /> : null}
              <Text style={[styles.chName, focused && { color: LC.onAccent }, playing && { color: LC.accent }]} numberOfLines={1}>{channel.name}</Text>
              {favorite && <Text style={styles.favStar}>★</Text>}
              {playing && <View style={styles.eq}><View style={[styles.eqBar, { height: 6 }]} /><View style={[styles.eqBar, { height: 12 }]} /><View style={[styles.eqBar, { height: 9 }]} /></View>}
            </View>
            {program && (
              <>
                <Text style={styles.chProg} numberOfLines={1}>{program.title}</Text>
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
  React.forwardRef<View, { row: EpgRow; tz: number; now: number; playing: boolean; hasCatchup: boolean; onPress: (row: EpgRow) => void; onFocusChange: (focused: boolean) => void; onLayout?: (e: LayoutChangeEvent) => void }>(
    function EpgRowView({ row, tz, now, playing, hasCatchup, onPress, onFocusChange, onLayout }, ref) {
      const { seg, state } = row;
      const label = seg.title ?? "";
      const timeText = seg.title === null
        ? `${formatClock(seg.start, tz)} – ${state === "now" ? "现在" : formatClock(seg.end, tz)}`
        : formatClock(seg.start, tz);
      const grayed = state === "future" || (state === "past" && !row.playable);
      return (
        <Pressable
          ref={ref}
          onLayout={onLayout}
          // 没播的节目焦点可以停（用来翻看预告），但按了没反应
          onPress={() => onPress(row)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          style={({ focused }) => [
            styles.row,
            styles.bigRow,
            styles.epRow,
            state === "now" && styles.epNow,
            playing && styles.rowSel,
            focused && styles.bigRowFocus,
          ]}
        >
          {({ focused }) => (
            <>
              <View style={styles.epLine}>
                <Text style={[styles.epTime, seg.title === null && { width: undefined }, grayed && { color: LC.dim }, focused && { color: LC.onAccent }]}>{timeText}</Text>
                <Text style={[styles.epTitle, grayed && { color: LC.dim }, focused && { color: LC.onAccent }]} numberOfLines={1}>{label}</Text>
                {state === "now" ? <LivePill text="直播中" /> : state === "past" && row.playable && hasCatchup ? <CatchupPill /> : null}
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
  const [selectedGroup, setSelectedGroup] = useState(p.initialGroup);
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
  // 电视上焦点在频道列移动时还没生效的「浏览中的频道」
  const pendingBrowse = useRef<Channel | null>(null);
  // 右侧节目单显示的频道和日期：电视上焦点在频道列移动时，停下 EPG_SWITCH_DELAY 后才换（节目单整列重建很重）。
  // 换频道时日期回到今天，两者放在同一个状态里一次更新
  const [epgView, setEpgView] = useState({ channel: p.currentChannel, day: 0 });
  const epgChannel = epgView.channel;
  const dayOffset = epgView.day;
  const setDayOffset = useCallback((day: number) => setEpgView((v) => (v.day === day ? v : { ...v, day })), []);
  // 电视上日期焦点停留 DAY_SWITCH_DELAY 后才换节目单（整天的节目全部渲染，连按时不能每格都换）；按 OK / 触屏点击立即换
  const dayTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => { if (dayTimer.current) clearTimeout(dayTimer.current); }, []);
  const pickDay = useCallback((day: number) => {
    if (dayTimer.current) clearTimeout(dayTimer.current);
    dayTimer.current = null;
    setDayOffset(day);
  }, []);
  const focusDay = useCallback((day: number) => {
    if (dayTimer.current) clearTimeout(dayTimer.current);
    dayTimer.current = setTimeout(() => {
      dayTimer.current = null;
      setDayOffset(day);
    }, DAY_SWITCH_DELAY);
  }, []);
  const epgTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => { if (epgTimer.current) clearTimeout(epgTimer.current); }, []);
  const showEpgOf = useCallback((c: Channel, delay: number) => {
    if (epgTimer.current) clearTimeout(epgTimer.current);
    epgTimer.current = null;
    const apply = () => {
      // 换频道时日期回到今天，还没生效的日期切换作废
      if (dayTimer.current) clearTimeout(dayTimer.current);
      dayTimer.current = null;
      if (pendingBrowse.current === c) {
        pendingBrowse.current = null;
        setBrowse(c);
      }
      setEpgView((v) => (v.channel === c && v.day === 0 ? v : { channel: c, day: 0 })); };
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
  const initialChannelFocusDone = useRef(false);
  const selectedDayRef = useCallback((v: View | null) => {
    dayFocus.targetRef(v);
    epgColFocus.targetRef(v);
  }, []);
  const channelListRef = useRef<FlatList<Channel>>(null);
  const groupListRef = useRef<FlashList<string>>(null);
  const dayScrollRef = useRef<ScrollView>(null);
  const daysScrolled = useRef(false);
  // 换了频道（回看天数可能不同）日期页签回到最右（今天）
  useEffect(() => { dayScrollRef.current?.scrollToEnd({ animated: false }); }, [epgView.channel]);

  // 电视打开面板时系统可能先把焦点给第一个分组，此时不能跟着切分组，否则定位不到当前频道
  const focusReady = useRef(!isTV);
  useEffect(() => {
    const timer = setTimeout(() => { focusReady.current = true; }, 400);
    return () => clearTimeout(timer);
  }, []);
  // 面板里频道以外的项获得焦点（离开了频道列）：还没生效的「浏览中的频道」立即生效，
  // 回到频道列（◀ / 返回键）时焦点才能落到最后停留的那一行
  const flushPendingBrowse = useCallback(() => {
    const pending = pendingBrowse.current;
    if (pending) {
      pendingBrowse.current = null;
      setBrowse(pending);
    }
  }, []);

  // 行组件都是 memo：传给行的回调要固定，否则每次面板渲染所有可见行都会重画
  const onFocusGroup = useCallback((g: string) => {
    flushPendingBrowse();
    if (!focusReady.current) return;
    // 移动中不改状态：每改一次整个面板都要重新渲染，慢的电视上每格要几百毫秒（日志实测 400～650ms / 格）。
    // 焦点停留 GROUP_SWITCH_DELAY 后选中标记和频道列一起换
    if (listGroupTimer.current) clearTimeout(listGroupTimer.current);
    listGroupTimer.current = setTimeout(() => {
      listGroupTimer.current = null;
      setSelectedGroup(g);
      setListGroup(g);
    }, GROUP_SWITCH_DELAY);
  }, []);

  // 返回键逐级后退：节目列表 → 日期 → 频道列；焦点在频道列 / 分组时交给直播页关闭面板
  const epgRowFocused = useRef(false);
  const dayFocused = useRef(false);
  const favBtnFocused = useRef(false);
  const onEpgRowFocusChange = useCallback((focused: boolean) => {
    epgRowFocused.current = focused;
    if (focused) flushPendingBrowse();
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
      if ((epgRowFocused.current || dayFocused.current || favBtnFocused.current) && channelRow) {
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
  // 节目行高：直播中且有节目名的行多一条进度条
  const epgLayout = useMemo(() => {
    const heights = rows.map((r) => (r.state === "now" && r.seg.title !== null ? EPG_ROW_HEIGHT_NOW : EPG_ROW_HEIGHT));
    const offsets: number[] = [];
    heights.reduce((sum, h, i) => { offsets[i] = sum; return sum + h; }, 0);
    return { heights, offsets };
  }, [rows]);

  // 分组列宽度自适应：最长分组名 + 行内边距 + 列内边距，各端一致按实际分组名算
  const groupColumnWidth = useMemo(() => {
    const fontSize = p.compact ? 14 : 16;
    const rowPadding = p.compact ? 8 : 14;
    const colPadding = p.compact ? 4 : 10;
    const longest = Math.max(0, ...p.groups.map((g) => estimateTextWidth(g, fontSize)));
    // 选中 / 聚焦时行会放大一点（TV 焦点缩放），多留几个像素
    return Math.min(GROUP_COLUMN_MAX, Math.max(GROUP_COLUMN_MIN, Math.ceil(longest + rowPadding * 2 + colPadding * 2 + 6)));
  }, [p.groups, p.compact]);

  // 「收藏」分组：取消收藏的行先留着（变淡），离开分组后才去掉，避免焦点突然跳走；新收藏的照常加入
  const favKeep = useRef<{ group: string; list: Channel[] }>({ group: "", list: [] });
  const favList = p.grouped[FAVORITE_GROUP];
  const favGroupChannels = useMemo(() => {
    if (listGroup !== FAVORITE_GROUP) return [];
    const kept = favKeep.current.group === FAVORITE_GROUP ? favKeep.current.list : [];
    const merged = new Set([...kept, ...(favList || [])]);
    return p.channels.filter((c) => merged.has(c));
  }, [listGroup, favList, p.channels]);
  favKeep.current = { group: listGroup, list: favGroupChannels };
  const groupChannels = listGroup === FAVORITE_GROUP ? favGroupChannels : p.grouped[listGroup] || NO_CHANNELS;
  // 频道行高：有当前节目时多一行节目名和进度条
  const channelLayout = useMemo(() => {
    const heights = groupChannels.map((c) => (currentProgram(epg, c, now) ? CH_ROW_HEIGHT : CH_ROW_HEIGHT_NO_PROG));
    const offsets: number[] = [];
    heights.reduce((sum, h, i) => { offsets[i] = sum; return sum + h; }, 0);
    return { heights, offsets };
  }, [groupChannels, epg, now]);
  // 频道列当前实际显示的分组（已渲染的），焦点进入频道列时以它为准
  const shownGroup = useRef(listGroup);
  shownGroup.current = listGroup;
  // 换分组后滚到该分组的落点行：共用一个列表，不处理会沿用上个分组的滚动位置，焦点进来时落在错位的行上
  const listGroupMounted = useRef(false);
  useEffect(() => {
    if (!listGroupMounted.current) {
      listGroupMounted.current = true;
      return;
    }
    if (groupChannels.length > 0) channelListRef.current?.scrollToIndex({ index: channelTargetIndex, animated: false });
  }, [listGroup]);
  const groupIndex = p.groups.indexOf(selectedGroup);
  // 频道列的落点：浏览中的频道；它不在当前分组（刚切了分组）时落到分组第一个频道
  const browseIndexInGroup = groupChannels.indexOf(browse);
  const channelTargetIndex = browseIndexInGroup >= 0 ? browseIndexInGroup : 0;


  const onFocusChannel = useCallback((c: Channel) => {
    // 分组列刚移到别的分组、频道列还没换过来时就按 ▶ 进了频道列：取消这次切换，分组退回频道列正在显示的分组。
    // 否则随后换列表会把有焦点的行卸掉，焦点丢失（小米电视实测）
    if (listGroupTimer.current) {
      clearTimeout(listGroupTimer.current);
      listGroupTimer.current = null;
      const shown = shownGroup.current;
      setSelectedGroup(shown);
      setListGroup(shown);
    }
    // 移动中不改状态（每改一次整个面板重新渲染，慢的电视上每格几百毫秒）：
    // 焦点停留 EPG_SWITCH_DELAY 后「浏览中的频道」和右侧节目单一起换；焦点离开频道列时立即生效（见 flushPendingBrowse）
    pendingBrowse.current = c;
    showEpgOf(c, EPG_SWITCH_DELAY);
  }, []);

  // 回调里读最新的 props / 节目单显示的频道
  const latest = useRef({ p, epgChannel, listGroup, dayOffset });
  latest.current = { p, epgChannel, listGroup, dayOffset };

  const onPressChannel = useCallback((c: Channel) => {
    pendingBrowse.current = null;
    setBrowse(c);
    showEpgOf(c, 0);
    // 电视：OK 切台并关闭；触屏：立即切台，面板不关，右侧换成该频道节目单
    latest.current.p.onSelectChannel(c, isTV, latest.current.listGroup);
  }, []);

  const onPressRow = useCallback((row: EpgRow) => {
    if (!row.playable) return;
    const { p: cur, epgChannel: ch, listGroup: g } = latest.current;
    if (row.state === "now") cur.onSelectChannel(ch, true, g);
    else cur.onPlaySegment(ch, row.seg, g);
  }, []);

  // 打开面板时当前频道那一行排好位置后给它焦点（与原频道列表一致，不用 hasTVPreferredFocus）
  const onChannelTargetLayout = useCallback(() => {
    if (initialChannelFocusDone.current) return;
    initialChannelFocusDone.current = true;
    if (!isTV || latest.current.p.focusEpg) return;
    setTimeout(() => channelFocus.target.current?.requestTVFocus(), 100);
  }, []);

  // 长按 OK / 菜单键打开时，节目单落点行（回看中 / 直播中）排好位置后给它焦点；只第一次，切换日期、频道不抢焦点
  const onEpgAnchorLayout = useCallback(() => {
    const { p: cur } = latest.current;
    if (isTV && cur.focusEpg && !initialEpgFocusDone.current && latest.current.epgChannel === cur.currentChannel) {
      initialEpgFocusDone.current = true;
      setTimeout(() => epgFocus.target.current?.requestTVFocus(), 100);
    }
  }, []);

  const channelExtra = useMemo(() => [browse, p.favorites], [browse, p.favorites]);
  const epgChannelFav = p.favorites.has(epgChannel);
  const onFavPress = useCallback(() => {
    const { p: cur, epgChannel: ch } = latest.current;
    cur.onToggleFavorite?.(ch);
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
              // 分组只有几十个，全部渲染：按需渲染时遥控器下移快了，慢的电视上还没渲染出来的分组是空白
              drawDistance={p.groups.length * 48}
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
            {listGroup === FAVORITE_GROUP && groupChannels.length === 0 && (
              <Text style={styles.banner}>
                {isTV ? "还没有收藏的频道。在频道上按 ▶ 进节目单，再按 ▲ 到「收藏」，按 OK 即可收藏。" : "还没有收藏的频道。点节目单上方的「收藏」即可收藏。"}
              </Text>
            )}
            {/* 用 FlatList 而不是 FlashList：FlashList 回收复用行，慢的电视上焦点移动和回收撞在一起会丢焦点
                （小米电视实测；上游 Shopify/flash-list#895、#1337 未修，v2 仍有）。FlatList 不复用行。
                所有分组共用一个列表：按分组重建列表时新列表渲染出行之前按 ▶ 焦点无处可落 */}
            <FlatList
              ref={channelListRef}
              data={groupChannels}
              extraData={channelExtra}
              // 行高给准：初始定位、换分组定位到落点行都靠它算位置
              getItemLayout={(_, index) => ({ length: channelLayout.heights[index], offset: channelLayout.offsets[index], index })}
              // 被裁剪的行会从原生视图树上摘掉，有焦点的行被摘掉焦点就丢了
              removeClippedSubviews={false}
              initialScrollIndex={channelTargetIndex > 0 ? channelTargetIndex : undefined}
              keyExtractor={(c, i) => `${c.id}-${i}`}
              renderItem={({ item, index }) => (
                <ChannelRow
                  ref={index === channelTargetIndex ? channelFocus.targetRef : undefined}
                  onLayout={index === channelTargetIndex && !initialChannelFocusDone.current ? onChannelTargetLayout : undefined}
                  channel={item}
                  no={channelNo.get(item) ?? 0}
                  playing={item === p.currentChannel}
                  browsing={item === browse}
                  favorite={p.favorites.has(item)}
                  removed={listGroup === FAVORITE_GROUP && !p.favorites.has(item)}
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
              {p.onToggleFavorite && (
                <View style={styles.chCard}>
                  <Text style={styles.chCardName} numberOfLines={1}>{epgChannel.name}</Text>
                  <Pressable
                    onPress={onFavPress}
                    onFocus={isTV ? () => { favBtnFocused.current = true; flushPendingBrowse(); } : undefined}
                    onBlur={isTV ? () => { favBtnFocused.current = false; } : undefined}
                    style={({ focused }) => [styles.favBtn, epgChannelFav && styles.favBtnOn, focused && styles.rowFocus]}
                  >
                    {({ focused }) => (
                      <Text style={[styles.favBtnText, epgChannelFav && { color: LC.accent }, focused && { color: LC.onAccent }]}>
                        {epgChannelFav ? "★ 已收藏" : "☆ 收藏"}
                      </Text>
                    )}
                  </Pressable>
                </View>
              )}
              {dayOffsets.length > 0 && (
                <TVFocusGuideView autoFocus ref={dayFocus.guideRef} style={styles.days}>
                  {/* 日期最多十来个，全部渲染：用 FlashList 时往左翻到还没渲染 / 宽度估计不准的页签，焦点会丢（小米电视实测） */}
                  <ScrollView
                    ref={dayScrollRef}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.daysContent}
                    // 今天、明天在最右边：首次显示时滚到最右
                    onContentSizeChange={() => {
                      if (daysScrolled.current) return;
                      daysScrolled.current = true;
                      dayScrollRef.current?.scrollToEnd({ animated: false });
                    }}
                  >
                    {dayOffsets.map((item) => {
                      const l = dayLabel(todayStart + item * DAY, todayStart, tz);
                      const sel = item === dayOffset;
                      return (
                        <Pressable
                          key={item}
                          ref={sel ? selectedDayRef : undefined}
                          onFocus={isTV ? () => { dayFocused.current = true; flushPendingBrowse(); focusDay(item); } : undefined}
                          onBlur={isTV ? () => { dayFocused.current = false; } : undefined}
                          onPress={() => pickDay(item)}
                          style={({ focused }) => [styles.day, sel && styles.rowSel, focused && styles.rowFocus]}
                        >
                          {({ focused }) => (
                            <>
                              <Text style={[styles.dayMain, sel && { color: LC.accent }, focused && { color: LC.onAccent }]}>{l.main}</Text>
                              <Text style={[styles.daySub, sel && { color: LC.accent }, focused && { color: LC.onAccentMuted }]}>{l.sub}</Text>
                            </>
                          )}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </TVFocusGuideView>
              )}
              {banner && <Text style={styles.banner}>{banner}</Text>}
              <TVFocusGuideView autoFocus ref={epgFocus.guideRef} style={styles.epList}>
                {/* FlatList 不复用行（FlashList 回收行会丢焦点，见频道列）；只渲染窗口附近的行，切换节目单比全部渲染轻 */}
                <FlatList
                  key={`${epgChannel.id}-${dayOffset}`}
                  data={rows}
                  showsVerticalScrollIndicator={false}
                  getItemLayout={(_, index) => ({ length: epgLayout.heights[index], offset: epgLayout.offsets[index], index })}
                  initialScrollIndex={epgAnchor > 2 ? epgAnchor - 2 : undefined}
                  removeClippedSubviews={false}
                  keyExtractor={(r) => String(r.seg.start)}
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
                      onLayout={index === epgAnchor ? onEpgAnchorLayout : undefined}
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
  // 小的项（分组、日期、收藏按钮）的焦点：主色底白字
  rowFocus: { backgroundColor: LC.accent, borderColor: LC.accent },
  // 大行（频道、节目单）的焦点：整行主色底面积太大，改为左侧主色竖条 + 绿灰底。
  // 平时也留 4px 透明左边框（左内边距相应减 4），获得焦点时内容不跳动
  bigRow: { borderLeftWidth: 4, borderLeftColor: "transparent", paddingLeft: 10 },
  bigRowFocus: { backgroundColor: LC.focusRow, borderLeftColor: LC.accent },
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
  favStar: { fontSize: 14, color: LC.accent, marginLeft: 6 },
  removed: { opacity: 0.45 },
  chCard: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: LC.line },
  chCardName: { flex: 1, fontSize: 18, fontWeight: "700", color: LC.text, marginRight: 12 },
  favBtn: { paddingVertical: 7, paddingHorizontal: 16, borderRadius: 18, borderWidth: 1, borderColor: "#3a414c", backgroundColor: "#1b1f26" },
  favBtnOn: { borderColor: LC.accentLine },
  favBtnText: { fontSize: 14, color: LC.soft },
  eq: { flexDirection: "row", alignItems: "flex-end", height: 14, gap: 2 },
  eqBar: { width: 3, backgroundColor: LC.accent, borderRadius: 1 },
  days: { height: 64, borderBottomWidth: 1, borderBottomColor: LC.line, paddingHorizontal: 10, justifyContent: "center" },
  daysContent: { alignItems: "center" },
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
