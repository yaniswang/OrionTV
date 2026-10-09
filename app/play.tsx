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
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import useDetailStore from "@/stores/detailStore";
import { useTVRemoteHandler } from "@/hooks/useTVRemoteHandler";
import Toast from "@/utils/Toast";
import usePlayerStore, { selectCurrentEpisode } from "@/stores/playerStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { useVideoHandlers } from "@/hooks/useVideoHandlers";
import Logger from '@/utils/Logger';
import * as ScreenOrientation from 'expo-screen-orientation';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Immersive } from 'react-native-immersive';
import { AnimatedVerticalProgress } from "@/components/AnimatedVerticalProgress";
import NetInfo from '@react-native-community/netinfo';
import { DLNAStatusPanel } from "@/components/DLNAStatusPanel";
import { DLNADeviceModal } from "@/components/DLNADeviceModal";
import { usePlaybackController } from "@/hooks/usePlaybackController";
import useDlnaStore from "@/stores/dlnaStore";
import { stopProxyServer } from "@/services/localProxy";

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
        <VideoLoadingAnimation showProgressBar loadingText="正在优选测速中……请稍等" />
      </View>
    );
  }
);

LoadingContainer.displayName = "LoadingContainer";

// 移到组件外部避免重复创建
const createResponsiveStyles = (deviceType: string) => {
  const isMobile = deviceType === "mobile";

  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: "black",
      // 移动端可能需要状态栏处理
      ...(isMobile ? { paddingTop: 0 } : {}),
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
  const volumeRef = useRef(-1);
  const [volumeBarShow, setVolumeBarShow] = useState(-1);
  const [brightness, setBrightness] = useState(-1);
  const brightnessRef = useRef(-1);
  const [brightnessBarShow, setBrightnessBarShow] = useState(-1);
  const [gestureMode, setGestureMode] = useState('');
  const [showDlnaDeviceModal, setShowDlnaDeviceModal] = useState(false);
  const gestureReadPendingRef = useRef(false);

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
  const title = videoTitle || detail?.title || "";
  
  const {
    isDetialLoading,
    isVideoLoading,
    showControls,
    showLockControls,
    isLandscapeMode,
    episodes,
    currentEpisodeIndex,
    setVideoRef,
    handleVideoProgress,
    handleVideoLoad,
    handleVideoEnd,
    handleVideoPlaybackStateChanged,
    setShowControls,
    savePlayRecord,
    reset,
    loadVideo,
  } = usePlayerStore();
  const currentEpisode = usePlayerStore(selectCurrentEpisode);
  const {
    isCasting,
    isLoading,
    loadingText,
    playbackRate,
    setPlaybackRate,
    togglePlayPause,
    seekBy,
    previewSeekBy,
    commitSeek,
    playEpisode,
    disableCast,
    getVolume: getPlaybackVolume,
    setVolume: setPlaybackVolume,
    getBrightness: getPlaybackBrightness,
    setBrightness: setPlaybackBrightness,
  } = usePlaybackController();


  const previousCastingRef = useRef(isCasting);

  // 退出投屏后重新读取本地音量和亮度，更新显示值并保持进度条隐藏，作为下一次手势的初始值。
  useEffect(() => {
    const wasCasting = previousCastingRef.current;
    previousCastingRef.current = isCasting;
    if (!wasCasting || isCasting) return;

    void Promise.allSettled([
      getPlaybackVolume(),
      getPlaybackBrightness(),
    ]).then(([volumeResult, brightnessResult]) => {
      if (volumeResult.status === 'fulfilled' && typeof volumeResult.value === 'number') {
        const nextVolume = Math.round(volumeResult.value * 100) / 100;
        volumeRef.current = nextVolume;
        setVolume(nextVolume);
        setVolumeBarShow(-1);
      }
      if (brightnessResult.status === 'fulfilled' && typeof brightnessResult.value === 'number') {
        const nextBrightness = Math.round(brightnessResult.value * 100) / 100;
        brightnessRef.current = nextBrightness;
        setBrightness(nextBrightness);
        setBrightnessBarShow(-1);
      }
    });
  }, [isCasting, getPlaybackVolume, getPlaybackBrightness]);
  // 切到集数更少的源时，当前集号可能越界，纠正回最后一集。
  // 必须放在 effect 里：渲染期间改状态会触发 React 的 setState-in-render 与 getSnapshot 警告。
  useEffect(() => {
    if (episodes.length > 0 && currentEpisodeIndex >= episodes.length) {
      void playEpisode(episodes.length - 1);
    }
  }, [episodes.length, currentEpisodeIndex, playEpisode]);

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

  const dlnaPhase = useDlnaStore((state) => state.phase);
  const autoOpenedDlnaDeviceModalRef = useRef(false);

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


  useEffect(() => {
    let previousIp: string | null | undefined;
    return NetInfo.addEventListener((state) => {
      const ipAddress =
        state.type === 'wifi' || state.type === 'ethernet'
          ? (state.details as { ipAddress?: string | null } | null)?.ipAddress ?? null
          : null;
      const changed = previousIp !== undefined && previousIp !== ipAddress;
      previousIp = ipAddress;
      if (!changed || !source || !id || !title || !videoYear) return;

      const castState = useDlnaStore.getState();
      const resumePosition = castState.enabled
        ? castState.positionMillis
        : usePlayerStore.getState().status.positionMillis;
      Toast.show({ type: 'info', text1: '网络已变化', text2: '正在重新加载播放' });
      void (async () => {
        if (castState.enabled) {
          await castState.disableCast({ restoreLocal: false, stopRemote: true });
        }
        await stopProxyServer();
        const player = usePlayerStore.getState();
        await loadVideo({
          source,
          id: parseInt(id, 10),
          episodeIndex: player.currentEpisodeIndex,
          title,
          year: videoYear,
          stype: videoStype,
          position: resumePosition,
        });
      })();
    });
  }, [source, id, title, videoYear, videoStype, loadVideo]);

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
      logger.info(`[PERF] PlayScreen unmounting - stopping cast and calling reset()`);
      void useDlnaStore.getState().disableCast({ restoreLocal: false, stopRemote: true });
      void stopProxyServer();
      reset(); // Reset state when component unmounts
    };
  }, [episodeIndex, source, position, setVideoRef, reset, loadVideo, id, q, title, videoYear, videoStype]);

  // 调节音量 (右侧)
  const handleVolume = (direction:string) => {
    let next = direction === 'up' ? volumeRef.current + 0.05 : volumeRef.current - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    volumeRef.current = next;
    void setPlaybackVolume(next);
    setVolume(next);
    setVolumeBarShow(new Date().getTime());
  };

  // 调节亮度 (左侧)
  const handleBrightness = (direction:string) => {
    let next = direction === 'up' ? brightnessRef.current + 0.05 : brightnessRef.current - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    brightnessRef.current = next;
    void setPlaybackBrightness(next);
    setBrightness(next)
    setBrightnessBarShow(new Date().getTime());
  };

  // 快进/快退：拖动期间只更新本地临时进度，手势结束后才提交。
  const handleSeek = (direction:string) => {
    const deltaMillis = direction === 'right' ? 20000 : -20000;
    previewSeekBy(deltaMillis);
  };

  // 单击显示控制条
  const singleTap = Gesture.Tap()
  .numberOfTaps(1)
  .runOnJS(true)
  .onEnd(() => {
    tvRemoteHandler.onScreenPress();
  });

  // 长按双倍速度播放
  const longPressGesture = Gesture.LongPress()
  .minDuration(300) // 按住300ms后开始快进
  .runOnJS(true)
  .onStart((e) => {
    if (showLockControls) return;
    void setPlaybackRate(2);
  })
  .onEnd(() => {
    if (showLockControls) return;
    void setPlaybackRate(1);
  })

  // --- 1. 双击手势 (播放/暂停) ---
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .runOnJS(true)
    .onEnd((event) => {
      if (showLockControls) return;
      const { x } = event;
      if (x < screenWidth * 0.1) {
        // 快退
        void seekBy(-10000);
      }
      else if(x > screenWidth * 0.9) {
        // 快进
        void seekBy(10000);
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
    .onBegin(async () => {
      gestureReadPendingRef.current = true;
      try {
        const [volumeResult, brightnessResult] = await Promise.allSettled([
          getPlaybackVolume(),
          getPlaybackBrightness(),
        ]);
        if (volumeResult.status === 'fulfilled' && typeof volumeResult.value === 'number') {
          const nextVolume = Math.round(volumeResult.value * 100) / 100;
          volumeRef.current = nextVolume;
        }
        if (brightnessResult.status === 'fulfilled' && typeof brightnessResult.value === 'number') {
          const nextBrightness = Math.round(brightnessResult.value * 100) / 100;
          brightnessRef.current = nextBrightness;
        }
      } finally {
        lastT_X.current = 0;
        lastT_Y.current = 0;
        gestureReadPendingRef.current = false;
      }
    })
    .onUpdate((e) => {
      if (gestureReadPendingRef.current) return;
      if (showLockControls) return;
      const { x, translationX, translationY } = e;

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
      void commitSeek();
      setGestureMode('');
      accumulativeX.current = 0;
      accumulativeY.current = 0;
    });

  const taps = Gesture.Exclusive(doubleTap, singleTap, longPressGesture);
  const composedGesture = Gesture.Race(panGesture, taps);
  
  const handelBack = async() => {
    // 页面跳转前保存播放记录；投屏时先关闭远端，避免留下无法控制的电视播放。
    try {
      if (isCasting) {
        await disableCast({ restoreLocal: false, stopRemote: true });
      } else {
        await savePlayRecord({}, { immediate: true });
      }
    } catch (e) {}
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
  }, [showControls, setShowControls, router, isCasting, disableCast]);

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
    return <VideoLoadingAnimation showProgressBar loadingText="正在优选测速中……请稍等" />;
  }

  return (
    <ThemedView focusable style={dynamicStyles.container}>
      {/* 投屏时卸载本机 Video，主画面固定为 DLNA 设备切换列表。 */}
      {isCasting ? (
        <GestureHandlerRootView style={{ flex: 1 }}>
          <GestureDetector gesture={composedGesture}>
            <View style={{ flex: 1 }} collapsable={false}>
              <DLNAStatusPanel />
            </View>
          </GestureDetector>
        </GestureHandlerRootView>
      ) : currentEpisode?.url ? (
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
        <PlayerControls
          showControls={showControls}
          setShowControls={setShowControls}
          handelBack={handelBack}
          onOpenDlnaDeviceModal={() => setShowDlnaDeviceModal(true)}
        />
      )}

      {!showControls && (<SeekingBar />)}

      {/* 本地/投屏统一消费控制器的加载状态 */}
      {currentEpisode?.url && isLoading && (
        <View style={dynamicStyles.loadingContainer}>
          <VideoLoadingAnimation showProgressBar loadingText={loadingText} />
        </View>
      )}

      {currentEpisode?.url && (<EpisodeSelectionModal />)}
      {currentEpisode?.url && (<SourceSelectionModal />)}
      {currentEpisode?.url && (<SpeedSelectionModal />)}
      <DLNADeviceModal
        visible={isCasting && showDlnaDeviceModal}
        onClose={() => setShowDlnaDeviceModal(false)}
      />
      
      <>
        <View style={dynamicStyles.brightnessBar}>
          <AnimatedVerticalProgress progress={brightness} forceShow={brightnessBarShow} />
        </View>
        <View style={dynamicStyles.volumeBar}>
          <AnimatedVerticalProgress progress={volume} forceShow={volumeBarShow} />
        </View>
      </>
    </ThemedView>
  );
}
