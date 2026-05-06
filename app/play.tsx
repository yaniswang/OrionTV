import React, { useState, useEffect, useRef, memo, useMemo } from "react";
import { StyleSheet, BackHandler, View, Dimensions, Platform, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Video, { VideoRef } from 'react-native-video';
import { useKeepAwake } from "expo-keep-awake";
import { ThemedView } from "@/components/ThemedView";
import { PlayerControls } from "@/components/PlayerControls";
import { EpisodeSelectionModal } from "@/components/EpisodeSelectionModal";
import { SourceSelectionModal } from "@/components/SourceSelectionModal";
import { SpeedSelectionModal } from "@/components/SpeedSelectionModal";
import { SeekingBar } from "@/components/SeekingBar";
// import { NextEpisodeOverlay } from "@/components/NextEpisodeOverlay";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import useDetailStore from "@/stores/detailStore";
import { useTVRemoteHandler } from "@/hooks/useTVRemoteHandler";
import Toast from "react-native-toast-message";
import usePlayerStore, { selectCurrentEpisode } from "@/stores/playerStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { useVideoHandlers } from "@/hooks/useVideoHandlers";
import Logger from '@/utils/Logger';
import * as ScreenOrientation from 'expo-screen-orientation';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import SystemSetting from 'react-native-system-setting'
import { Immersive } from 'react-native-immersive';
import { AnimatedVerticalProgress } from "@/components/AnimatedVerticalProgress";

const logger = Logger.withTag('PlayScreen');

// 优化的加载动画组件
const LoadingContainer = memo(
  ({ style, currentEpisode }: { style: any; currentEpisode: { url: string; title: string } | undefined }) => {
    logger.info(
      `[PERF] Video component NOT rendered - waiting for valid URL. currentEpisode: ${!!currentEpisode}, url: ${
        currentEpisode?.url ? "exists" : "missing"
      }`
    );
    return (
      <View style={style}>
        <VideoLoadingAnimation showProgressBar loadingText="加载视频详情中，请稍等..." />
      </View>
    );
  }
);

LoadingContainer.displayName = "LoadingContainer";

// 移到组件外部避免重复创建
const createResponsiveStyles = (deviceType: string) => {
  const isMobile = deviceType === "mobile";
  const isTablet = deviceType === "tablet";

  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: "black",
      // 移动端和平板端可能需要状态栏处理
      ...(isMobile || isTablet ? { paddingTop: 0 } : {}),
    },
    videoContainer: {
      flex: 1,
      backgroundColor: 'black'
    },
    videoPlayer: {
      ...StyleSheet.absoluteFillObject,
    },
    loadingContainer: {
      position: 'absolute',
      backgroundColor: "rgba(0, 0, 0, 0.8)",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 10,
      width: '100%',
      height: '100%',
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
    },
    topRightContainer: {
      position: "absolute",
      top:20,
      right: 10,
    }
  });
};

