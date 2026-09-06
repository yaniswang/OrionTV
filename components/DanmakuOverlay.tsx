import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import useDanmakuStore from "@/stores/danmakuStore";
import usePlayerStore from "@/stores/playerStore";
import {
  DANMAKU_TRACK_GAP,
  danmakuDuration,
  danmakuMaxFlying,
  danmakuTrackCount,
  danmakuTrackToY,
  estimateDanmakuWidth,
  filterDanmakuByDensity,
  findSpawnIndex,
  interpolateVideoTime,
  pickDanmakuTrack,
  progressFromTranslateX,
  remainingScrollMs,
  shouldRefreshVideoClock,
  shouldSpawnComment,
  type VideoClockSnapshot,
  type VideoClockSyncState,
} from "@/utils/danmaku";

type FlyingItem = {
  key: string;
  text: string;
  color: string;
  y: number;
  startTime: number;
  duration: number;
  width: number;
  mode: number;
};

type DanmakuItemProps = {
  item: FlyingItem;
  screenWidth: number;
  paused: boolean;
  opacity: number;
  fontSize: number;
  onFinished: (key: string) => void;
};

const DanmakuItem = React.memo(function DanmakuItem({
  item,
  screenWidth,
  paused,
  opacity,
  fontSize,
  onFinished,
}: DanmakuItemProps) {
  const translateX = useRef(new Animated.Value(screenWidth)).current;
  const fade = useRef(new Animated.Value(item.mode === 0 ? opacity : 0)).current;
  const currentX = useRef(screenWidth);
  const fadeProgress = useRef(0);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    let cancelled = false;

    const stop = (saveX?: boolean) => {
      animRef.current?.stop();
      animRef.current = null;
      if (saveX) {
        translateX.stopAnimation((value) => {
          currentX.current = value;
        });
      }
    };

    if (paused) {
      if (item.mode === 0) stop(true);
      else {
        animRef.current?.stop();
        fade.stopAnimation((value) => {
          fadeProgress.current = value;
        });
      }
      return () => {
        cancelled = true;
      };
    }

    if (item.mode === 0) {
      const progress = progressFromTranslateX(currentX.current, screenWidth, item.width);
      const duration = remainingScrollMs(item.duration, progress * item.duration);
      if (duration <= 0) {
        onFinishedRef.current(item.key);
        return () => {
          cancelled = true;
        };
      }
      translateX.setValue(currentX.current);
      const anim = Animated.timing(translateX, {
        toValue: -item.width,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      });
      animRef.current = anim;
      anim.start(({ finished }) => {
        if (finished && !cancelled) onFinishedRef.current(item.key);
      });
      return () => {
        cancelled = true;
        stop(true);
      };
    }

    const remaining = remainingScrollMs(item.duration, fadeProgress.current * item.duration);
    const fadeInMs = Math.min(400, item.duration * 150);
    const fadeOutMs = fadeInMs;
    const holdMs = Math.max(0, remaining - fadeInMs - fadeOutMs);
    const anim = Animated.sequence([
      Animated.timing(fade, {
        toValue: opacity,
        duration: fadeProgress.current > 0 ? 0 : fadeInMs,
        useNativeDriver: true,
      }),
      Animated.delay(holdMs),
      Animated.timing(fade, {
        toValue: 0,
        duration: fadeOutMs,
        useNativeDriver: true,
      }),
    ]);
    animRef.current = anim;
    anim.start(({ finished }) => {
      if (finished && !cancelled) onFinishedRef.current(item.key);
    });
    return () => {
      cancelled = true;
      animRef.current?.stop();
    };
  }, [paused, item, screenWidth, opacity, fade, translateX]);

  const displayFontSize = Platform.isTV ? fontSize + 6 : fontSize;
  const textStyle = [styles.item, { color: item.color, fontSize: displayFontSize, opacity }];

  if (item.mode === 0) {
    return (
      <Animated.View
        pointerEvents="none"
        collapsable={false}
        style={[styles.itemWrap, { top: item.y, transform: [{ translateX }] }]}
      >
        <Text numberOfLines={1} style={textStyle}>
          {item.text}
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      pointerEvents="none"
      collapsable={false}
      style={[
        styles.itemWrap,
        {
          top: item.y,
          left: (screenWidth - item.width) / 2,
          opacity: fade,
        },
      ]}
    >
      <Text numberOfLines={1} style={textStyle}>
        {item.text}
      </Text>
    </Animated.View>
  );
});

