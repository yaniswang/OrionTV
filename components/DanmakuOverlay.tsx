import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dimensions,
  StyleSheet,
  UIManager,
  View,
  findNodeHandle,
  requireNativeComponent,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useDanmakuStore } from "@/stores/danmakuStore";
import usePlayerStore from "@/stores/playerStore";
import useDlnaStore from "@/stores/dlnaStore";
import type { DanmakuComment } from "@/services/danmaku";
import {
  buildDanmakuSecondBuckets,
  estimateDanmakuWidth,
  getDanmakuBaseSpeed,
  getDanmakuCatchLeft,
  getDanmakuJumpWindowSec,
  getDanmakuSpawnGap,
  getDanmakuTrackCount,
  getDanmakuVisualLane,
  planDanmakuPrefill,
  takeDanmakuAt,
  type DanmakuDensity,
} from "@/utils/danmakuLayout";

const SPAWN_INTERVAL_MS = 100;
const STALL_CHECK_INTERVAL_MS = 500;
const STALL_THRESHOLD_MS = 1500;
/** 起播跳转：播放位置进入目标前该范围内即视为到位 */
const STARTUP_JUMP_TOLERANCE_MS = 3000;
/** 起播跳转：加载结束后最多等待多久仍未到位则放行 */
const STARTUP_JUMP_TIMEOUT_MS = 8000;
/** SEEK 结束后最多等待多久新位置仍未开始播放则直接放行 */
const SEEK_SETTLE_TIMEOUT_MS = 8000;
/** 进度越过 SEEK 目标且在该范围内，视为新位置已开始播放（排除 SEEK 前的旧进度） */
const SEEK_REACHED_WINDOW_MS = 3000;
const SPEED_FACTORS = [0.5, 0.7, 1, 1.5, 2];

interface PreparedComment {
  text: string;
  primaryColor: string;
  secondaryColor: string;
  width: number;
  baseSpeed: number;
}

interface ActiveDanmaku extends PreparedComment {
  id: number;
  row: number;
  secondary: boolean;
  startX: number;
  startWall: number;
  speed: number;
}

interface LaneRuntime {
  row: number;
  secondary: boolean;
  spawning: boolean;
  items: ActiveDanmaku[];
  nextGap: number;
}

/** 发给原生画布的一条弹幕；坐标、速度单位为 dp，位置按 x = startX - speed × (now - startWall) 计算 */
interface NativeDanmakuItem {
  id: number;
  text: string;
  color: string;
  row: number;
  secondary: boolean;
  startX: number;
  startWall: number;
  speed: number;
  hidden: boolean;
}

/**
 * 原生弹幕画布（plugins/DanmakuView.kt）：只负责绘制和移动，按时间戳自行逐帧计算位置，
 * 与 JS 的估算公式一致；指令晚到也画在正确位置。
 */
const OrionDanmakuView = requireNativeComponent<{
  style?: StyleProp<ViewStyle>;
  fontSize: number;
  lineHeight: number;
}>("OrionDanmakuView");

const adjustBrightness =(hex: string, factor: number): string => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  const value = Number.parseInt(match?.[1] ?? "ffffff", 16);
  const red = Math.round(((value >> 16) & 0xff) * factor);
  const green = Math.round(((value >> 8) & 0xff) * factor);
  const blue = Math.round((value & 0xff) * factor);
  return `#${((red << 16) | (green << 8) | blue)
    .toString(16)
    .padStart(6, "0")}`;
};

