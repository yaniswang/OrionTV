import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dimensions,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  executeOnUIRuntimeSync,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useDanmakuStore } from "@/stores/danmakuStore";
import usePlayerStore from "@/stores/playerStore";
import useDlnaStore from "@/stores/dlnaStore";
import type { DanmakuComment } from "@/services/danmaku";
import {
  buildDanmakuSecondBuckets,
  estimateDanmakuWidth,
  getDanmakuBaseSpeed,
  getDanmakuCatchLeft,
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
/** JS 估算离场超过该秒数仍未收到动画结束回调时，兜底强制释放 */
const EXIT_FALLBACK_SEC = 1;
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
  slotIndex: number;
}

interface LaneRuntime {
  row: number;
  secondary: boolean;
  spawning: boolean;
  items: ActiveDanmaku[];
  nextGap: number;
}

interface DanmakuSlotHandle {
  play: (args: {
    text: string;
    color: string;
    row: number;
    secondary: boolean;
    width: number;
    speed: number;
    startX: number;
    /** 延迟补偿基准：UI 实际启动晚于该时刻多少，就把起点往前补多少 */
    startWall: number;
    /** 是否在 play 内同步预置起点；批量生成时传 false，由调用方统一预置 */
    presetPosition?: boolean;
    /** 挂载后保持隐藏，直到 reveal()；调用方需同时把 visible 预置为 0 */
    hidden?: boolean;
    onFinish: () => void;
  }) => void;
  /** 位移共享值，供批量生成时一次性预置起点 */
  position: SharedValue<number>;
  /** 可见度共享值，供批量生成时一次性预置隐藏 */
  visible: SharedValue<number>;
  /** issuedAt：JS 侧认为暂停发生的时刻，UI 执行较晚时按此回退位置 */
  pause: (issuedAt?: number) => void;
  /** issuedAt：恢复的基准时刻，早于当前时刻时按差值前进 */
  resume: (issuedAt?: number) => void;
  /** 允许以 hidden 方式生成的弹幕显示；返回 true 表示已挂载、需调用方立即（批量）设为可见 */
  reveal: () => boolean;
  stop: () => void;
  setSpeed: (speed: number) => void;
}

interface DanmakuSlotProps {
  screenWidth: number;
  fontSize: number;
  lineHeight: number;
}

/** 一次同步批量设置可见度：可见度必须同步写入，按 JS 调用顺序生效 */
const setVisibleSync = (values: SharedValue<number>[], value: number) => {
  if (!values.length) return;
  executeOnUIRuntimeSync((list: SharedValue<number>[], next: number) => {
    "worklet";
    for (let index = 0; index < list.length; index += 1) list[index].value = next;
  })(values, value);
};

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