export const DanmakuOverlay: React.FC = () => {
  const enabled = useDanmakuStore((s) => s.enabled);
  const comments = useDanmakuStore((s) => s.comments);
  const opacity = useDanmakuStore((s) => s.opacity);
  const fontSize = useDanmakuStore((s) => s.fontSize);
  const area = useDanmakuStore((s) => s.area);
  const density = useDanmakuStore((s) => s.density);
  const paused = usePlayerStore((s) => !s.status.isPlaying || s.isSeeking);
  const isSeeking = usePlayerStore((s) => s.isSeeking);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [flying, setFlying] = useState<FlyingItem[]>([]);

  const visibleComments = useMemo(
    () => filterDanmakuByDensity(comments, density),
    [comments, density]
  );

  const flyingRef = useRef<FlyingItem[]>([]);
  const spawnIndexRef = useRef(0);
  const tracksRef = useRef<number[]>([]);
  const lastSeekRef = useRef(false);
  const commentsRef = useRef(visibleComments);
  const fontSizeRef = useRef(fontSize);
  const screenHeightRef = useRef(screenHeight);
  const isSeekingRef = useRef(isSeeking);
  const areaRef = useRef(area);
  const densityRef = useRef(density);
  const clockRef = useRef<VideoClockSnapshot>({ time: 0, wall: Date.now(), playing: false, rate: 1 });
  const syncRef = useRef<VideoClockSyncState>({ videoTime: 0, playing: false, rate: 1 });

  commentsRef.current = visibleComments;
  fontSizeRef.current = fontSize;
  screenHeightRef.current = screenHeight;
  isSeekingRef.current = isSeeking;
  areaRef.current = area;
  densityRef.current = density;

  const trackCountFor = () =>
    danmakuTrackCount(screenHeightRef.current, fontSizeRef.current, areaRef.current);

  const resetSpawn = useCallback((time: number) => {
    spawnIndexRef.current = findSpawnIndex(commentsRef.current, time);
    tracksRef.current = new Array(trackCountFor()).fill(-999);
    flyingRef.current = [];
    setFlying([]);
  }, []);

  useEffect(() => {
    const syncClock = () => {
      const state = usePlayerStore.getState();
      const durationSec = (state.status.durationMillis || 0) / 1000;
      const videoTime = state.isSeeking
        ? state.seekPosition * durationSec
        : (state.status.positionMillis || 0) / 1000;
      const playing = !!state.status.isPlaying && !state.isSeeking;
      const next = { videoTime, playing, rate: state.playbackRate || 1 };
      if (shouldRefreshVideoClock(syncRef.current, next)) {
        syncRef.current = next;
        clockRef.current = {
          time: videoTime,
          wall: Date.now(),
          playing,
          rate: next.rate,
        };
      }
    };
    syncClock();
    return usePlayerStore.subscribe(syncClock);
  }, []);

  useEffect(() => {
    resetSpawn(interpolateVideoTime(clockRef.current, Date.now()));
  }, [comments, visibleComments, area, density, resetSpawn]);

  useEffect(() => {
    if (isSeeking && !lastSeekRef.current) {
      lastSeekRef.current = true;
      flyingRef.current = [];
      setFlying([]);
      return;
    }
    if (!isSeeking && lastSeekRef.current) {
      lastSeekRef.current = false;
      resetSpawn(interpolateVideoTime(clockRef.current, Date.now()));
    }
  }, [isSeeking, resetSpawn]);

  useEffect(() => {
    if (!enabled || comments.length === 0) {
      flyingRef.current = [];
      setFlying([]);
      return;
    }

    const tick = () => {
      if (isSeekingRef.current) return;
      const t = interpolateVideoTime(clockRef.current, Date.now());
      const list = commentsRef.current;
      const existing = flyingRef.current;
      const nextFlying: FlyingItem[] = [];
      let changed = false;

      for (const item of existing) {
        if (t - item.startTime < item.duration + 0.5) {
          nextFlying.push(item);
        } else {
          changed = true;
        }
      }

      const maxFlying = danmakuMaxFlying(densityRef.current);
      const allowOverlap = densityRef.current !== "sparse";
      while (
        spawnIndexRef.current < list.length &&
        list[spawnIndexRef.current].time <= t &&
        nextFlying.length < maxFlying
      ) {
        const comment = list[spawnIndexRef.current];
        spawnIndexRef.current += 1;
        if (!shouldSpawnComment(comment.time, t)) continue;

        const size = fontSizeRef.current;
        const height = screenHeightRef.current;
        const track = pickDanmakuTrack(t, comment.mode, tracksRef.current, DANMAKU_TRACK_GAP, allowOverlap);
        if (track < 0) continue;

        nextFlying.push({
          key: `${comment.time}-${spawnIndexRef.current}-${comment.text.slice(0, 8)}`,
          text: comment.text,
          color: comment.color,
          y: danmakuTrackToY(track, comment.mode, height, size, tracksRef.current.length, areaRef.current),
          startTime: comment.time,
          duration: danmakuDuration(comment.mode),
          width: estimateDanmakuWidth(comment.text, size),
          mode: comment.mode,
        });
        changed = true;
      }

      if (!changed) return;
      flyingRef.current = nextFlying;
      setFlying(nextFlying);
    };

    const id = setInterval(tick, 100);
    tick();
    return () => clearInterval(id);
  }, [enabled, comments, visibleComments, area, density]);

  const handleFinished = useCallback((key: string) => {
    setFlying((prev) => {
      const next = prev.filter((item) => item.key !== key);
      flyingRef.current = next;
      return next;
    });
  }, []);

  if (!enabled || comments.length === 0) return null;

  return (
    <View pointerEvents="none" style={styles.stage}>
      {flying.map((item) => (
        <DanmakuItem
          key={item.key}
          item={item}
          screenWidth={screenWidth}
          paused={paused}
          opacity={opacity}
          fontSize={fontSize}
          onFinished={handleFinished}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  stage: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 8,
    overflow: "hidden",
  },
  itemWrap: {
    position: "absolute",
    left: 0,
  },
  item: {
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
    includeFontPadding: false,
  },
});
