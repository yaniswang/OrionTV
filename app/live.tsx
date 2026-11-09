import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { View, StyleSheet, ActivityIndicator, useTVEventHandler, HWEvent, Text, Platform, Pressable, BackHandler, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Cast, MonitorSmartphone, Power } from "lucide-react-native";
import { useRouter } from "expo-router";
import LivePlayer, { LivePlayerHandle, SeekPanHandlers, SIDE_ZONE, SWIPE_DISTANCE } from "@/components/LivePlayer";
import { fetchAndParseM3u, getPlayableUrl, Channel } from "@/services/m3u";
import { findChannelPrograms } from "@/services/epg";
import { buildCatchupUrl, catchupTemplate } from "@/services/catchup";
import { createTimeshiftUrl } from "@/services/localProxy";
import {
  Segment, segmentAt, nextSegment, prevSegment, playbackWindow,
  LIVE_GUARD, HOUR, catchupMaxAge,
} from "@/services/liveTimeline";
import { useEpg } from "@/hooks/useEpg";
import { probeCatchupUrl, PROBE_SECONDS } from "@/services/catchupProbe";
import useCatchupSupportStore, { catchupSupportOf } from "@/stores/catchupSupportStore";
import { ThemedView } from "@/components/ThemedView";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import * as ScreenOrientation from 'expo-screen-orientation';
import { Immersive } from 'react-native-immersive';
import useDlnaStore, { setLiveCatchupEndHandler } from "@/stores/dlnaStore";
import { DLNAStatusPanel } from "@/components/DLNAStatusPanel";
import { DLNADeviceModal } from "@/components/DLNADeviceModal";
import Toast from "@/utils/Toast";
import { useKeepAwake } from "expo-keep-awake";
import LiveInfoBar from "@/components/live/LiveInfoBar";
import LiveSeekBar, { PlaybackBadge } from "@/components/live/LiveSeekBar";
import LiveChannelPanel, { FAVORITE_GROUP } from "@/components/live/LiveChannelPanel";
import { loadLiveFavorites, addLiveFavorite, removeLiveFavorite } from "@/services/liveFavorites";
import { LC, KeyHint, RoundButton, TouchTopBar } from "@/components/live/LiveUI";

// 投屏入口只在手机和平板出现
const castAvailable = !Platform.isTV && (Platform.OS === 'android' || Platform.OS === 'ios');
const isTV = Platform.isTV;

/** 没有节目单时的统计时区：北京时间（分钟） */
const BEIJING_TZ = 480;
const CONTROLS_TIMEOUT = 5000;
/** 跳转后多久内不采用离目标太远的进度上报 */
const SEEK_GUARD_MS = 3000;
const SEEK_GUARD_TOLERANCE = 2000;
const LIVE_RETRY_LIMIT = 3;
const LIVE_RETRY_DELAY = 2000;
/** 单按一次 ◀▶ / 触屏按钮的步长 */
const SEEK_STEP = 30 * 1000;
/** 连续按键停止后多久真正跳转（避免每按一次都重新请求） */
const SEEK_COMMIT_DELAY = 800;
/** 长按加速：按住时长 → 每次步长 */
const longPressStep = (heldMs: number) => (heldMs < 1000 ? 10 * 1000 : heldMs < 3000 ? 30 * 1000 : 120 * 1000);
/** 时移清单末尾的片段要等代理下次刷新才有，跳转时离直播点再留一点 */
const SHIFT_TAIL_MARGIN = 10 * 1000;

interface Playback {
  seg: Segment;
  /** 本次回看请求的时间窗口（决定回看地址）；时移时 start 就是时移起点 */
  win: { start: number; end: number };
  /** 起播时刻 */
  startAt: number;
  /** 服务器实际返回到的时刻：只返回了一部分（如咪咕单次最多 8 小时）时由播放器加载后的时长得出 */
  actualEnd?: number;
  /** 时移：当前正在播出的段，由本地代理拼成持续增长的清单连续播放（不再播完一段就重新加载） */
  shift?: boolean;
  /** 代理返回的时移清单地址；创建中为空 */
  shiftUrl?: string;
  /** 代理不可用：退回固定一段的回看 */
  shiftFailed?: boolean;
}

/** 时移流（代理可用）：持续增长，没有固定结尾 */
const isShiftStream = (pb: Playback) => !!pb.shift && !pb.shiftFailed;

/** 本段实际能播到的时刻 */
const playbackEnd = (pb: Playback) =>
  isShiftStream(pb) ? Date.now() - LIVE_GUARD - SHIFT_TAIL_MARGIN : pb.actualEnd ?? pb.win.end;