const DanmakuSlot = memo(
  forwardRef<DanmakuSlotHandle, DanmakuSlotProps>(
    ({ screenWidth, fontSize, lineHeight }, ref) => {
      const [content, setContent] = useState<{
        text: string;
        color: string;
        row: number;
        secondary: boolean;
        renderToken: number;
      } | null>(null);
      // Reanimated 按真实帧时间推进，避免原生 Animated 预计算帧在非严格 60Hz 屏上周期性跳帧
      const translateX = useSharedValue(screenWidth);
      // 停止时在 UI 线程立即隐藏：卸载要等 React 提交，SEEK 批量重铺时会延迟数百毫秒，
      // 期间旧弹幕会定在原地；新文字挂载完成（首次布局）后再显示
      const visible = useSharedValue(1);
      const animationTokenRef = useRef(0);
      const widthRef = useRef(0);
      const speedRef = useRef(0);
      const pausedRef = useRef(false);
      const busyRef = useRef(false);
      const finishCbRef = useRef<(() => void) | null>(null);
      const renderTokenRef = useRef(0);

      const animatedStyle = useAnimatedStyle(() => ({
        opacity: visible.value,
        transform: [{ translateX: translateX.value }],
      }));

      // false 时挂载后保持隐藏，直到 reveal()（SEEK 时提前挂载、等新位置开始播放再显示）
      const revealOnMountRef = useRef(true);
      const mountedTokenRef = useRef(0);

      // 只处理当前这次播放的文字：已停止或已被新内容取代的旧文字，挂载完成时不能再把自己显示出来。
      // 可见度一律同步写入：异步的 runOnUI 会排在队列里晚于后续的同步隐藏执行，把待命的弹幕又显示出来
      const showMounted = useCallback(
        (token: number) => {
          if (token !== renderTokenRef.current || !busyRef.current) return;
          mountedTokenRef.current = token;
          if (!revealOnMountRef.current) return;
          executeOnUIRuntimeSync(() => {
            "worklet";
            visible.value = 1;
          })();
        },
        [visible],
      );

      const handleFinish = useCallback((token: number) => {
        if (token !== animationTokenRef.current || pausedRef.current) return;
        busyRef.current = false;
        setContent(null);
        const onFinish = finishCbRef.current;
        finishCbRef.current = null;
        onFinish?.();
      }, []);

      /**
       * from 为 null 时从当前位置继续。issuedAt 是 JS 侧认为动画开始（或恢复）的时刻：
       * UI 线程繁忙时（如起播时批量铺满）worklet 会晚执行，按延迟把起点往前补，
       * 保证 UI 位置与 JS 的离场/碰撞估算一致。
       */
      const start = useCallback(
        (from: number | null, issuedAt: number = Date.now()) => {
          const speed = speedRef.current;
          const width = widthRef.current;
          if (!width || speed <= 0) return;
          const token = ++animationTokenRef.current;
          runOnUI(() => {
            "worklet";
            if (from === null) cancelAnimation(translateX);
            const base = from === null ? translateX.value : from;
            const lagSec = Math.max(0, Date.now() - issuedAt) / 1000;
            translateX.value = base - speed * lagSec;
            const remaining = Math.max(1, translateX.value + width);
            translateX.value = withTiming(
              -width,
              { duration: (remaining / speed) * 1000, easing: Easing.linear },
              (finished) => {
                if (finished) runOnJS(handleFinish)(token);
              },
            );
          })();
        },
        [handleFinish, translateX],
      );

      useImperativeHandle(
        ref,
        () => ({
          play: ({
            text,
            color,
            row,
            secondary,
            width,
            speed,
            startX,
            startWall,
            presetPosition = true,
            hidden = false,
            onFinish,
          }) => {
            widthRef.current = width;
            speedRef.current = speed;
            pausedRef.current = false;
            busyRef.current = true;
            finishCbRef.current = onFinish;
            revealOnMountRef.current = !hidden;
            // 新 Text 首次渲染会同步读取 UI 线程上的位移；先同步落到起点，
            // 避免异步的 runOnUI 尚未执行时沿用上一条的结束位置在左侧闪现。
            // 批量生成时由调用方统一预置（每次同步都要等 UI 线程，逐条做会卡住 JS）
            if (presetPosition) {
              executeOnUIRuntimeSync((x: number) => {
                "worklet";
                cancelAnimation(translateX);
                translateX.value = x;
              })(startX);
            }
            renderTokenRef.current += 1;
            setContent({
              text,
              color,
              row,
              secondary,
              renderToken: renderTokenRef.current,
            });
            start(startX, startWall);
          },
          pause: (issuedAt = Date.now()) => {
            if (pausedRef.current || !busyRef.current) return;
            pausedRef.current = true;
            animationTokenRef.current += 1;
            const speed = speedRef.current;
            runOnUI(() => {
              "worklet";
              cancelAnimation(translateX);
              // 指令在 UI 线程积压时动画会多走一段（启动时还按延迟补偿过），
              // 退回到发出暂停时刻的位置，与 JS 冻结的位置一致
              translateX.value += speed * (Math.max(0, Date.now() - issuedAt) / 1000);
            })();
          },
          resume: (issuedAt = Date.now()) => {
            if (!pausedRef.current) return;
            pausedRef.current = false;
            if (busyRef.current) start(null, issuedAt);
          },
          reveal: () => {
            if (revealOnMountRef.current) return false;
            revealOnMountRef.current = true;
            // 已挂载的由调用方批量同步显示；尚未挂载的在首次布局时显示
            return mountedTokenRef.current === renderTokenRef.current;
          },
          position: translateX,
          visible,
          stop: () => {
            animationTokenRef.current += 1;
            pausedRef.current = false;
            busyRef.current = false;
            finishCbRef.current = null;
            // 隐藏由调用方批量同步处理（clearSlots），这里不写可见度，避免异步写入晚于后续同步显示
            runOnUI(() => {
              "worklet";
              cancelAnimation(translateX);
            })();
            setContent(null);
          },
          setSpeed: (nextSpeed) => {
            if (nextSpeed <= 0 || speedRef.current === nextSpeed) return;
            speedRef.current = nextSpeed;
            if (!busyRef.current || pausedRef.current) return;
            start(null);
          },
        }),
        [start, translateX, visible],
      );

      if (!content) return null;

      return (
        <Animated.Text
          key={content.renderToken}
          numberOfLines={1}
          onLayout={() => showMounted(content.renderToken)}
          // @ts-expect-error Android-only hardware raster cache prop, not in TextProps
          renderToHardwareTextureAndroid
          style={[
            styles.item,
            {
              top:
                content.row * lineHeight +
                (content.secondary ? 1 : 0),
              color: content.color,
              fontSize,
              lineHeight,
              zIndex: content.secondary ? 0 : 1,
            },
            animatedStyle,
          ]}
        >
          {content.text}
        </Animated.Text>
      );
    },
  ),
);

