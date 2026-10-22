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
  Animated,
  Dimensions,
  Easing,
  StyleSheet,
  View,
  useWindowDimensions,
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
  getDanmakuSpawnGap,
  getDanmakuTrackCount,
  getDanmakuVisualLane,
  takeDanmakuAt,
  type DanmakuDensity,
} from "@/utils/danmakuLayout";

const SPAWN_INTERVAL_MS = 100;
const STALL_CHECK_INTERVAL_MS = 500;
const STALL_THRESHOLD_MS = 1500;
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
    onFinish: () => void;
  }) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setSpeed: (speed: number) => void;
}

interface DanmakuSlotProps {
  screenWidth: number;
  fontSize: number;
  lineHeight: number;
}

const adjustBrightness = (hex: string, factor: number): string => {
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
      const visibleRef = useRef(false);
      const translateX = useRef(new Animated.Value(screenWidth)).current;
      const animationRef = useRef<Animated.CompositeAnimation | null>(null);
      const animationTokenRef = useRef(0);
      const widthRef = useRef(0);
      const speedRef = useRef(0);
      const pausedRef = useRef(false);
      const pausedPositionRef = useRef<number | null>(null);
      const pendingResumeRef = useRef(false);
      const busyRef = useRef(false);
      const finishCbRef = useRef<(() => void) | null>(null);
      const renderTokenRef = useRef(0);

      const setSlotVisible = useCallback((nextVisible: boolean) => {
        visibleRef.current = nextVisible;
        if (!nextVisible) setContent(null);
      }, []);

      const start = useCallback(
        (from: number) => {
          const speed = speedRef.current;
          if (!widthRef.current || speed <= 0) return;
          const remaining = Math.max(1, from + widthRef.current);
          const duration = (remaining / speed) * 1000;
          animationRef.current?.stop();
          const token = ++animationTokenRef.current;
          animationRef.current = Animated.timing(translateX, {
            toValue: -widthRef.current,
            duration,
            easing: Easing.linear,
            useNativeDriver: true,
          });
          animationRef.current.start(({ finished }) => {
            if (token !== animationTokenRef.current || !finished) return;
            if (pausedRef.current) {
              translateX.setValue(pausedPositionRef.current ?? screenWidth);
              return;
            }
            busyRef.current = false;
            setSlotVisible(false);
            finishCbRef.current?.();
            finishCbRef.current = null;
          });
        },
        [screenWidth, setSlotVisible, translateX],
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
            onFinish,
          }) => {
            animationRef.current?.stop();
            animationTokenRef.current += 1;
            widthRef.current = width;
            speedRef.current = speed;
            pausedRef.current = false;
            pausedPositionRef.current = null;
            pendingResumeRef.current = false;
            busyRef.current = true;
            finishCbRef.current = onFinish;
            translateX.setValue(startX);
            renderTokenRef.current += 1;
            setContent({
              text,
              color,
              row,
              secondary,
              renderToken: renderTokenRef.current,
            });
            setSlotVisible(true);
            start(startX);
          },
          pause: () => {
            if (pausedRef.current || !busyRef.current) return;
            pausedRef.current = true;
            animationTokenRef.current += 1;
            const animation = animationRef.current;
            animationRef.current = null;
            animation?.stop();
            translateX.stopAnimation((value) => {
              pausedPositionRef.current = value;
              translateX.setValue(value);
              if (pendingResumeRef.current) {
                pendingResumeRef.current = false;
                if (
                  !pausedRef.current &&
                  visibleRef.current &&
                  busyRef.current
                ) {
                  start(value);
                }
              }
            });
          },
          resume: () => {
            if (!pausedRef.current) return;
            pausedRef.current = false;
            const frozenPosition = pausedPositionRef.current;
            pausedPositionRef.current = null;
            if (!visibleRef.current || !busyRef.current) {
              pendingResumeRef.current = false;
              return;
            }
            if (frozenPosition !== null) {
              pendingResumeRef.current = false;
              start(frozenPosition);
            } else {
              pendingResumeRef.current = true;
            }
          },
          stop: () => {
            animationTokenRef.current += 1;
            pausedRef.current = false;
            pausedPositionRef.current = null;
            pendingResumeRef.current = false;
            busyRef.current = false;
            finishCbRef.current = null;
            animationRef.current?.stop();
            animationRef.current = null;
            setSlotVisible(false);
          },
          setSpeed: (nextSpeed) => {
            if (nextSpeed <= 0 || speedRef.current === nextSpeed) return;
            speedRef.current = nextSpeed;
            if (!busyRef.current || pausedRef.current) return;
            translateX.stopAnimation((value) => start(value));
          },
        }),
        [setSlotVisible, start, translateX],
      );

      if (!content) return null;

      return (
        <Animated.Text
          key={content.renderToken}
          numberOfLines={1}
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
              transform: [{ translateX }],
            },
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
  const localPlaying = usePlayerStore((state) => state.status.isPlaying);
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
  const playing = isCasting ? castPlaying : localPlaying;
  const isSeeking = isCasting ? castIsSeeking : localIsSeeking;
  const seekCommitVersion = isCasting
    ? castSeekCommitVersion
    : localSeekCommitVersion;
  const seekPosition = isCasting ? castSeekPosition : localSeekPosition;
  const playbackDurationMillis = isCasting
    ? castDurationMillis
    : localDurationMillis;
  const { width, height } = useWindowDimensions();

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
  const lastSeekCommitVersionRef = useRef(seekCommitVersion);
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

  const spawnAtEdge = useCallback(
    (
      lane: LaneRuntime,
      prepared: PreparedComment,
      now: number,
    ): boolean => {
      const slotIndex = slotItemsRef.current.findIndex((item) => item === null);
      if (slotIndex < 0) return false;
      const slot = slotRefs.current[slotIndex];
      if (!slot) return false;

      const item: ActiveDanmaku = {
        ...prepared,
        id: nextIdRef.current++,
        row: lane.row,
        secondary: lane.secondary,
        startX: width,
        startWall: now,
        speed: prepared.baseSpeed * speedFactorRef.current,
        slotIndex,
      };
      slotItemsRef.current[slotIndex] = item;
      lane.items.push(item);
      slot.play({
        text: item.text,
        color: item.secondary ? item.secondaryColor : item.primaryColor,
        row: item.row,
        secondary: item.secondary,
        width: item.width,
        speed: item.speed,
        startX: item.startX,
        onFinish: () => releaseItem(lane, item),
      });
      if (motionPausedRef.current) slot.pause();
      return true;
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
    slotItemsRef.current = slotItemsRef.current.map(() => null);
    lanesRef.current = [];
  }, []);

  const syncMotionState = useCallback((nextPaused: boolean) => {
    if (motionPausedRef.current === nextPaused) return;
    motionPausedRef.current = nextPaused;

    if (nextPaused) {
      if (pausedAtRef.current === null) pausedAtRef.current = Date.now();
    } else if (pausedAtRef.current !== null) {
      const delta = Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
      lastAdvanceAtRef.current = Date.now();
      lanesRef.current.forEach((lane) => {
        lane.items.forEach((item) => {
          item.startWall += delta;
        });
      });
    }

    slotRefs.current.forEach((slot) => {
      if (nextPaused) slot?.pause();
      else slot?.resume();
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

  const fillAllLanesFromBucket = useCallback(
    (positionSec: number) => {
      const activeBucket = getActiveBucket(positionSec);
      if (!activeBucket.length) return;
      const now = Date.now();
      let added = true;
      while (activeBucket.length && added) {
        added = false;
        for (const lane of lanesRef.current) {
          if (!lane.spawning || !activeBucket.length) continue;
          const randomIndex = Math.floor(Math.random() * activeBucket.length);
          const prepared = makePreparedComment(activeBucket[randomIndex]);
          if (!prepared) {
            takeDanmakuAt(activeBucket, randomIndex);
            added = true;
            continue;
          }
          if (!canSpawnInLane(lane, prepared, now)) continue;
          if (!spawnAtEdge(lane, prepared, now)) continue;
          takeDanmakuAt(activeBucket, randomIndex);
          lane.nextGap = getDanmakuSpawnGap(densityRef.current);
          added = true;
        }
      }
    },
    [canSpawnInLane, getActiveBucket, makePreparedComment, spawnAtEdge],
  );

  useEffect(() => {
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
    rebuildLanes();
    fillAllLanesFromBucket(targetPositionMillis / 1000);
    slotRefs.current.forEach((slot) => slot?.pause());
  }, [
    fillAllLanesFromBucket,
    playbackDurationMillis,
    rebuildLanes,
    seekCommitVersion,
    seekPosition,
    syncMotionState,
  ]);

  useEffect(() => {
    if (isSeeking || !seekingRef.current) return;
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
    rebuildLanes();
  }, [clearSlots, comments, enabled, rebuildCommentBuckets, rebuildLanes, videoDuration]);

  useEffect(() => {
    if (!enabled || !comments.length) {
      clearSlots();
      return;
    }
    rebuildLanes();
  }, [
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
      playingRef.current =
        !explicitlyPaused && (nextPlaying || progressed);
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
    const state = usePlayerStore.getState();
    apply(
      state.status.positionMillis,
      state.status.isPlaying,
      state.isSeeking,
    );
    return usePlayerStore.subscribe((state, prev) => {
      if (state.status === prev.status && state.isSeeking === prev.isSeeking) {
        return;
      }
      apply(
        state.status.positionMillis,
        state.status.isPlaying,
        state.isSeeking,
      );
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
      const motionShouldPause =
        !playingRef.current || stalledRef.current || seekingRef.current;
      syncMotionState(motionShouldPause);
      if (motionShouldPause) {
        return;
      }
      const now = Date.now();
      let basePositionMillis = lastPositionRef.current;
      const seekTargetPosition = seekTargetPositionRef.current;
      if (seekTargetPosition !== null) {
        if (Math.abs(basePositionMillis - seekTargetPosition) <= 1500) {
          seekTargetPositionRef.current = null;
        } else {
          basePositionMillis = seekTargetPosition;
        }
      }
      const estimatedPositionSec = Math.max(
        0,
        (basePositionMillis + (now - lastAdvanceAtRef.current)) / 1000,
      );
      if (
        estimatedPositionSec < lastRenderedPositionRef.current - 1 ||
        estimatedPositionSec > lastRenderedPositionRef.current + 2
      ) {
        rebuildLanes();
      }
      lastRenderedPositionRef.current = estimatedPositionSec;

      const activeBucket = getActiveBucket(estimatedPositionSec);
      lanesRef.current.forEach((lane) => {
        lane.items = lane.items.filter((item) => {
          const elapsed = Math.max(0, now - item.startWall) / 1000;
          const left = item.startX - item.speed * elapsed;
          if (left + item.width >= 0) return true;
          releaseItem(lane, item, true);
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
        if (!spawnAtEdge(lane, next, now)) return;
        takeDanmakuAt(activeBucket, randomIndex);
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
    rebuildLanes,
    releaseItem,
    spawnAtEdge,
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