export default function LiveScreen() {
  const { m3uUrl, m3uUa, epgUrl, liveSourceKey, liveSourceName } = useSettingsStore();
  const router = useRouter();
  // 投屏时本机播放器已卸载，页面层保持常亮（与剧集页一致）
  useKeepAwake();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType } = responsiveConfig;
  // deviceType 只按横竖屏分（横屏一律是 tv），直播页锁横屏后手机也是 tv，判断手机要看屏幕短边（< 600dp）
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const compact = !isTV && Math.min(screenWidth, screenHeight) < 600;

  useEffect(() => {
    if (isTV) return;
    // 手机和平板进入直播都锁横屏、开沉浸式，三端画面一致；退出时进来是竖屏的恢复竖屏，否则解除锁定
    const enteredPortrait = deviceType === 'mobile';
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    Immersive.on();
    return () => {
      if (enteredPortrait) void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      else void ScreenOrientation.unlockAsync();
      Immersive.off();
    }
  }, []);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, Channel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelFocusEpg, setPanelFocusEpg] = useState(false);
  const [epgReloadKey, setEpgReloadKey] = useState(0);
  const epg = useEpg(epgUrl, epgReloadKey);
  // 日期分界、整点时段、回看参数一律按北京时间（节目单时区）统计和分类；只在显示时换成设备时区
  const tz = epg?.tzOffsetMinutes ?? BEIJING_TZ;
  const displayTz = -new Date().getTimezoneOffset();

  const channel: Channel | undefined = channels[currentChannelIndex];
  const programs = useMemo(() => (epg && channel ? findChannelPrograms(epg, channel) : undefined), [epg, channel]);

  const isCasting = useDlnaStore((state) => state.enabled);
  const dlnaPhase = useDlnaStore((state) => state.phase);
  // 投屏回看时进度、时长、播放状态以电视为准
  const castPositionMillis = useDlnaStore((state) => state.positionMillis);
  const castDurationMillis = useDlnaStore((state) => state.durationMillis);
  const castIsPlaying = useDlnaStore((state) => state.isPlaying);
  // 每次推送新地址先清掉，电视确认开始播放这个地址后才置为 true
  const castPlaybackConfirmed = useDlnaStore((state) => state.playbackConfirmed);
  const [showDlnaDeviceModal, setShowDlnaDeviceModal] = useState(false);
  const autoOpenedDlnaDeviceModalRef = useRef(false);

  // 回看能力：m3u 声明了回看参数，且缓存里没记为不支持（按播放地址缓存，有记录就不出现回放入口）
  const supportEntries = useCatchupSupportStore((s) => s.entries);
  useEffect(() => { void useCatchupSupportStore.getState().load(); }, []);
  const channelHasCatchup = useCallback(
    (ch: Channel) => !!ch.catchup && catchupSupportOf(supportEntries, ch.url) !== false,
    [supportEntries],
  );
  const canCatchup = !!channel && channelHasCatchup(channel);
  const showEpgColumn = !!epg || channels.some((c) => !!c.catchup);

  // ---------- 播放状态：直播 / 时移 / 回看 ----------
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [position, setPosition] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [controls, setControls] = useState(false);
  const [now, setNow] = useState(Date.now());
  const playerRef = useRef<LivePlayerHandle>(null);

  // 遥控器、手势回调里读最新值
  // 当前频道的可回看时长：m3u 写了 catchup-days 按它，否则 7 天
  const maxAge = catchupMaxAge(channel?.catchup?.days);
  // 界面上的暂停状态：投屏回看以电视为准
  const shownPaused = isCasting && playback ? !castIsPlaying : paused;
  const st = useRef({ playback, position, pendingSeek, channel, programs, tz, canCatchup, paused: shownPaused, panelOpen, controls, maxAge, isCasting });
  st.current = { playback, position, pendingSeek, channel, programs, tz, canCatchup, paused: shownPaused, panelOpen, controls, maxAge, isCasting };

  // 时移 / 回看中每秒刷新直播点（角标「落后直播」、进度条红线）
  useEffect(() => {
    if (!playback && pendingSeek === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [!!playback, pendingSeek !== null]);

  const controlsTimer = useRef<NodeJS.Timeout | null>(null);
  const showControls = useCallback((autoHide = true) => {
    setControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = autoHide
      ? setTimeout(() => {
          controlsTimer.current = null;
          // 回看暂停中不自动收起（到点时再判断，任何操作重新计时都不会把暂停中的控制条收掉）
          if (st.current.paused && st.current.playback) return;
          setControls(false);
        }, CONTROLS_TIMEOUT)
      : null;
  }, []);
  useEffect(() => () => { if (controlsTimer.current) clearTimeout(controlsTimer.current); }, []);
  // 暂停时显示控制条
  useEffect(() => {
    if (shownPaused && playback) showControls(false);
  }, [shownPaused]);

  const commitTimer = useRef<NodeJS.Timeout | null>(null);
  const longPress = useRef<{ timer: NodeJS.Timeout; since: number } | null>(null);
  const clearSeekTimers = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    if (longPress.current) clearInterval(longPress.current.timer);
    longPress.current = null;
  };
  useEffect(() => clearSeekTimers, []);

  const goLive = useCallback(() => {
    clearSeekTimers();
    setPlayback(null);
    setPendingSeek(null);
    setPaused(false);
    setFailed(false);
  }, []);

  // 跳转后播放器（或电视）完成跳转前还会报一两次旧位置：这段时间里离目标太远的进度不采用，免得显示先退回原来的位置
  const seekGuard = useRef<{ target: number; until: number } | null>(null);
  const applyReportedPosition = (t: number) => {
    const guard = seekGuard.current;
    if (guard) {
      if (Date.now() < guard.until && Math.abs(t - guard.target) > SEEK_GUARD_TOLERANCE) return;
      seekGuard.current = null;
    }
    setPosition(t);
  };

  /** 从时刻 t 开始回看（自动选取所在的节目或整点时段） */
  const startPlaybackAt = useCallback((t: number, opts?: { paused?: boolean }) => {
    const s = st.current;
    if (!s.canCatchup) return;
    const nowMs = Date.now();
    if (t >= nowMs - LIVE_GUARD) {
      goLive();
      return;
    }
    const seg = segmentAt(s.programs, t, s.tz);
    const win = playbackWindow(seg, nowMs, s.maxAge);
    if (!win) {
      Toast.show({ type: 'info', text1: '该时段无法回看' });
      return;
    }
    const startAt = Math.min(Math.max(t, win.start), win.end - 1000);
    seekGuard.current = { target: startAt, until: Date.now() + SEEK_GUARD_MS };
    // 当前正在播出的段走时移流：本地代理从 startAt 起拼出持续增长的清单（播放器从清单开头播）。
    // 投屏不用：实测 Macast（mpv）把不带 ENDLIST 的清单当直播，跳到末尾播，进度报的是分片内部时间戳（26 小时），
    // 电视端行为不可控，投屏仍用固定一段的回看
    const shift = seg.end > nowMs && !s.isCasting;
    // 时移、投屏的地址都从目标时刻开始（电视从头播就是目标位置，不依赖各家电视不稳定的跳转）
    const pb: Playback = { seg, win: shift || s.isCasting ? { start: startAt, end: win.end } : win, startAt, shift };
    setPlayback(pb);
    setPosition(startAt);
    setPaused(!!opts?.paused);
    setFailed(false);
    showControls(!opts?.paused);
    const ch = s.channel;
    if (shift && ch?.catchup) {
      void createTimeshiftUrl(catchupTemplate(ch.url, ch.catchup), startAt, s.tz, LIVE_GUARD, m3uUa).then((shiftUrl) => {
        setPlayback((cur) => (cur === pb ? { ...pb, shiftUrl: shiftUrl ?? undefined, shiftFailed: !shiftUrl } : cur));
      });
    }
  }, [goLive, showControls, m3uUa]);

  // ---------- 回看能力检测（按播放地址缓存一年） ----------
  const probing = useRef(new Set<string>());
  /** 检测一个频道：服务器忽略回看参数、返回直播的记为不支持；正在回看它的话提示并回到直播 */
  const probeChannel = useCallback(async (ch: Channel) => {
    if (!ch.catchup || probing.current.has(ch.url)) return;
    if (catchupSupportOf(useCatchupSupportStore.getState().entries, ch.url) !== undefined) return;
    probing.current.add(ch.url);
    // 单独请求 2 小时前、长 PROBE_SECONDS（3 分 17 秒）的一段，核对返回的时长；与播放器一致用直播源的 UA，没配置就不带
    const start = Math.floor((Date.now() - 2 * HOUR) / 1000) * 1000;
    const probeUrl = buildCatchupUrl(ch.url, ch.catchup, start, start + PROBE_SECONDS * 1000, st.current.tz);
    const result = await probeCatchupUrl(probeUrl, m3uUa ? { "User-Agent": m3uUa } : {}, fetch, PROBE_SECONDS);
    probing.current.delete(ch.url);
    // 出错、非 m3u8（如版权屏蔽）判断不了，不缓存，下次再测
    if (result === null) return;
    useCatchupSupportStore.getState().record(ch.url, result === "ok", { name: ch.name, tvgId: ch.tvgId });
    if (result === "unsupported" && st.current.channel === ch && st.current.playback) {
      Toast.show({ type: "info", text1: "该频道不支持回看" });
      goLive();
    }
  }, [m3uUa, goLive]);

  /** 跳到时刻 t：本段内直接 seek，段外重新请求，追到直播点回到直播 */
  const seekTo = useCallback((t: number) => {
    const s = st.current;
    const nowMs = Date.now();
    const target = Math.max(t, nowMs - s.maxAge + 2 * 60 * 1000);
    const pb = s.playback;
    if (target >= nowMs - LIVE_GUARD) {
      goLive();
      return;
    }
    // 本机在已加载的范围内直接 seek；投屏一律重新推送从目标时刻开始的地址
    if (pb && !s.isCasting && target >= pb.win.start && target < playbackEnd(pb) - 1000) {
      seekGuard.current = { target, until: Date.now() + SEEK_GUARD_MS };
      playerRef.current?.seek((target - pb.win.start) / 1000);
      setPosition(target);
      return;
    }
    startPlaybackAt(target);
  }, [goLive, startPlaybackAt]);

  /** ◀▶ / 触屏按钮：累积目标时刻，停手后再跳转 */
  const nudge = useCallback((delta: number) => {
    const s = st.current;
    if (!s.canCatchup) return;
    const nowMs = Date.now();
    const base = s.pendingSeek ?? (s.playback ? s.position : nowMs);
    const target = Math.min(nowMs, Math.max(nowMs - s.maxAge + 2 * 60 * 1000, base + delta));
    st.current.pendingSeek = target;
    setPendingSeek(target);
    showControls();
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      setPendingSeek(null);
      seekTo(target);
    }, SEEK_COMMIT_DELAY);
  }, [seekTo, showControls]);

  const startLongPress = (dir: 1 | -1) => {
    if (longPress.current || !st.current.canCatchup) return;
    const since = Date.now();
    const timer = setInterval(() => nudge(dir * longPressStep(Date.now() - since)), 250);
    longPress.current = { timer, since };
  };
  const stopLongPress = () => {
    if (!longPress.current) return;
    clearInterval(longPress.current.timer);
    longPress.current = null;
  };

  /** 正在播的段：时移流会跨过节目边界，按当前播放位置算 */
  const currentSegment = (s: typeof st.current): Segment =>
    s.playback && !isShiftStream(s.playback) ? s.playback.seg : segmentAt(s.programs, s.playback ? s.position : Date.now(), s.tz);

  const playPrevSegment = useCallback(() => {
    const s = st.current;
    startPlaybackAt(prevSegment(s.programs, currentSegment(s), s.tz).start);
  }, [startPlaybackAt]);

  const playNextSegment = useCallback(() => {
    const s = st.current;
    if (!s.playback) return;
    const next = nextSegment(s.programs, currentSegment(s), s.tz);
    if (next.start >= Date.now() - LIVE_GUARD) goLive();
    else startPlaybackAt(next.start);
  }, [goLive, startPlaybackAt]);

  const togglePause = useCallback(() => {
    if (!st.current.playback) return;
    if (st.current.isCasting) void useDlnaStore.getState().togglePlayPause();
    else setPaused((v) => !v);
    showControls();
  }, [showControls]);

  // 本段播完：接着播下一段；追到直播点回到直播
  const handleEnd = useCallback(() => {
    const pb = st.current.playback;
    if (!pb) return;
    const end = playbackEnd(pb);
    if (end >= Date.now() - LIVE_GUARD - 5000) goLive();
    else startPlaybackAt(end);
  }, [goLive, startPlaybackAt]);

  // 服务器只返回了请求的一部分时，按实际时长修正本段结束时刻（地址不变，不重新加载）
  const handleLoad = useCallback((durationSec: number) => {
    const pb = st.current.playback;
    if (!pb || !(durationSec > 0)) return;
    const actual = pb.win.start + durationSec * 1000;
    if (actual < pb.win.end - 2000) setPlayback((cur) => (cur === pb ? { ...pb, actualEnd: actual } : cur));
  }, []);

  const handleProgress = useCallback((sec: number) => {
    const pb = st.current.playback;
    if (pb) applyReportedPosition(pb.win.start + sec * 1000);
  }, []);

  // 直播失败自动重试：源站推流时断时续（列表卡住）、直播窗口很短（落到窗口外）都是可恢复的，
  // 2 秒后从直播点重新加载，最多 3 次；开始正常播放或换了地址就清零。回看出错不重试
  const [reloadKey, setReloadKey] = useState(0);
  const liveRetries = useRef(0);
  const retryTimer = useRef<NodeJS.Timeout | null>(null);
  const handleFailed = useCallback(() => {
    if (!st.current.playback && liveRetries.current < LIVE_RETRY_LIMIT) {
      liveRetries.current++;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => setReloadKey((k) => k + 1), LIVE_RETRY_DELAY);
      return;
    }
    setFailed(true);
  }, []);
  const handlePlaying = useCallback(() => { liveRetries.current = 0; }, []);
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []);

  // ---------- 频道 ----------
  useEffect(() => {
    const loadChannels = async () => {
      if (!m3uUrl) return;

      setIsLoading(true);
      const parsedChannels = await fetchAndParseM3u(m3uUrl);
      setChannels(parsedChannels);

      const groups: Record<string, Channel[]> = parsedChannels.reduce((acc, ch) => {
        const groupName = ch.group || "Other";
        if (!acc[groupName]) {
          acc[groupName] = [];
        }
        acc[groupName].push(ch);
        return acc;
      }, {} as Record<string, Channel[]>);

      setGroupedChannels(groups);
      setChannelGroups(Object.keys(groups));

      if (parsedChannels.length > 0) {
        onChannelShown(parsedChannels[0].name);
      }
      setIsLoading(false);
    };
    loadChannels();
  }, [m3uUrl]);

  // ---------- 频道收藏（服务端，与网页版互通） ----------
  // 频道 → 服务端存储 key，按频道原顺序
  const [favorites, setFavorites] = useState<Map<Channel, string>>(new Map());
  useEffect(() => {
    if (!liveSourceKey || channels.length === 0) return;
    let cancelled = false;
    loadLiveFavorites(liveSourceKey, channels)
      .then((m) => { if (!cancelled) setFavorites(m); })
      .catch((e) => console.warn('加载直播收藏失败', e));
    return () => { cancelled = true; };
  }, [liveSourceKey, channels]);

  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  const toggleFavorite = useCallback(async (ch: Channel) => {
    if (!liveSourceKey) return;
    const order = new Map(channels.map((c, i) => [c, i]));
    const sorted = (m: Map<Channel, string>) => new Map([...m].sort((a, b) => order.get(a[0])! - order.get(b[0])!));
    const oldKey = favoritesRef.current.get(ch);
    // 先改界面，请求失败再改回来
    setFavorites((m) => {
      const next = new Map(m);
      if (oldKey) next.delete(ch);
      else next.set(ch, '');
      return sorted(next);
    });
    try {
      if (oldKey) {
        await removeLiveFavorite(oldKey);
        Toast.show({ type: 'info', text1: `已取消收藏 ${ch.name}` });
      } else {
        const key = await addLiveFavorite(liveSourceKey, liveSourceName, ch);
        setFavorites((m) => (m.has(ch) ? new Map(m).set(ch, key) : m));
        Toast.show({ type: 'success', text1: `已收藏 ${ch.name}`, text2: '在「收藏」分组里能找到' });
      }
    } catch (e) {
      setFavorites((m) => {
        const next = new Map(m);
        if (oldKey) next.set(ch, oldKey);
        else next.delete(ch);
        return sorted(next);
      });
      Toast.show({ type: 'error', text1: oldKey ? '取消收藏失败' : '收藏失败', text2: '请稍后重试' });
    }
  }, [channels, liveSourceKey, liveSourceName]);

  // 面板里的分组：「收藏」固定在最上面
  const panelGroups = useMemo(() => [FAVORITE_GROUP, ...channelGroups], [channelGroups]);
  const panelGrouped = useMemo<Record<string, Channel[]>>(
    () => ({ ...groupedChannels, [FAVORITE_GROUP]: [...favorites.keys()] }),
    [groupedChannels, favorites],
  );
  // 从哪个分组选的台，下次打开面板就停在哪个分组（该频道已不在那个分组时回到它自己的分组）
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  const channelGroup = channel && pickedGroup && panelGrouped[pickedGroup]?.includes(channel)
    ? pickedGroup
    : channel?.group || "Other";

  const onChannelShown = (title: string) => {
    if (useDlnaStore.getState().enabled) {
      Toast.show({ type: 'info', text1: `电视已切换到 ${title}` });
      return;
    }
    showControls();
  };

  const switchToChannel = useCallback((index: number) => {
    goLive();
    setCurrentChannelIndex(index);
    onChannelShown(channels[index].name);
  }, [channels, goLive]);

  // 换台按面板的分组顺序（收藏 → 各分组）走：在当前分组里切，到分组末尾接下一个分组，首尾循环
  const changeChannel = useCallback((direction: "next" | "prev") => {
    if (!channel) return;
    const seq = panelGroups.flatMap((g) => (panelGrouped[g] || []).map((c) => ({ g, c })));
    if (seq.length === 0) return;
    let pos = seq.findIndex((x) => x.g === channelGroup && x.c === channel);
    if (pos < 0) pos = seq.findIndex((x) => x.c === channel);
    const next = seq[(pos + (direction === "next" ? 1 : -1) + seq.length) % seq.length];
    const index = channels.indexOf(next.c);
    if (index < 0) return;
    setPickedGroup(next.g);
    switchToChannel(index);
  }, [channel, channels, channelGroup, panelGroups, panelGrouped, switchToChannel]);

  // 触屏：点面板外关闭面板时，同一次点击还会传到播放器，关闭后 300ms 内忽略点击（遥控器的 select 见 swallowNextSelect）
  const panelClosedAt = useRef(0);
  const closePanel = useCallback(() => {
    panelClosedAt.current = Date.now();
    setPanelOpen(false);
  }, []);

  const openPanel = useCallback((focusEpg: boolean) => {
    setPanelFocusEpg(focusEpg);
    setPanelOpen(true);
    setControls(false);
    // 节目单没拿到或过期时，打开面板静默重试
    setEpgReloadKey((k) => k + 1);
  }, []);

  // 面板里按 OK 选台 / 回看后面板关闭，同一次按键的 select 随后还会到页面一次，要吞掉。
  // 实测小米电视上晚到 570ms（JS 忙时更久），不能按固定时间窗判断：只吞紧接着的一次，1.5 秒后失效
  const swallowSelectUntil = useRef(0);
  const swallowNextSelect = () => {
    if (isTV) swallowSelectUntil.current = Date.now() + 1500;
  };

  const selectChannelFromPanel = useCallback((ch: Channel, shouldClose: boolean, group: string) => {
    const index = channels.indexOf(ch);
    if (index < 0) return;
    if (shouldClose) swallowNextSelect();
    setPickedGroup(group);
    if (index !== currentChannelIndex || st.current.playback) switchToChannel(index);
    if (shouldClose) closePanel();
  }, [channels, currentChannelIndex, switchToChannel, closePanel]);

  const playSegmentFromPanel = useCallback((ch: Channel, seg: Segment, group: string) => {
    const index = channels.indexOf(ch);
    if (index < 0) return;
    swallowNextSelect();
    setPickedGroup(group);
    if (index !== currentChannelIndex) {
      setCurrentChannelIndex(index);
      // 换台后 programs / canCatchup 要等下一次渲染，这里先手动写入
      st.current.channel = ch;
      st.current.programs = epg ? findChannelPrograms(epg, ch) : undefined;
      st.current.canCatchup = channelHasCatchup(ch);
      st.current.maxAge = catchupMaxAge(ch.catchup?.days);
    }
    closePanel();
    startPlaybackAt(seg.start);
  }, [channels, currentChannelIndex, epg, startPlaybackAt, closePanel, channelHasCatchup]);

  // ---------- 投屏（沿用原逻辑） ----------
  const selectedChannelUrl = channel ? getPlayableUrl(channel.url) : null;
  const currentChannelName = channel?.name ?? '';

  // 与剧集页一致：搜索结束且没有自动连上设备时，自动弹出设备列表
  useEffect(() => {
    if (!isCasting) {
      autoOpenedDlnaDeviceModalRef.current = false;
      setShowDlnaDeviceModal(false);
      return;
    }

    if (
      autoOpenedDlnaDeviceModalRef.current &&
      (dlnaPhase === 'connecting' || dlnaPhase === 'connected')
    ) {
      autoOpenedDlnaDeviceModalRef.current = false;
      setShowDlnaDeviceModal(false);
      return;
    }

    if (dlnaPhase !== 'selecting' || autoOpenedDlnaDeviceModalRef.current || showDlnaDeviceModal) {
      return;
    }

    const castState = useDlnaStore.getState();
    if (!castState.currentDevice && !castState.connectingDeviceId) {
      autoOpenedDlnaDeviceModalRef.current = true;
      setShowDlnaDeviceModal(true);
    }
  }, [dlnaPhase, isCasting, showDlnaDeviceModal]);

  const castConnected = isCasting && dlnaPhase === 'connected';

  // 本机和电视之间切换时，正在时移 / 回看的从当前位置接着播（电视从地址开头播，要按当前位置重新生成地址）
  const castingInitialized = useRef(false);
  useEffect(() => {
    if (!castingInitialized.current) {
      castingInitialized.current = true;
      return;
    }
    if (st.current.playback) startPlaybackAt(st.current.position);
  }, [isCasting]);

  // 离开直播页时结束投屏
  useEffect(() => {
    return () => {
      if (useDlnaStore.getState().enabled) {
        void useDlnaStore.getState().disableCast({ restoreLocal: false, stopRemote: true });
      }
    };
  }, []);

  const toggleCast = () => {
    setPanelOpen(false);
    const dlna = useDlnaStore.getState();
    if (dlna.enabled) {
      void dlna.disableCast({ restoreLocal: false, stopRemote: true });
      return;
    }
    if (!selectedChannelUrl) {
      Toast.show({ type: 'error', text1: '当前没有可投屏的频道' });
      return;
    }
    // 先按直播开启；正在回看的，开启后会按当前位置重新生成回看地址推过去
    void dlna.enableLiveCast({ url: selectedChannelUrl, title: currentChannelName, userAgent: m3uUa });
  };

  const openDeviceModal = () => {
    setPanelOpen(false);
    setShowDlnaDeviceModal(true);
  };

  const castButtons = castAvailable ? (
    <View style={styles.castActions}>
      {isCasting && (
        <RoundButton label="选择投屏设备" onPress={openDeviceModal}><MonitorSmartphone color="white" size={22} /></RoundButton>
      )}
      <RoundButton label={isCasting ? "结束投屏" : "投屏"} onPress={toggleCast} style={{ marginLeft: 8 }}>
        {isCasting ? <Power color="white" size={22} /> : <Cast color="white" size={22} />}
      </RoundButton>
    </View>
  ) : null;

  // ---------- 遥控器 ----------
  const handleTVEvent = useCallback(
    (event: HWEvent) => {
      if (!isTV) return;
      const s = st.current;
      if (s.panelOpen) return;
      const inPlayback = !!s.playback || s.pendingSeek !== null;

      if (event.eventType === "longLeft" || event.eventType === "longRight") {
        if (event.eventKeyAction === 1) stopLongPress();
        else if (event.eventKeyAction === 0 && (inPlayback || event.eventType === "longLeft")) {
          startLongPress(event.eventType === "longLeft" ? -1 : 1);
        }
        return;
      }

      switch (event.eventType) {
        case "longSelect":
          // 很多遥控器没有菜单键：长按 OK 打开节目单（按下满长按时长即打开，松键事件忽略）
          if (event.eventKeyAction === 0) openPanel(true);
          break;
        case "select":
          if (swallowSelectUntil.current) {
            const swallow = Date.now() < swallowSelectUntil.current;
            swallowSelectUntil.current = 0;
            if (swallow) break;
          }
          if (s.playback) togglePause();
          else openPanel(false);
          break;
        case "menu":
          openPanel(true);
          break;
        case "left":
          nudge(-SEEK_STEP);
          break;
        case "right":
          if (inPlayback) nudge(SEEK_STEP);
          else showControls();
          break;
        case "up":
          if (s.playback) playPrevSegment();
          else changeChannel("prev");
          break;
        case "down":
          if (s.playback) playNextSegment();
          else changeChannel("next");
          break;
      }
    },
    [changeChannel, nudge, openPanel, playNextSegment, playPrevSegment, showControls, togglePause]
  );

  useTVEventHandler(isTV ? handleTVEvent : () => {});

  // 返回键：关面板 → 收起信息条 / 进度条 → 回到直播 → 退出
  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      const s = st.current;
      if (s.panelOpen) {
        closePanel();
        return true;
      }
      // 信息条 / 进度条显示着：先收起；正在连按选时刻的，一并取消这次选择（不跳转）
      if (s.controls) {
        if (s.pendingSeek !== null) {
          clearSeekTimers();
          setPendingSeek(null);
        }
        if (controlsTimer.current) clearTimeout(controlsTimer.current);
        setControls(false);
        return true;
      }
      if (s.playback || s.pendingSeek !== null) {
        goLive();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [goLive]);

  // ---------- 触屏 ----------
  // 直播中单击打开频道列表；时移 / 回看中单击显示 / 隐藏控制条（与遥控器 OK 键一致）
  const onScreenTap = useCallback(() => {
    const s = st.current;
    // 点面板外空白处关闭面板时，同一次点击还会传到播放器这里，要忽略，否则面板马上又被打开
    if (s.panelOpen || Date.now() - panelClosedAt.current < 300) return;
    if (!s.playback && s.pendingSeek === null) {
      openPanel(false);
      return;
    }
    if (controls) {
      setControls(false);
    } else {
      showControls(!(st.current.playback && st.current.paused));
    }
  }, [controls, showControls, openPanel]);

  // 中间区域上下滑：直播中换台，时移 / 回看中切上 / 下一段节目（手指往上推 = 下一个）
  const onVerticalSwipe = useCallback((dir: 'up' | 'down') => {
    if (st.current.panelOpen) return;
    if (st.current.playback) {
      if (dir === 'up') playNextSegment();
      else playPrevSegment();
    } else {
      changeChannel(dir === 'up' ? 'next' : 'prev');
    }
  }, [changeChannel, playNextSegment, playPrevSegment]);

  const onDoubleTap = useCallback(() => {
    const s = st.current;
    if (!s.canCatchup) return;
    // 直播中暂停 = 进入时移（与按 ◀ 进入时移的起点一致，30 秒前）并停在暂停状态。
    // 投屏时用固定一段的回看，离直播太近只有一两秒，电视加载完就播完停止（画面消失）
    if (s.playback) togglePause();
    else {
      if (s.isCasting) pauseCastWhenPlaying.current = true;
      startPlaybackAt(Date.now() - SEEK_STEP, { paused: true });
    }
  }, [startPlaybackAt, togglePause]);

  /** 投屏时双击暂停：等电视开始播放这段回看后再暂停 */
  const pauseCastWhenPlaying = useRef(false);

  const panRef = useRef({ base: 0, span: 0, target: null as number | null });
  const seekPan: SeekPanHandlers | null = canCatchup ? {
    begin: () => {
      const s = st.current;
      const nowMs = Date.now();
      const seg = s.playback?.seg ?? segmentAt(s.programs, nowMs, s.tz);
      // 整屏宽度对应的时长：本段长度，限制在 5 分钟到 1 小时
      panRef.current = {
        base: s.playback ? s.position : nowMs,
        span: Math.min(HOUR, Math.max(5 * 60 * 1000, seg.end - seg.start)),
        target: null,
      };
      clearSeekTimers();
    },
    update: (fraction) => {
      const nowMs = Date.now();
      const p = panRef.current;
      const target = Math.min(nowMs, Math.max(nowMs - st.current.maxAge + 2 * 60 * 1000, p.base + fraction * p.span));
      p.target = target;
      setPendingSeek(target);
      showControls(false);
    },
    end: () => {
      const target = panRef.current.target;
      setPendingSeek(null);
      showControls();
      if (target !== null) seekTo(target);
    },
  } : null;

  // ---------- 渲染 ----------
  // 时移流：代理地址（创建中为空，先不加载）；代理不可用或已播完的段：固定一段的回看地址
  const url = channel
    ? playback && channel.catchup
      ? isShiftStream(playback)
        ? playback.shiftUrl ?? null
        : buildCatchupUrl(channel.url, channel.catchup, playback.win.start, playback.win.end, tz)
      : getPlayableUrl(channel.url)
    : null;

  // 换了播放地址（换台、进出回看）：直播重试次数清零，取消还没执行的重试
  useEffect(() => {
    liveRetries.current = 0;
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, [url]);

  // 回看一开始就在后台检测一次（不影响播放）
  useEffect(() => {
    if (!playback || !channel?.catchup) return;
    void probeChannel(channel);
  }, [url]);

  // 投屏：连上后、换台、进出回看、回看跳转时，把当前地址推给电视（同一地址不会重复下发）
  useEffect(() => {
    if (!castConnected || !url) return;
    const title = playback ? `${currentChannelName} · ${isShiftStream(playback) ? '时移' : '回看'}` : currentChannelName;
    // 时移流没有结尾，不当作「播完接下一段」的回看
    void useDlnaStore.getState().castLiveChannel({ url, title, userAgent: m3uUa, catchup: !!playback && !isShiftStream(playback) });
  }, [castConnected, url]);

  // 投屏时双击暂停：电视确认开始播放这段回看后再发暂停（推送新地址时电视总是开始播放）。
  // 不能看 isPlaying：换地址时的短暂 STOPPED 被投屏模块忽略，isPlaying 一直是 true 不会变化
  useEffect(() => {
    if (!castPlaybackConfirmed || !pauseCastWhenPlaying.current) return;
    pauseCastWhenPlaying.current = false;
    if (useDlnaStore.getState().isPlaying) void useDlnaStore.getState().togglePlayPause();
  }, [castPlaybackConfirmed]);

  // 投屏回看：进度换算成时刻；电视报出的时长比请求短时修正本段结束时刻
  useEffect(() => {
    if (isCasting && playback) applyReportedPosition(playback.win.start + castPositionMillis);
  }, [castPositionMillis]);
  useEffect(() => {
    if (isCasting && castDurationMillis > 0) handleLoad(castDurationMillis / 1000);
  }, [castDurationMillis]);

  // 投屏回看播到结尾：接下一段或回到直播（由投屏模块在电视停止时回调，不退出投屏）
  useEffect(() => {
    if (!isCasting) return;
    setLiveCatchupEndHandler(handleEnd);
    return () => setLiveCatchupEndHandler(null);
  }, [isCasting, handleEnd]);


  const displayPos = pendingSeek ?? (playback ? position : now);
  // 时移流会跨过节目边界：节目名、进度条范围跟着当前播放位置走
  const displaySeg = pendingSeek !== null || !playback || isShiftStream(playback) ? segmentAt(programs, displayPos, tz) : playback.seg;
  const nextSeg = playback ? nextSegment(programs, displaySeg, tz) : null;
  const prevSeg = playback ? prevSegment(programs, displaySeg, tz) : null;
  const showSeekBar = controls && (!!playback || pendingSeek !== null);
  const showInfoBar = controls && !playback && pendingSeek === null && !!channel;

  const renderFailure = () => {
    if (!failed || !channel) return null;
    const isPlayback = !!playback;
    return (
      <View style={styles.failure} pointerEvents="box-none">
        <View style={styles.toast}>
          <Text style={styles.toastTitle}>{isPlayback ? "该时段无法回看" : "播放失败"}</Text>
          <Text style={styles.toastSub}>{isPlayback ? "回看最早到 7 天前，或该节目暂无回放" : `${channel.name} 暂时无法播放`}</Text>
          {isTV ? (
            <View style={styles.toastRow}>
              {isPlayback ? (
                <><KeyHint k="返回" label="回到直播" /><KeyHint k="长按 OK" label="节目单" /></>
              ) : (
                <><KeyHint k="▲▼" label="换台" /><KeyHint k="OK" label="选择频道" /></>
              )}
            </View>
          ) : (
            <View style={styles.toastRow}>
              {isPlayback ? (
                <><RoundButton label="节目单" onPress={() => openPanel(true)} /><RoundButton label="回到直播" primary onPress={goLive} /></>
              ) : (
                <><RoundButton label="下一台" onPress={() => changeChannel("next")} /><RoundButton label="选择频道" primary onPress={() => openPanel(false)} /></>
              )}
            </View>
          )}
        </View>
      </View>
    );
  };

  // 投屏时的画面手势与本机一致：单击、双击、左右滑拖动进度、中间上下滑切换（两侧不调本机亮度音量）
  const castPanMode = useRef<'' | 'seek' | 'swipe'>('');
  const castGesture = Gesture.Race(
    Gesture.Pan()
      .runOnJS(true)
      .minDistance(30)
      .onStart((e) => {
        const startX = e.x - e.translationX;
        if (Math.abs(e.translationX) >= Math.abs(e.translationY)) {
          castPanMode.current = seekPan ? 'seek' : '';
          seekPan?.begin();
        } else {
          castPanMode.current = startX >= screenWidth * SIDE_ZONE && startX <= screenWidth * (1 - SIDE_ZONE) ? 'swipe' : '';
        }
      })
      .onUpdate((e) => {
        if (castPanMode.current === 'seek') seekPan?.update(e.translationX / screenWidth);
      })
      .onEnd((e) => {
        if (castPanMode.current === 'seek') seekPan?.end();
        else if (castPanMode.current === 'swipe' && Math.abs(e.translationY) > SWIPE_DISTANCE) {
          onVerticalSwipe(e.translationY < 0 ? 'up' : 'down');
        }
        castPanMode.current = '';
      }),
    Gesture.Exclusive(
      Gesture.Tap().numberOfTaps(2).runOnJS(true).onEnd(() => onDoubleTap()),
      Gesture.Tap().numberOfTaps(1).runOnJS(true).onEnd(() => onScreenTap()),
    ),
  );

  return (
    // 与剧集页一致：根视图可聚焦，进入页面就有焦点，遥控器中键才能直接生效
    <ThemedView focusable style={[commonStyles.container, styles.container]}>
      {!isCasting && channels.length === 0 ? (
        <View style={styles.empty}>
          {isLoading ? <ActivityIndicator size="large" color="#fff" /> : <Text style={styles.emptyText}>暂无直播频道</Text>}
        </View>
      ) : (
        <>
          {isCasting ? (
            <GestureHandlerRootView style={{ flex: 1 }}>
              <GestureDetector gesture={castGesture}>
                <View style={{ flex: 1 }} collapsable={false}>
                  <DLNAStatusPanel liveTitle={currentChannelName} />
                </View>
              </GestureDetector>
            </GestureHandlerRootView>
          ) : (
          <LivePlayer
            key={`${url ?? ''}|${reloadKey}`}
            ref={playerRef}
            url={url}
            ua={m3uUa}
            isLive={!playback}
            isShift={!!playback && isShiftStream(playback)}
            startPositionMs={playback ? playback.startAt - playback.win.start : undefined}
            paused={paused}
            onProgress={handleProgress}
            onLoad={handleLoad}
            onEnd={handleEnd}
            onFailed={handleFailed}
            onPlaying={handlePlaying}
            onTap={onScreenTap}
            onDoubleTap={onDoubleTap}
            seekPan={seekPan}
            onVerticalSwipe={onVerticalSwipe}
          />
          )}
          {!isCasting && renderFailure()}
          {playback && !panelOpen && (
            <PlaybackBadge seg={displaySeg} position={displayPos} now={now} tz={tz} displayTz={displayTz} touch={!isTV && controls} />
          )}
          {showInfoBar && channel && (
            <LiveInfoBar
              channel={channel}
              channelNo={currentChannelIndex + 1}
              programs={programs}
              tz={displayTz}
              canTimeshift={canCatchup}
              compact={compact}
              onPrevChannel={() => changeChannel("prev")}
              onNextChannel={() => changeChannel("next")}
              onOpenPanel={() => openPanel(false)}
            />
          )}
          {showSeekBar && channel && (
            <LiveSeekBar
              channelName={channel.name}
              seg={displaySeg}
              position={displayPos}
              now={now}
              tz={displayTz}
              paused={shownPaused}
              prevSeg={prevSeg}
              nextSeg={nextSeg}
              nextIsLive={!!nextSeg && nextSeg.start <= now && now < nextSeg.end}
              compact={compact}
              onPrevSegment={playPrevSegment}
              onBack={() => nudge(-SEEK_STEP)}
              onTogglePause={togglePause}
              onForward={() => nudge(SEEK_STEP)}
              onNextSegment={playNextSegment}
              onGoLive={goLive}
              onOpenEpg={() => openPanel(true)}
              onSeekTo={(t) => {
                showControls(!shownPaused);
                seekTo(t);
              }}
            />
          )}
          {!isTV && controls && !panelOpen && (
            // 时移 / 回看中先回到直播，直播中才退出直播页（与遥控器返回键一致）
            <TouchTopBar onBack={() => (playback || pendingSeek !== null ? goLive() : router.back())} right={castButtons} />
          )}
        </>
      )}
      {panelOpen && channel && (
        <LiveChannelPanel
          channels={channels}
          groups={panelGroups}
          grouped={panelGrouped}
          initialGroup={channelGroup}
          favorites={favorites}
          onToggleFavorite={liveSourceKey ? toggleFavorite : undefined}
          currentChannel={channel}
          epg={epg}
          tz={tz}
          displayTz={displayTz}
          hasCatchup={channelHasCatchup}
          showEpgColumn={showEpgColumn}
          compact={compact}
          focusEpg={panelFocusEpg}
          playingSegStart={playback ? playback.seg.start : null}
          headerRight={castButtons}
          onSelectChannel={selectChannelFromPanel}
          onPlaySegment={playSegmentFromPanel}
          onClose={closePanel}
          // 面板左上角的返回：回到播放画面，不退出直播
          onBack={closePanel}
        />
      )}
      {castAvailable && (
        <DLNADeviceModal
          visible={isCasting && showDlnaDeviceModal}
          onClose={() => setShowDlnaDeviceModal(false)}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "black" },
  emptyText: { color: "#fff", fontSize: 16 },
  castActions: { flexDirection: "row", alignItems: "center" },
  failure: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  toast: {
    minWidth: 340,
    paddingVertical: 18,
    paddingHorizontal: 24,
    borderRadius: 14,
    backgroundColor: "rgba(10, 12, 16, 0.95)",
    borderWidth: 1,
    borderColor: "#333a44",
    alignItems: "center",
  },
  toastTitle: { fontSize: 18, fontWeight: "700", color: LC.text, marginBottom: 6 },
  toastSub: { fontSize: 14, color: LC.muted },
  toastRow: { flexDirection: "row", gap: 16, marginTop: 14, alignItems: "center" },
});
