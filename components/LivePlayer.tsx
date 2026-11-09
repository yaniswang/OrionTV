import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle } from "react";
import { View, StyleSheet, Text, ActivityIndicator, AppState, AppStateStatus, Platform, useWindowDimensions } from "react-native";
import Video, { VideoRef, ResizeMode, OnPlaybackStateChangedData, ViewType, OnProgressData } from 'react-native-video';
import { useKeepAwake } from "expo-keep-awake";
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import SystemSetting from 'react-native-system-setting'
import { AnimatedVerticalProgress } from "@/components/AnimatedVerticalProgress";
import { gammaToLinear, linearToGamma } from "@/utils/BrightnessUtils";

/** 左右滑拖进度的回调；fraction = 水平位移 / 屏幕宽度 */
export interface SeekPanHandlers {
  begin: () => void;
  update: (fraction: number) => void;
  end: () => void;
}

interface LivePlayerProps {
  url: string | null;
  ua: string;
  /** 直播用直播缓冲参数，回看是点播 */
  isLive: boolean;
  /** 时移：本地代理生成的持续增长清单。播放器当直播刷新，从清单开头播放，不自动追直播点 */
  isShift?: boolean;
  /** 回看起播位置（毫秒，相对本段地址开头） */
  startPositionMs?: number;
  paused: boolean;
  onProgress?: (currentSec: number) => void;
  /** 回看加载完成，报告实际时长（秒） */
  onLoad?: (durationSec: number) => void;
  onEnd?: () => void;
  /** 出错或超时未起播 */
  onFailed: () => void;
  /** 开始播放（含缓冲后恢复） */
  onPlaying?: () => void;
  onTap: () => void;
  onDoubleTap?: () => void;
  /** 为空表示不支持拖进度（频道不支持回看） */
  seekPan?: SeekPanHandlers | null;
  /** 中间区域上下滑（手指往上推为 up） */
  onVerticalSwipe?: (dir: 'up' | 'down') => void;
}

/** 左右两侧调亮度 / 音量的区域宽度占比，中间是上下滑切换 */
export const SIDE_ZONE = 0.2;
/** 中间上下滑超过这个距离才切换 */
export const SWIPE_DISTANCE = 60;

export interface LivePlayerHandle {
  seek: (sec: number) => void;
}

const PLAYBACK_TIMEOUT = 15000; // 15 seconds
const PAN_THRESHOLD = 30;