export const DanmakuOverlay: React.FC = () => {
  const enabled = useDanmakuStore((state) => state.enabled);
  const comments = useDanmakuStore((state) => state.comments);
  const videoDuration = useDanmakuStore((state) => state.videoDuration);
  const settings = useDanmakuStore((state) => state.settings);
  const isCasting = useDlnaStore((state) => state.enabled);
  const localPlaying = usePlayerStore(
    (state) => state.status.isPlaying && !state.isVideoLoading,
  );
  const localIsSeeking = usePlayerStore((state) => state.isSeeking);
  const localSeekCommitVersion = usePlayerStore(
    (state) => state.seekCommitVersion,
  );
  const localSeekPosition = usePlayerStore((state) => state.seekPosition);
  const localDurationMillis = usePlayerStore((state) => state.status.durationMillis);
  const castPlaying = useDlnaStore((state) => state.isPlaying);
  const castIsSeeking = useDlnaStore((state) => state.isSeeking);
  const castSeekCommitVersion = useDlnaStore(
    (state) => state.seekCommitVersion,
  );
  const castSeekPosition = useDlnaStore((state) => state.seekPosition);
  const castDurationMillis = useDlnaStore((state) => state.durationMillis);
  const localPlaybackRate = usePlayerStore((state) => state.playbackRate);
  const castPlaybackRate = useDlnaStore((state) => state.playbackRate);
  // 本机起播时还没跳到续播位置（见本机状态订阅）：视频虽在播放，弹幕视为未播放
  const [startupJumpPending, setStartupJumpPending] = useState(false);
  const playing = isCasting ? castPlaying : localPlaying && !startupJumpPending;
  const isSeeking = isCasting ? castIsSeeking : localIsSeeking;
  const seekCommitVersion = isCasting
    ? castSeekCommitVersion
    : localSeekCommitVersion;
  const seekPosition = isCasting ? castSeekPosition : localSeekPosition;
  const playbackDurationMillis = isCasting
    ? castDurationMillis
    : localDurationMillis;
  const playbackRate = isCasting ? castPlaybackRate : localPlaybackRate;
  const { width: windowWidth, height } = useWindowDimensions();
  // 安卓沉浸式下 window 宽度会扣除挖孔/导航栏，弹幕起点以覆盖层实际宽度为准
  const [layoutWidth, setLayoutWidth] = useState(0);
  const width = layoutWidth || windowWidth;

  const [stalled, setStalled] = useState(false);
  const [applyingSeek, setApplyingSeek] = useState(false);
  const stalledRef = useRef(false);
  const paused = !playing || stalled || applyingSeek;
  const motionPausedRef = useRef(paused);
  const pausedAtRef = useRef<number | null>(playing ? null : Date.now());
  const lastAdvanceAtRef = useRef(Date.now());
  const lastPositionRef = useRef(-1);
  const lastRenderedPositionRef = useRef(0);
  const seekingRef = useRef(false);
  const seekTargetPositionRef = useRef<number | null>(null);
  const prefillPendingRef = useRef(false);
  const lastTickAtRef = useRef(Date.now());
  /** SEEK 后等待新位置开始播放的截止时刻，超时直接放行 */
  const seekPrefillDeadlineRef = useRef(0);
  /** 播放器已结束 SEEK（isSeeking 变回 false），开始等待新位置真正播放 */
  const seekReleasedRef = useRef(false);
  /** 本轮 SEEK 是否清屏重铺（偏差超出时间线窗口）；没清屏时屏上原有弹幕接着走 */
  const seekClearedRef = useRef(false);
  /** 本轮 SEEK 的比较基准：第一次 SEEK 前的渲染位置，连续多次 SEEK 不能各自只比上一次目标 */
  const seekBaseSecRef = useRef(0);
  const lastSeekCommitVersionRef = useRef(seekCommitVersion);
  const seekSourceIsCastingRef = useRef(isCasting);
  const commentsBySecondRef = useRef<(DanmakuComment[] | undefined)[]>([]);
  const activeSecondRef = useRef(-1);
  const activeBucketRef = useRef<DanmakuComment[]>([]);
  const commentsRef = useRef(comments);
  const settingsRef = useRef(settings);
  const densityRef = useRef<DanmakuDensity>(settings.density);
  const playingRef = useRef(playing);
  /** 播放倍速：进度外推、跳变窗口、预铺坐标都要按它把真实时间换算成视频时间 */
  const playbackRateRef = useRef(1);
  const nextIdRef = useRef(1);
  const lanesRef = useRef<LaneRuntime[]>([]);
  const nativeRef = useRef<React.ElementRef<typeof OrionDanmakuView>>(null);
  /** 本轮新生成、尚未发给原生画布的弹幕；任何其他指令发出前先合并发出，保证顺序 */
  const pendingAddsRef = useRef<NativeDanmakuItem[]>([]);

  commentsRef.current = comments;
  settingsRef.current = settings;
  playingRef.current = playing;
  playbackRateRef.current = playbackRate > 0 ? playbackRate : 1;

  const lineHeight = Math.max(1, Math.round(settings.fontSize * 1.5));
  const screenHeight = Math.max(height, Dimensions.get("screen").height);
  const layerHeight = Math.max(
    lineHeight * 2,
    Math.min(height, Math.round(screenHeight * settings.area)),
  );
  const rowCount = Math.max(1, Math.floor((layerHeight - 4) / lineHeight));
  const overlapTrackCount = getDanmakuTrackCount(rowCount, "overlap");
  /** 同屏弹幕上限 */
  const maxItems = Math.max(48, overlapTrackCount * 4);
  const maxItemsRef = useRef(maxItems);
  maxItemsRef.current = maxItems;

  const sendCommand = useCallback((command: string, args: unknown[] = []) => {
    const tag = findNodeHandle(nativeRef.current);
    if (tag == null) {
      pendingAddsRef.current = [];
      return;
    }
    if (command !== "add" && pendingAddsRef.current.length) {
      const adds = pendingAddsRef.current;
      pendingAddsRef.current = [];
      UIManager.dispatchViewManagerCommand(tag, "add", [adds]);
    }
    UIManager.dispatchViewManagerCommand(tag, command, args);
  }, []);

  const flushAdds = useCallback(() => {
    if (!pendingAddsRef.current.length) return;
    const adds = pendingAddsRef.current;
    pendingAddsRef.current = [];
    sendCommand("add", [adds]);
  }, [sendCommand]);

  const speedFactor = useMemo(() => {
    const index = Math.min(4, Math.max(0, Math.round(settings.speed) - 1));
    return SPEED_FACTORS[index];
  }, [settings.speed]);
  const speedFactorRef = useRef(speedFactor);
  const previousSpeedFactorRef = useRef(speedFactor);
  speedFactorRef.current = speedFactor;

  const makePreparedComment = useCallback(
    (comment: DanmakuComment): PreparedComment | null => {
      const text = comment.text.replace(/\s+/g, " ").trim();
      if (!text) return null;
      const width = Math.max(
        settingsRef.current.fontSize,
        estimateDanmakuWidth(text, settingsRef.current.fontSize),
      );
      const primaryColor = adjustBrightness(comment.color || "#ffffff", 0.9);
      return {
        text,
        primaryColor,
        secondaryColor: adjustBrightness(primaryColor, 0.9),
        width,
        baseSpeed: getDanmakuBaseSpeed(width),
      };
    },
    [],
  );

  const rebuildCommentBuckets = useCallback(() => {
    commentsBySecondRef.current = buildDanmakuSecondBuckets(
      commentsRef.current,
      videoDuration ?? 0,
    );
    activeSecondRef.current = -1;
    activeBucketRef.current = [];
  }, [videoDuration]);

  const getActiveBucket = useCallback(
    (positionSec: number): DanmakuComment[] => {
      const second = Math.max(0, Math.floor(positionSec));
      if (second !== activeSecondRef.current) {
        activeSecondRef.current = second;
        const source = commentsBySecondRef.current[second];
        activeBucketRef.current = source ? source.slice() : [];
      }
      return activeBucketRef.current;
    },
    [],
  );

  /** 生成一条弹幕：记入泳道并排队发给原生画布（由调用方 flushAdds 合并发出） */
  const spawnDanmaku = useCallback(
    (
      lane: LaneRuntime,
      prepared: PreparedComment,
      now: number,
      startX: number = width,
      hidden = false,
    ): boolean => {
      const activeCount = lanesRef.current.reduce(
        (count, candidate) => count + candidate.items.length,
        0,
      );
      if (activeCount >= maxItemsRef.current) return false;

      const item: ActiveDanmaku = {
        ...prepared,
        id: nextIdRef.current++,
        row: lane.row,
        secondary: lane.secondary,
        startX,
        // 暂停中生成（如 SEEK 时铺满）按暂停时刻计时：恢复时整体平移 startWall 后正好从恢复时刻起算
        startWall: motionPausedRef.current ? (pausedAtRef.current ?? now) : now,
        speed: prepared.baseSpeed * speedFactorRef.current,
      };
      lane.items.push(item);
      pendingAddsRef.current.push({
        id: item.id,
        text: item.text,
        color: item.secondary ? item.secondaryColor : item.primaryColor,
        row: item.row,
        secondary: item.secondary,
        startX: item.startX,
        startWall: item.startWall,
        speed: item.speed,
        hidden,
      });
      return true;
    },
    [width],
  );

  const createLane = useCallback(
    (
      row: number,
      secondary: boolean,
      density: DanmakuDensity,
    ): LaneRuntime => ({
      row,
      secondary,
      spawning: true,
      items: [],
      nextGap: getDanmakuSpawnGap(density),
    }),
    [],
  );

  const clearSlots = useCallback(() => {
    pendingAddsRef.current = [];
    sendCommand("clear");
    lanesRef.current = [];
  }, [sendCommand]);

  /**
   * resumeAdvanceMs：恢复时额外前进的时长。SEEK 后检测到新位置开始播放时视频已经播了一小段，
   * 预先铺好的弹幕要整体前进同样时长才与画面对齐。
   */
  const syncMotionState = useCallback((nextPaused: boolean, resumeAdvanceMs = 0) => {
    if (motionPausedRef.current === nextPaused) return;
    motionPausedRef.current = nextPaused;

    if (nextPaused) {
      if (pausedAtRef.current === null) pausedAtRef.current = Date.now();
      sendCommand("pause", [pausedAtRef.current]);
      return;
    }
    let delta = 0;
    if (pausedAtRef.current !== null) {
      delta = Date.now() - pausedAtRef.current - resumeAdvanceMs;
      pausedAtRef.current = null;
      lastAdvanceAtRef.current = Date.now();
      lanesRef.current.forEach((lane) => {
        lane.items.forEach((item) => {
          item.startWall += delta;
        });
      });
    }
    // 原生画布对各条 startWall 做同样的平移
    sendCommand("resume", [delta]);
  }, [sendCommand]);

  // 原生画布挂载时默认处于运动状态，同步当前的暂停状态
  useEffect(() => {
    if (enabled && motionPausedRef.current) {
      sendCommand("pause", [pausedAtRef.current ?? Date.now()]);
    }
  }, [enabled, sendCommand]);

  const rebuildLanes = useCallback(() => {
    clearSlots();
    const density = densityRef.current;
    const trackCount = getDanmakuTrackCount(rowCount, density);
    const nextLanes: LaneRuntime[] = [];
    for (let track = 0; track < trackCount; track += 1) {
      const row = getDanmakuVisualLane(track, density);
      const secondary = density === "overlap" && track % 2 === 1;
      nextLanes.push(createLane(row, secondary, density));
    }
    lanesRef.current = nextLanes;
  }, [clearSlots, createLane, rowCount]);

  const canSpawnInLane = useCallback(
    (lane: LaneRuntime, prepared: PreparedComment, now: number): boolean => {
      const previous = lane.items[lane.items.length - 1];
      if (!previous) return true;
      const elapsed = Math.max(0, now - previous.startWall) / 1000;
      const previousLeft = previous.startX - previous.speed * elapsed;
      const nextSpeed = prepared.baseSpeed * speedFactorRef.current;
      if (previousLeft + previous.width > width - lane.nextGap) {
        return false;
      }
      return (
        getDanmakuCatchLeft(
          previousLeft,
          previous.width,
          previous.speed,
          nextSpeed,
          lane.nextGap,
        ) <= width
      );
    },
    [width],
  );

  /**
   * SEEK 或时间跳变后，用 positionSec 之前的弹幕按坐标反推，一次性铺满泳道。
   * hidden：铺好后保持隐藏，等调用方 reveal（SEEK 时提前挂载，避开开始播放后的挂载耗时）
   */
  const prefillLanes = useCallback(
    (positionSec: number, hidden = false) => {
      const speedFactor = speedFactorRef.current;
      const rate = playbackRateRef.current;
      const lookbackSec = getDanmakuJumpWindowSec(width, speedFactor, rate);
      const fromSecond = Math.max(0, Math.floor(positionSec - lookbackSec));
      const candidates: (PreparedComment & {
        comment: DanmakuComment;
        time: number;
        speed: number;
      })[] = [];
      for (let second = fromSecond; second <= positionSec; second += 1) {
        commentsBySecondRef.current[second]?.forEach((comment) => {
          const prepared = makePreparedComment(comment);
          if (!prepared) return;
          candidates.push({
            ...prepared,
            comment,
            // 倍速下视频时间差要换算成弹幕实际移动的真实时间，坐标才对
            time: positionSec - (positionSec - comment.time) / rate,
            speed: prepared.baseSpeed * speedFactor,
          });
        });
      }
      const lanes = lanesRef.current.filter((lane) => lane.spawning);
      const placements = planDanmakuPrefill({
        screenWidth: width,
        positionSec,
        candidates,
        laneCount: lanes.length,
        getGap: () => getDanmakuSpawnGap(densityRef.current),
      });
      const now = Date.now();
      const used = new Set<DanmakuComment>();
      placements.forEach(({ lane, left, item }) => {
        if (!spawnDanmaku(lanes[lane], item, now, left, hidden)) return;
        used.add(item.comment);
      });
      flushAdds();
      // 当前秒已铺出的弹幕不再从右侧重复出现
      activeSecondRef.current = -1;
      const activeBucket = getActiveBucket(positionSec);
      for (let index = activeBucket.length - 1; index >= 0; index -= 1) {
        if (used.has(activeBucket[index])) takeDanmakuAt(activeBucket, index);
      }
    },
    [flushAdds, getActiveBucket, makePreparedComment, spawnDanmaku, width],
  );

  useEffect(() => {
    // 本机与投屏各自计数，切换来源时只同步版本号，不能当成一次 SEEK（否则会一直等不到 SEEK 结束）
    if (seekSourceIsCastingRef.current !== isCasting) {
      seekSourceIsCastingRef.current = isCasting;
      lastSeekCommitVersionRef.current = seekCommitVersion;
      return;
    }
    if (seekCommitVersion === lastSeekCommitVersionRef.current) return;
    lastSeekCommitVersionRef.current = seekCommitVersion;
    // 连续 SEEK（上一次还没放行又 SEEK）：基准沿用第一次 SEEK 前的位置；
    // 本轮已经清过屏的，屏上只剩为旧目标预铺的隐藏弹幕，必须按新目标重铺
    const chainCleared = seekingRef.current && seekClearedRef.current;
    if (!seekingRef.current) seekBaseSecRef.current = lastRenderedPositionRef.current;
    seekingRef.current = true;
    setApplyingSeek(true);
    syncMotionState(true);
    if (!playbackDurationMillis) {
      seekClearedRef.current = true;
      rebuildLanes();
      return;
    }
    const targetPositionMillis = Math.max(
      0,
      Math.min(seekPosition * playbackDurationMillis, playbackDurationMillis),
    );
    const targetSec = targetPositionMillis / 1000;
    const windowSec = getDanmakuJumpWindowSec(
      width,
      speedFactorRef.current,
      playbackRateRef.current,
    );
    seekClearedRef.current =
      chainCleared || Math.abs(targetSec - seekBaseSecRef.current) > windowSec;
    seekTargetPositionRef.current = targetPositionMillis;
    lastRenderedPositionRef.current = targetSec;
    lastAdvanceAtRef.current = Date.now();
    activeSecondRef.current = -1;
    activeBucketRef.current = [];
    if (seekClearedRef.current) {
      // 超出窗口：按目标位置提前铺好并挂载，但保持隐藏、暂停；等新位置真正开始播放再显示并移动（见调度循环），
      // 把批量挂载的耗时放在缓冲期间
      rebuildLanes();
      prefillLanes(targetSec, true);
    }
    // 窗口内：屏上弹幕保留，暂停到新位置开始播放后接着走，新弹幕从目标时间点取
    seekReleasedRef.current = false;
  }, [
    isCasting,
    playbackDurationMillis,
    prefillLanes,
    rebuildLanes,
    seekCommitVersion,
    seekPosition,
    syncMotionState,
    width,
  ]);

  useEffect(() => {
    if (isSeeking || !seekingRef.current) return;
    if (seekTargetPositionRef.current !== null) {
      // 播放器已结束 SEEK，但新位置可能仍在缓冲；保持暂停，由调度循环等进度到位后放行
      seekReleasedRef.current = true;
      seekPrefillDeadlineRef.current = Date.now() + SEEK_SETTLE_TIMEOUT_MS;
      return;
    }
    seekingRef.current = false;
    lastAdvanceAtRef.current = Date.now();
    setApplyingSeek(false);
    syncMotionState(!playingRef.current || stalledRef.current);
  }, [isSeeking, syncMotionState]);

  useEffect(() => {
    rebuildCommentBuckets();
    if (!enabled || !comments.length) {
      clearSlots();
      return;
    }
    rebuildLanes();    // 刷新/重新匹配弹幕后铺满泳道；交给下一轮调度执行，避免被同一轮尺寸 effect 的重建清掉
    prefillPendingRef.current = true;
  }, [clearSlots, comments, enabled, rebuildCommentBuckets, rebuildLanes, videoDuration]);

  useEffect(() => {
    if (!enabled || !comments.length) {
      clearSlots();
      return;
    }
    rebuildLanes();  }, [
    clearSlots,
    comments.length,
    enabled,
    height,
    rebuildLanes,
    settings.area,
    settings.fontSize,
    width,
  ]);

  useEffect(() => {
    const apply = (
      position: number,
      nextPlaying: boolean,
      nextSeeking: boolean,
      transportState?: string,
      loading = false,
    ) => {
      const previousPosition = lastPositionRef.current;
      const progressed =
        previousPosition >= 0 &&
        position > previousPosition &&
        !nextSeeking;
      if (position !== previousPosition) {
        lastPositionRef.current = position;
        lastAdvanceAtRef.current = Date.now();
      }
      if (progressed && stalledRef.current) {
        stalledRef.current = false;
        setStalled(false);
        // 卡顿（含 JS 线程被占住导致的误判）期间视频可能照常在播，以真实进度为跳变判断基准，
        // 避免把这段进度当成跳变而清空重铺
        lastRenderedPositionRef.current = position / 1000;
      }
      // 部分电视不返回可靠的 isPlaying，但位置持续前进即证明远端已经在播放。
      const explicitlyPaused =
        transportState === "PAUSED_PLAYBACK" ||
        transportState === "STOPPED";
      // 本机视频加载期间（含跳到续播位置之前）会先从 0 秒播一小会儿，不能据此出弹幕
      playingRef.current =
        !loading && !explicitlyPaused && (nextPlaying || progressed);
      syncMotionState(
        !playingRef.current || stalledRef.current || seekingRef.current,
      );
    };

    if (isCasting) {
      const state = useDlnaStore.getState();
      apply(
        state.positionMillis,
        state.isPlaying,
        state.isSeeking,
        state.transportState,
      );
      return useDlnaStore.subscribe((state) => {
        apply(
          state.positionMillis,
          state.isPlaying,
          state.isSeeking,
          state.transportState,
        );
      });
    }
    // 本次加载要跳到的起始位置（续播位置，否则片头结束点，与 handleVideoLoad 一致）。
    // seek() 不等跳转生效就返回、加载状态随即结束，期间视频仍从 0 秒播放，
    // 所以要等播放位置真正到达目标附近才出弹幕；迟迟不到位时超时放行。
    let jumpTarget = 0;
    let jumpDeadline = 0;
    const armStartupJump = (current: ReturnType<typeof usePlayerStore.getState>) => {
      jumpTarget = current.initialPosition || current.introEndTime || 0;
      jumpDeadline = 0;
    };
    const isStartupJumpPending = (current: ReturnType<typeof usePlayerStore.getState>) => {
      if (jumpTarget <= 0) return false;
      if (current.status.positionMillis >= jumpTarget - STARTUP_JUMP_TOLERANCE_MS) {
        jumpTarget = 0;
        return false;
      }
      if (!current.isVideoLoading) {
        if (!jumpDeadline) jumpDeadline = Date.now() + STARTUP_JUMP_TIMEOUT_MS;
        else if (Date.now() > jumpDeadline) {
          jumpTarget = 0;
          return false;
        }
      }
      return true;
    };
    const applyLocal = (current: ReturnType<typeof usePlayerStore.getState>) => {
      // 续播位置可能在加载开始后才写入，加载期间每次都重新读取，加载结束后固定
      if (current.isVideoLoading) armStartupJump(current);
      const pending = isStartupJumpPending(current);
      setStartupJumpPending(pending);
      apply(
        current.status.positionMillis,
        current.status.isPlaying,
        current.isSeeking,
        undefined,
        current.isVideoLoading || pending,
      );
    };
    applyLocal(usePlayerStore.getState());
    return usePlayerStore.subscribe((state, prev) => {
      if (
        state.status === prev.status &&
        state.isSeeking === prev.isSeeking &&
        state.isVideoLoading === prev.isVideoLoading &&
        state.initialPosition === prev.initialPosition
      ) {
        return;
      }
      applyLocal(state);
    });
  }, [isCasting, syncMotionState]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!playingRef.current) return;
      const stalledNow =
        Date.now() - lastAdvanceAtRef.current > STALL_THRESHOLD_MS;
      if (stalledNow !== stalledRef.current) {
        stalledRef.current = stalledNow;
        setStalled(stalledNow);
        syncMotionState(
          !playingRef.current || stalledNow || seekingRef.current,
        );
      }
    }, STALL_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [syncMotionState]);

  useEffect(() => {
    syncMotionState(paused);
  }, [paused, syncMotionState]);

  useEffect(() => {
    if (!enabled || settings.density === densityRef.current) return;
    const density = settings.density;
    densityRef.current = density;

    if (density === "overlap") {
      const secondaryRows = new Set(
        lanesRef.current
          .filter((lane) => lane.secondary)
          .map((lane) => lane.row),
      );
      for (let row = 0; row < rowCount; row += 1) {
        if (secondaryRows.has(row)) continue;
        lanesRef.current.push(createLane(row, true, density));
      }
    }
    lanesRef.current.forEach((lane) => {
      if (lane.secondary) lane.spawning = density === "overlap";
      if (lane.spawning) {
        lane.nextGap = getDanmakuSpawnGap(density);
      }
    });
  }, [createLane, enabled, rowCount, settings.density]);

  useEffect(() => {
    if (previousSpeedFactorRef.current === speedFactor) return;
    previousSpeedFactorRef.current = speedFactor;
    const referenceWall = pausedAtRef.current ?? Date.now();
    const updates: Pick<NativeDanmakuItem, "id" | "startX" | "startWall" | "speed">[] = [];
    lanesRef.current.forEach((lane) => {
      lane.items.forEach((item) => {
        const elapsed = Math.max(0, referenceWall - item.startWall) / 1000;
        item.startX -= item.speed * elapsed;
        item.startWall = referenceWall;
        item.speed = item.baseSpeed * speedFactor;
        updates.push({
          id: item.id,
          startX: item.startX,
          startWall: item.startWall,
          speed: item.speed,
        });
      });
    });
    if (updates.length) sendCommand("update", [updates]);
  }, [sendCommand, speedFactor]);

  useEffect(() => {
    if (!enabled || !comments.length) return;
    const timer = setInterval(() => {
      const now = Date.now();
      // 本轮与上一轮的真实间隔：JS 线程被卡住时远大于 SPAWN_INTERVAL_MS
      const tickGapSec = Math.max(0, now - lastTickAtRef.current) / 1000;
      lastTickAtRef.current = now;

      // SEEK 结束后等新位置真正开始播放：进度越过目标（且不是 SEEK 前的旧进度）才放行，
      // 显示提前铺好的弹幕，并按已播放的时长整体前进后开始移动
      const rate = playbackRateRef.current;
      const seekTarget = seekTargetPositionRef.current;
      if (seekingRef.current && seekTarget !== null && seekReleasedRef.current) {
        const position = lastPositionRef.current;
        // 倍速下一次进度上报就会前进好几秒，到位判定范围按倍速放大
        const reached =
          playingRef.current &&
          position > seekTarget &&
          position <= seekTarget + SEEK_REACHED_WINDOW_MS * rate;
        if (!reached && now <= seekPrefillDeadlineRef.current) return;
        seekingRef.current = false;
        seekReleasedRef.current = false;
        seekTargetPositionRef.current = null;
        setApplyingSeek(false);
        const playedMs = reached
          ? Math.max(0, position + (now - lastAdvanceAtRef.current) * rate - seekTarget)
          : 0;
        sendCommand("revealAll");
        lastRenderedPositionRef.current = (seekTarget + playedMs) / 1000;
        // 预铺的弹幕按已播视频时长（换算成真实时间）前进；没清屏时屏上是原有弹幕，从暂停处接着走
        syncMotionState(
          !playingRef.current || stalledRef.current,
          seekClearedRef.current ? playedMs / rate : 0,
        );
        return;
      }

      const motionShouldPause =
        !playingRef.current || stalledRef.current || seekingRef.current;
      syncMotionState(motionShouldPause);
      if (motionShouldPause) {
        return;
      }
      // 两次进度上报之间按倍速外推
      const estimatedPositionSec = Math.max(
        0,
        (lastPositionRef.current + (now - lastAdvanceAtRef.current) * rate) / 1000,
      );
      // 跳变 = 偏离"上次渲染位置 + 本轮间隔"；JS 被卡住期间视频照常播放，不能当成跳变重铺
      const expectedPositionSec = lastRenderedPositionRef.current + tickGapSec * rate;
      // 偏差在时间线窗口内不清屏：屏上弹幕自然移出，新弹幕从当前时间点取
      const jumpWindowSec = getDanmakuJumpWindowSec(width, speedFactorRef.current, rate);
      if (Math.abs(estimatedPositionSec - expectedPositionSec) > jumpWindowSec) {
        rebuildLanes();
        prefillLanes(estimatedPositionSec);
        prefillPendingRef.current = false;
      } else if (prefillPendingRef.current) {
        prefillPendingRef.current = false;
        prefillLanes(estimatedPositionSec);
      }
      lastRenderedPositionRef.current = estimatedPositionSec;

      const activeBucket = getActiveBucket(estimatedPositionSec);
      lanesRef.current.forEach((lane) => {
        // 按估算宽度离场；原生画布按实际绘制宽度自行丢弃，不需要通知
        lane.items = lane.items.filter((item) => {
          const elapsed = Math.max(0, now - item.startWall) / 1000;
          return item.startX - item.speed * elapsed + item.width >= 0;
        });
        if (!lane.spawning) return;
        if (!activeBucket.length) return;
        const randomIndex = Math.floor(Math.random() * activeBucket.length);
        const next = makePreparedComment(activeBucket[randomIndex]);
        if (!next) {
          takeDanmakuAt(activeBucket, randomIndex);
          return;
        }
        if (!canSpawnInLane(lane, next, now)) return;
        if (!spawnDanmaku(lane, next, now)) return;        takeDanmakuAt(activeBucket, randomIndex);
        lane.nextGap = getDanmakuSpawnGap(densityRef.current);
      });
      flushAdds();
    }, SPAWN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [
    canSpawnInLane,
    comments.length,
    enabled,
    flushAdds,
    getActiveBucket,
    makePreparedComment,
    prefillLanes,
    rebuildLanes,
    sendCommand,
    spawnDanmaku,
    syncMotionState,
    width,
  ]);

  useEffect(
    () => () => {
      clearSlots();
    },
    [clearSlots],
  );

  if (!enabled) return null;

  return (
    <View
      pointerEvents="none"
      onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}
      style={[styles.layer, { height: layerHeight, opacity: settings.opacity }]}
    >
      <OrionDanmakuView
        ref={nativeRef}
        style={StyleSheet.absoluteFill}
        fontSize={settings.fontSize}
        lineHeight={lineHeight}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
  },
});

export default DanmakuOverlay;