DanmakuSlot.displayName = "DanmakuSlot";

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
  const lastSeekCommitVersionRef = useRef(seekCommitVersion);
  const seekSourceIsCastingRef = useRef(isCasting);
  const commentsBySecondRef = useRef<(DanmakuComment[] | undefined)[]>([]);
  const activeSecondRef = useRef(-1);
  const activeBucketRef = useRef<DanmakuComment[]>([]);
  const commentsRef = useRef(comments);
  const settingsRef = useRef(settings);
  const densityRef = useRef<DanmakuDensity>(settings.density);
  const playingRef = useRef(playing);
  const nextIdRef = useRef(1);
  const lanesRef = useRef<LaneRuntime[]>([]);
  const slotRefs = useRef<(DanmakuSlotHandle | null)[]>([]);
  const slotItemsRef = useRef<(ActiveDanmaku | null)[]>([]);

  commentsRef.current = comments;
  settingsRef.current = settings;
  playingRef.current = playing;

  const lineHeight = Math.max(1, Math.round(settings.fontSize * 1.5));
  const screenHeight = Math.max(height, Dimensions.get("screen").height);
  const layerHeight = Math.max(
    lineHeight * 2,
    Math.min(height, Math.round(screenHeight * settings.area)),
  );
  const rowCount = Math.max(1, Math.floor((layerHeight - 4) / lineHeight));
  const overlapTrackCount = getDanmakuTrackCount(rowCount, "overlap");
  const slotCount = Math.max(48, overlapTrackCount * 4);

  if (slotItemsRef.current.length !== slotCount) {
    slotItemsRef.current = Array.from(
      { length: slotCount },
      (_, index) => slotItemsRef.current[index] ?? null,
    );
  }
  const slotRefCallbacks = useMemo(
    () =>
      Array.from(
        { length: slotCount },
        (_, index) => (slot: DanmakuSlotHandle | null) => {
          slotRefs.current[index] = slot;
        },
      ),
    [slotCount],
  );

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

  const releaseItem = useCallback(
    (lane: LaneRuntime, item: ActiveDanmaku, stopAnimation = false) => {
      lane.items = lane.items.filter((candidate) => candidate.id !== item.id);
      if (slotItemsRef.current[item.slotIndex]?.id === item.id) {
        slotItemsRef.current[item.slotIndex] = null;
        if (stopAnimation) {
          slotRefs.current[item.slotIndex]?.stop();
        }
      }
    },
    [],
  );

  const spawnDanmaku = useCallback(
    (
      lane: LaneRuntime,
      prepared: PreparedComment,
      now: number,
      startX: number = width,
      presetPosition = true,
      hidden = false,
    ): DanmakuSlotHandle | null => {
      const slotIndex = slotItemsRef.current.findIndex((item) => item === null);
      if (slotIndex < 0) return null;
      const slot = slotRefs.current[slotIndex];
      if (!slot) return null;

      const item: ActiveDanmaku = {
        ...prepared,
        id: nextIdRef.current++,
        row: lane.row,
        secondary: lane.secondary,
        startX,
        // 暂停中生成（如 SEEK 时铺满）按暂停时刻计时：恢复时整体平移 startWall 后正好从恢复时刻起算
        startWall: motionPausedRef.current ? (pausedAtRef.current ?? now) : now,
        speed: prepared.baseSpeed * speedFactorRef.current,
        slotIndex,
      };
      slotItemsRef.current[slotIndex] = item;
      lane.items.push(item);
      // UI 的延迟补偿以指令发出时刻为准：暂停中生成时 startWall 可能是很久以前的暂停时刻，
      // 用它补偿会把弹幕一下推出屏幕
      const issuedAt = motionPausedRef.current ? Date.now() : item.startWall;
      slot.play({
        text: item.text,
        color: item.secondary ? item.secondaryColor : item.primaryColor,
        row: item.row,
        secondary: item.secondary,
        width: item.width,
        speed: item.speed,
        startX: item.startX,
        startWall: issuedAt,
        presetPosition,
        hidden,
        onFinish: () => releaseItem(lane, item),
      });
      if (motionPausedRef.current) slot.pause(issuedAt);
      return slot;
    },
    [releaseItem, width],
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
    slotRefs.current.forEach((slot) => slot?.stop());
    // 卸载要等 React 提交（批量时可达数百毫秒），先一次同步全部隐藏
    setVisibleSync(
      slotRefs.current.flatMap((slot) => (slot ? [slot.visible] : [])),
      0,
    );
    slotItemsRef.current = slotItemsRef.current.map(() => null);
    lanesRef.current = [];
  }, []);

  /**
   * resumeAdvanceMs：恢复时额外前进的时长。SEEK 后检测到新位置开始播放时视频已经播了一小段，
   * 预先铺好的弹幕要整体前进同样时长才与画面对齐。
   */
  const syncMotionState = useCallback((nextPaused: boolean, resumeAdvanceMs = 0) => {
    if (motionPausedRef.current === nextPaused) return;
    motionPausedRef.current = nextPaused;

    if (nextPaused) {
      if (pausedAtRef.current === null) pausedAtRef.current = Date.now();
    } else if (pausedAtRef.current !== null) {
      const delta = Date.now() - pausedAtRef.current - resumeAdvanceMs;
      pausedAtRef.current = null;
      lastAdvanceAtRef.current = Date.now();
      lanesRef.current.forEach((lane) => {
        lane.items.forEach((item) => {
          item.startWall += delta;
        });
      });
    }

    const resumeIssuedAt = Date.now() - resumeAdvanceMs;
    slotRefs.current.forEach((slot) => {
      if (nextPaused) slot?.pause(pausedAtRef.current ?? undefined);
      else slot?.resume(resumeIssuedAt);
    });
  }, []);

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
      const lookbackSec = width / (getDanmakuBaseSpeed(0) * speedFactor);
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
            time: comment.time,
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
      const presets: {
        position: SharedValue<number>;
        visible: SharedValue<number>;
        x: number;
      }[] = [];
      placements.forEach(({ lane, left, item }) => {
        const slot = spawnDanmaku(lanes[lane], item, now, left, false, hidden);
        if (!slot) return;
        used.add(item.comment);
        presets.push({ position: slot.position, visible: slot.visible, x: left });
      });
      // 一次同步统一预置起点（见 DanmakuSlot.play），逐条同步会让 JS 线程卡住数秒
      if (presets.length) {
        executeOnUIRuntimeSync(
          (
            list: { position: SharedValue<number>; visible: SharedValue<number>; x: number }[],
            hide: boolean,
          ) => {
            "worklet";
            for (let index = 0; index < list.length; index += 1) {
              cancelAnimation(list[index].position);
              list[index].position.value = list[index].x;
              if (hide) list[index].visible.value = 0;
            }
          },
        )(presets, hidden);
      }
      // 当前秒已铺出的弹幕不再从右侧重复出现
      activeSecondRef.current = -1;
      const activeBucket = getActiveBucket(positionSec);
      for (let index = activeBucket.length - 1; index >= 0; index -= 1) {
        if (used.has(activeBucket[index])) takeDanmakuAt(activeBucket, index);
      }
    },
    [getActiveBucket, makePreparedComment, spawnDanmaku, width],
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
    seekingRef.current = true;
    setApplyingSeek(true);
    syncMotionState(true);
    if (!playbackDurationMillis) {
      rebuildLanes();
      return;
    }
    const targetPositionMillis = Math.max(
      0,
      Math.min(seekPosition * playbackDurationMillis, playbackDurationMillis),
    );
    seekTargetPositionRef.current = targetPositionMillis;
    lastRenderedPositionRef.current = targetPositionMillis / 1000;
    lastAdvanceAtRef.current = Date.now();
    activeSecondRef.current = -1;
    activeBucketRef.current = [];
    // 按目标位置提前铺好并挂载，但保持隐藏、暂停；等新位置真正开始播放再显示并移动（见调度循环），
    // 把批量挂载的耗时放在缓冲期间
    rebuildLanes();
    prefillLanes(targetPositionMillis / 1000, true);
    seekReleasedRef.current = false;
  }, [
    isCasting,
    playbackDurationMillis,
    prefillLanes,
    rebuildLanes,
    seekCommitVersion,
    seekPosition,
    syncMotionState,
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
    lanesRef.current.forEach((lane) => {
      lane.items.forEach((item) => {
        const elapsed = Math.max(0, referenceWall - item.startWall) / 1000;
        item.startX -= item.speed * elapsed;
        item.startWall = referenceWall;
        item.speed = item.baseSpeed * speedFactor;
        slotRefs.current[item.slotIndex]?.setSpeed(item.speed);
      });
    });
  }, [speedFactor]);

  useEffect(() => {
    if (!enabled || !comments.length) return;
    const timer = setInterval(() => {
      const now = Date.now();
      // 本轮与上一轮的真实间隔：JS 线程被卡住时远大于 SPAWN_INTERVAL_MS
      const tickGapSec = Math.max(0, now - lastTickAtRef.current) / 1000;
      lastTickAtRef.current = now;

      // SEEK 结束后等新位置真正开始播放：进度越过目标（且不是 SEEK 前的旧进度）才放行，
      // 显示提前铺好的弹幕，并按已播放的时长整体前进后开始移动
      const seekTarget = seekTargetPositionRef.current;
      if (seekingRef.current && seekTarget !== null && seekReleasedRef.current) {
        const position = lastPositionRef.current;
        const reached =
          playingRef.current &&
          position > seekTarget &&
          position <= seekTarget + SEEK_REACHED_WINDOW_MS;
        if (!reached && now <= seekPrefillDeadlineRef.current) return;
        seekingRef.current = false;
        seekReleasedRef.current = false;
        seekTargetPositionRef.current = null;
        setApplyingSeek(false);
        const playedMs = reached
          ? Math.max(0, position + (now - lastAdvanceAtRef.current) - seekTarget)
          : 0;
        const mountedVisible: SharedValue<number>[] = [];
        lanesRef.current.forEach((lane) => {
          lane.items.forEach((item) => {
            const slot = slotRefs.current[item.slotIndex];
            if (slot?.reveal()) mountedVisible.push(slot.visible);
          });
        });
        setVisibleSync(mountedVisible, 1);
        lastRenderedPositionRef.current = (seekTarget + playedMs) / 1000;
        syncMotionState(!playingRef.current || stalledRef.current, playedMs);
        return;
      }

      const motionShouldPause =
        !playingRef.current || stalledRef.current || seekingRef.current;
      syncMotionState(motionShouldPause);
      if (motionShouldPause) {
        return;
      }
      const estimatedPositionSec = Math.max(
        0,
        (lastPositionRef.current + (now - lastAdvanceAtRef.current)) / 1000,
      );
      // 跳变 = 偏离"上次渲染位置 + 本轮间隔"；JS 被卡住期间视频照常播放，不能当成跳变重铺
      const expectedPositionSec = lastRenderedPositionRef.current + tickGapSec;
      if (
        estimatedPositionSec < expectedPositionSec - 1 ||
        estimatedPositionSec > expectedPositionSec + 2
      ) {
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
        lane.items = lane.items.filter((item) => {
          const elapsed = Math.max(0, now - item.startWall) / 1000;
          const left = item.startX - item.speed * elapsed;
          // 离场由 UI 动画结束回调（onFinish）负责；UI 动画总比 JS 估算稍晚起步，
          // 批量铺满时更明显，按估算一到左边缘就强制停止会让尾部还在屏幕上的弹幕瞬间消失。
          // 这里只兜底：估算离场已超过 EXIT_FALLBACK_SEC 仍未回调才强制释放。
          if (left + item.width >= -item.speed * EXIT_FALLBACK_SEC) return true;          releaseItem(lane, item, true);
          return false;
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
    }, SPAWN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [
    canSpawnInLane,
    comments.length,
    enabled,
    getActiveBucket,
    makePreparedComment,
    prefillLanes,
    rebuildLanes,
    releaseItem,
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
      {Array.from({ length: slotCount }, (_, index) => (
        <DanmakuSlot
          key={index}
          ref={slotRefCallbacks[index]}
          screenWidth={width}
          fontSize={settings.fontSize}
          lineHeight={lineHeight}
        />
      ))}
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
  item: {
    position: "absolute",
    left: 0,
    fontWeight: "600",
    textShadowColor: "rgba(0, 0, 0, 0.95)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 1.5,
  },
});

export default DanmakuOverlay;