export default function PlayScreen() {
  const videoRef = useRef<VideoRef>(null);
  const router = useRouter();
  const [volume, setVolume] = useState(-1);
  const [volumeBarShow, setVolumeBarShow] = useState(-1);
  const [brightness, setBrightness] = useState(-1);
  const [brightnessBarShow, setBrightnessBarShow] = useState(-1);
  const [gestureMode, setGestureMode] = useState('');

  useKeepAwake();

  // 响应式布局配置
  const { deviceType, screenWidth } = useResponsiveLayout();

  // 处理屏幕旋转
  const setOrientation = async (fullscreen: boolean) => {
    if (fullscreen) {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    } else {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    }
  };

  const {
    episodeIndex: episodeIndexStr,
    position: positionStr,
    source: sourceStr,
    id: videoId,
    q,
    title: videoTitle,
    year: videoYear,
    stype: videoStype
  } = useLocalSearchParams<{
    episodeIndex: string;
    position?: string;
    source?: string;
    id?: string;
    q?: string;
    title: string;
    year: string;
    stype: string;
  }>();
  const episodeIndex = parseInt(episodeIndexStr || "0", 10);
  const position = positionStr ? parseInt(positionStr, 10) : undefined;

  const { detail } = useDetailStore();
  const source = sourceStr || detail?.source;
  const id = videoId || detail?.id.toString();
  const title = videoTitle || detail?.title;
  const {
    isDetialLoading,
    isVideoLoading,
    showControls,
    showLockControls,
    // showNextEpisodeOverlay,
    playbackRate,
    isLandscapeMode,
    setVideoRef,
    handleVideoProgress,
    handleVideoLoad,
    handleVideoEnd,
    handleVideoPlaybackStateChanged,
    setShowControls,
    togglePlayPause,
    // setShowNextEpisodeOverlay,
    savePlayRecord,
    reset,
    loadVideo,
    seek,
  } = usePlayerStore();
  const currentEpisode = usePlayerStore(selectCurrentEpisode);

  // 使用Video事件处理hook
  const { videoProps } = useVideoHandlers({
    currentEpisode,
    playbackRate,
    handleVideoProgress,
    handleVideoLoad,
    handleVideoEnd,
    handleVideoPlaybackStateChanged,
    deviceType,
    detail: detail || undefined,
  });

  useEffect(() => {
    if(deviceType == 'mobile' && isLandscapeMode) {
      // 手机并且视频为横屏模式，切换为横屏
      setOrientation(true);
    }
    if(!Platform.isTV) {
      // 非TV才需要切换沉浸式模式
      Immersive.on();
    }
    return () => {
      if(deviceType == 'mobile' && isLandscapeMode) {
        setOrientation(false);
      }
      if (!Platform.isTV) {
        Immersive.off();
      }
    }
  }, [isLandscapeMode]);

  // TV遥控器处理 - 总是调用hook，但根据设备类型决定是否使用结果
  const tvRemoteHandler = useTVRemoteHandler();

  // 优化的动态样式 - 使用useMemo避免重复计算
  const dynamicStyles = useMemo(() => createResponsiveStyles(deviceType), [deviceType]);

  useEffect(() => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayScreen useEffect START - source: ${source}, id: ${id}, title: ${title}`);

    setVideoRef(videoRef);
    if (source && id && (q || title) && videoYear) {
      logger.info(`[PERF] Calling loadVideo with episodeIndex: ${episodeIndex}, position: ${position}`);
      loadVideo({ source, id: parseInt(id), episodeIndex, position, q, title, year: videoYear, stype: videoStype });
    } else {
      logger.info(`[PERF] Missing required params - source: ${!!source}, id: ${!!id}, title: ${!!title}`);
    }

    const perfEnd = performance.now();
    logger.info(`[PERF] PlayScreen useEffect END - took ${(perfEnd - perfStart).toFixed(2)}ms`);

    return () => {
      logger.info(`[PERF] PlayScreen unmounting - calling reset()`);
      reset(); // Reset state when component unmounts
    };
  }, [episodeIndex, source, position, setVideoRef, reset, loadVideo, id, q, title, videoYear, videoStype]);

  // 1. 调节音量 (右侧)
  const handleVolume = (direction:string) => {
    let next = direction === 'up' ? volume + 0.05 : volume - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    SystemSetting.setVolume(next);
    setVolume(next);
    setVolumeBarShow(new Date().getTime());
  };

  // 2. 调节亮度 (左侧)
  const handleBrightness = (direction:string) => {
    let next = direction === 'up' ? brightness + 0.05 : brightness - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    SystemSetting.setAppBrightness(next);
    setBrightness(next)
    setBrightnessBarShow(new Date().getTime());
  };

  // 3. 快进/快退
  const handleSeek = (direction:string) => {
    let seconds = direction == 'right' ? 20000 : -20000;
    seek(seconds)
  };

  // 单击显示控制条
  const singleTap = Gesture.Tap()
  .numberOfTaps(1)
  .runOnJS(true)
  .onEnd(() => {
    tvRemoteHandler.onScreenPress();
  });

  // --- 1. 双击手势 (播放/暂停) ---
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .runOnJS(true)
    .onEnd((event) => {
      if (showLockControls) return;
      const { x } = event;
      if (x < screenWidth * 0.1) {
        // 快退
        seek(-5000);
      }
      else if(x > screenWidth * 0.9) {
        // 快进
        seek(5000);
      }
      else {
        togglePlayPause()
      }      
    });

  const lastT_X = useRef(0);
  const accumulativeX = useRef(0);
  const lastT_Y = useRef(0);
  const accumulativeY = useRef(0);
  // --- 2. 平移手势 (快进、音量、亮度) ---
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onBegin(async (event) => {
      // 拖动开始时刷新音量和亮度值
      const volume = await SystemSetting.getVolume()
      setVolume(Math.round(volume * 100) / 100);
      const brightness = await SystemSetting.getAppBrightness();
      setBrightness(Math.round(brightness * 100) / 100)
      lastT_X.current = 0;
      lastT_Y.current = 0;
    })
    .onUpdate((e) => {
      if (showLockControls) return;
      const { x, translationX, translationY, velocityX, velocityY } = e;

      const deltaX = translationX - lastT_X.current;
      lastT_X.current = translationX;
      accumulativeX.current += deltaX;

      const deltaY = translationY - lastT_Y.current;
      lastT_Y.current = translationY;
      accumulativeY.current += deltaY;

      const isRightSide = x > screenWidth / 2;
      
      const absX = Math.abs(accumulativeX.current);
      const absY = Math.abs(accumulativeY.current);

      const directionX = accumulativeX.current < 0 ? 'left' : 'right';
      const directionY = accumulativeY.current < 0 ? 'up' : 'down';
      if(gestureMode == '') {
        // 首次判断手势模式，灵敏度阈值更高防止误判
        if (absY > 50) {
          // 垂直没滑动
          if (isRightSide) {
            setGestureMode('volume');
            handleVolume(directionY);
          } else {
            setGestureMode('brightness');
            handleBrightness(directionY);
          }
          accumulativeY.current = 0;
        }
        else if(absX > 50) {
          setGestureMode('seek');
          handleSeek(directionX)
          accumulativeX.current = 0;
        }
      } else {
        // 二次判断手势，降低灵敏度阈值
        if (gestureMode === 'seek') {
          if (absX > 10) {
            handleSeek(directionX)
            accumulativeX.current = 0;
          }
        }
        else {
          if (absY > 10) {
            if (gestureMode === 'volume') {
              handleVolume(directionY);
              accumulativeY.current = 0;
            }
            else if(gestureMode === 'brightness') {
              handleBrightness(directionY);
              accumulativeY.current = 0;
            }
          }
        }
      }
    })
    .onFinalize(() => {
      setGestureMode('');
      accumulativeX.current = 0;
      accumulativeY.current = 0;
    });

  const taps = Gesture.Exclusive(doubleTap, singleTap);
  const composedGesture = Gesture.Race(panGesture, taps);
  
  const handelBack = async() => {
    // 页面跳转前保存播放记录
    await savePlayRecord({ }, { immediate: true });
    router.back();
  };
  
  useEffect(() => {
    const backAction = () => {
      if (showControls) {
        setShowControls(false);
        return true;
      }
      handelBack();
      return true;
    };

    const backHandler = BackHandler.addEventListener("hardwareBackPress", backAction);

    return () => backHandler.remove();
  }, [showControls, setShowControls, router]);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;

    if (isDetialLoading) {
      timeoutId = setTimeout(() => {
        if (usePlayerStore.getState().isDetialLoading) {
          usePlayerStore.setState({ isDetialLoading: false });
          Toast.show({ type: "error", text1: "播放超时，请重试" });
        }
      }, 60000); // 1 minute
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isDetialLoading]);

  if (!detail) {
    return <VideoLoadingAnimation showProgressBar loadingText="加载视频详情中，请稍等..." />;
  }

  return (
    <ThemedView focusable style={dynamicStyles.container}>
      {/* 条件渲染Video组件：只有在有有效URL时才渲染 */}
      {currentEpisode?.url ? (
        <GestureHandlerRootView style={{ flex: 1 }}>
          <GestureDetector gesture={composedGesture}>
            <View style={dynamicStyles.videoContainer}>
              <Video ref={videoRef} style={dynamicStyles.videoPlayer} {...videoProps} />
            </View>
          </GestureDetector>
        </GestureHandlerRootView>
      ) : (
        <LoadingContainer style={dynamicStyles.loadingContainer} currentEpisode={currentEpisode} />
      )}

      {showControls && (
        <PlayerControls showControls={showControls} setShowControls={setShowControls} handelBack={handelBack} />
      )}

      {!showControls && (<SeekingBar />)}

      {/* 只在Video组件存在且正在加载时显示加载动画覆盖层 */}
      {currentEpisode?.url && isVideoLoading && (
        <View style={dynamicStyles.loadingContainer}>
          <VideoLoadingAnimation showProgressBar loadingText="拼命加载视频中..." />
        </View>
      )}

      {/* <NextEpisodeOverlay visible={showNextEpisodeOverlay} onCancel={() => setShowNextEpisodeOverlay(false)} /> */}
      {currentEpisode?.url && (<EpisodeSelectionModal />)}
      {currentEpisode?.url && (<SourceSelectionModal />)}
      {currentEpisode?.url && (<SpeedSelectionModal />)}
      
      <View style={dynamicStyles.brightnessBar}>
        <AnimatedVerticalProgress progress={brightness} forceShow={brightnessBarShow} />
      </View>
      <View style={dynamicStyles.volumeBar}>
        <AnimatedVerticalProgress progress={volume} forceShow={volumeBarShow} />
      </View>
    </ThemedView>
  );
}