const LivePlayer = forwardRef<LivePlayerHandle, LivePlayerProps>(function LivePlayer(
  { url, ua, isLive, isShift = false, startPositionMs, paused, onProgress, onLoad, onEnd, onFailed, onPlaying, onTap, onDoubleTap, seekPan, onVerticalSwipe },
  ref,
) {
  const video = useRef<VideoRef>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFailed, setIsFailed] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { width: screenWidth } = useWindowDimensions();

  const [volume, setVolume] = useState(-1);
  const [volumeBarShow, setVolumeBarShow] = useState(-1);
  const [brightness, setBrightness] = useState(-1);
  const [brightnessBarShow, setBrightnessBarShow] = useState(-1);

  // 手势回调里读最新值，用 ref
  const gestureMode = useRef<'' | 'volume' | 'brightness' | 'seek' | 'swipe'>('');
  const startX = useRef(0);
  const lastT_Y = useRef(0);
  const accumulativeY = useRef(0);
  const volumeRef = useRef(-1);
  const brightnessRef = useRef(-1);
  const seekPanRef = useRef(seekPan);
  seekPanRef.current = seekPan;

  const [inBackground, setInBackground] = useState(false);
  const videoUrl = url && !inBackground ? url : null;

  useKeepAwake();

  useImperativeHandle(ref, () => ({
    seek: (sec: number) => video.current?.seek(sec),
  }), []);

  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      // 切到后台卸载播放器，回到前台重新起播
      setInBackground(nextAppState === "background" || nextAppState === "inactive");
    };
    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsFailed(false);

    if (videoUrl) {
      setIsLoading(true);
      timeoutRef.current = setTimeout(() => {
        setIsFailed(true);
        setIsLoading(false);
        onFailed();
      }, PLAYBACK_TIMEOUT);
    } else {
      setIsLoading(false);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [videoUrl]);

  const handlePlaybackStateChanged = (data: OnPlaybackStateChangedData) => {
    if (data.isPlaying) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      setIsLoading(false);
      onPlaying?.();
    } else if (!paused) {
      setIsLoading(true);
    }
  }

  const handleProgress = (data: OnProgressData) => {
    onProgress?.(data.currentTime);
  };

  // 1. 调节音量 (右侧)
  const handleVolume = (direction: string) => {
    let next = direction === 'up' ? volumeRef.current + 0.05 : volumeRef.current - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    SystemSetting.setVolume(next);
    volumeRef.current = next;
    setVolume(next);
    setVolumeBarShow(new Date().getTime());
  };

  // 2. 调节亮度 (左侧)
  const handleBrightness = (direction: string) => {
    let next = direction === 'up' ? brightnessRef.current + 0.05 : brightnessRef.current - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    const linear = Platform.OS === 'android' ? gammaToLinear(next) : next;
    SystemSetting.setAppBrightness(linear);
    brightnessRef.current = next;
    setBrightness(next)
    setBrightnessBarShow(new Date().getTime());
  };

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .runOnJS(true)
    .onEnd(() => onTap());

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .runOnJS(true)
    .onEnd(() => onDoubleTap?.());

  // 左右滑拖进度；上下滑：左侧 20% 调亮度，右侧 20% 调音量，中间 60% 松手时切换
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onBegin(async (e) => {
      gestureMode.current = '';
      startX.current = e.x;
      lastT_Y.current = 0;
      accumulativeY.current = 0;
      const v = await SystemSetting.getVolume();
      volumeRef.current = Math.round(v * 100) / 100;
      setVolume(volumeRef.current);
      const b = await SystemSetting.getAppBrightness();
      const normalized = Platform.OS === 'android' ? linearToGamma(b) : b;
      brightnessRef.current = Math.round(normalized * 100) / 100;
      setBrightness(brightnessRef.current);
    })
    .onUpdate((e) => {
      const { translationX, translationY } = e;
      const deltaY = translationY - lastT_Y.current;
      lastT_Y.current = translationY;
      accumulativeY.current += deltaY;

      if (gestureMode.current === '') {
        if (Math.abs(translationY) > PAN_THRESHOLD && Math.abs(translationY) > Math.abs(translationX)) {
          const x = startX.current;
          gestureMode.current = x < screenWidth * SIDE_ZONE ? 'brightness' : x > screenWidth * (1 - SIDE_ZONE) ? 'volume' : 'swipe';
          accumulativeY.current = 0;
        } else if (Math.abs(translationX) > PAN_THRESHOLD && seekPanRef.current) {
          gestureMode.current = 'seek';
          seekPanRef.current.begin();
        }
        return;
      }

      if (gestureMode.current === 'seek') {
        seekPanRef.current?.update(translationX / screenWidth);
        return;
      }
      if (gestureMode.current === 'swipe') return;

      if (Math.abs(accumulativeY.current) > 10) {
        const directionY = accumulativeY.current < 0 ? 'up' : 'down';
        if (gestureMode.current === 'volume') handleVolume(directionY);
        else handleBrightness(directionY);
        accumulativeY.current = 0;
      }
    })
    .onFinalize(() => {
      if (gestureMode.current === 'seek') seekPanRef.current?.end();
      if (gestureMode.current === 'swipe' && Math.abs(lastT_Y.current) > SWIPE_DISTANCE) {
        onVerticalSwipe?.(lastT_Y.current < 0 ? 'up' : 'down');
      }
      gestureMode.current = '';
      accumulativeY.current = 0;
    });

  const composedGesture = Gesture.Race(panGesture, Gesture.Exclusive(doubleTap, singleTap));
  return (
    <View style={styles.container}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GestureDetector gesture={composedGesture}>
          <View style={styles.videoContainer}>
            {/* 失败时只卸载播放器，保留手势层，否则无法点击打开频道列表、滑动换台 */}
            {videoUrl && !isFailed && (
            <Video
              ref={video}
              style={styles.video}
              source={{
                uri: videoUrl,
                type: /\.flv(\?|$)/i.test(videoUrl) ? undefined : 'm3u8',
                // 时移清单自带 EXT-X-START:TIME-OFFSET=0，从开头播
                startPosition: isLive || isShift ? undefined : startPositionMs,
                headers: {
                  'User-Agent': ua
                },
                bufferConfig: {
                  minBufferMs: 5000, // 最小缓冲
                  maxBufferMs: 20000, // 最大缓冲
                  bufferForPlaybackMs: 1500, // 首次起播缓冲量
                  bufferForPlaybackAfterRebufferMs: 3000, // 卡顿后恢复缓冲量
                  backBufferDurationMs: 0, // 保留已播放的缓存
                  cacheSizeMB: 0,
                  live: isLive ? {
                    targetOffsetMs: 10000,
                    minOffsetMs: 5000,
                    maxOffsetMs: 20000,
                    maxPlaybackSpeed: 1.1,
                    minPlaybackSpeed: 0.95,
                  } : isShift ? {
                    // 时移固定 1 倍速：不让播放器悄悄加速把落后的时间追回去
                    maxPlaybackSpeed: 1,
                    minPlaybackSpeed: 1,
                  } : undefined,
                }
              }}
              resizeMode={ResizeMode.CONTAIN}
              paused={paused}
              muted={false}
              disableAudioSessionManagement={false}
              playWhenInactive={false}
              progressUpdateInterval={1000}
              playInBackground={false}
              viewType={ViewType.SURFACE}
              disableFocus={true}
              reportBandwidth={true}
              onPlaybackStateChanged={handlePlaybackStateChanged}
              onProgress={isLive ? undefined : handleProgress}
              onLoad={(data) => {
                // 加载成功即取消超时：以暂停状态加载（双击进入时移）不会开始播放，不能只等「开始播放」
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                setIsLoading(false);
                // 时移清单持续增长，时长不能用来修正结束时刻
                if (!isLive && !isShift) onLoad?.(data.duration);
              }}
              onEnd={onEnd}
              onError={() => {
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                setIsFailed(true);
                setIsLoading(false);
                onFailed();
              }}
            />
            )}
          </View>
        </GestureDetector>
      </GestureHandlerRootView>
      {isLoading && !paused && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.messageText}>加载中...</Text>
        </View>
      )}
      <View style={styles.brightnessBar} pointerEvents="none">
        <AnimatedVerticalProgress progress={brightness} forceShow={brightnessBarShow} />
      </View>
      <View style={styles.volumeBar} pointerEvents="none">
        <AnimatedVerticalProgress progress={volume} forceShow={volumeBarShow} />
      </View>
    </View>
  );
});

export default LivePlayer;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "black",
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  messageText: {
    color: "#fff",
    fontSize: 16,
    marginTop: 10,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  videoContainer: {
    flex: 1,
    backgroundColor: 'black'
  },
  brightnessBar: {
    position: "absolute",
    left: 20,
    top: '50%', // 上边距为50%
    transform: [{ translateY: -75 }],
    width: 15,
  },
  volumeBar: {
    position: "absolute",
    right: 20,
    top: '50%', // 上边距为50%
    transform: [{ translateY: -75 }],
    width: 15,
  }
});
