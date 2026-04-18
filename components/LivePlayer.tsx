import React, { useRef, useState, useEffect, useCallback } from "react";
import { View, StyleSheet, Text, ActivityIndicator, Dimensions } from "react-native";
import { Audio, Video, ResizeMode, AVPlaybackStatus } from "expo-av";
import { useKeepAwake } from "expo-keep-awake";
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import SystemSetting from 'react-native-system-setting'
import { AnimatedVerticalProgress } from "@/components/AnimatedVerticalProgress";

interface LivePlayerProps {
  streamUrl: string | null;
  channelTitle?: string | null;
  onPlaybackStatusUpdate: (status: AVPlaybackStatus) => void;
  onScreenPress: () => void;
  onScreenGesture: (direction: string) => void;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const PLAYBACK_TIMEOUT = 15000; // 15 seconds

export default function LivePlayer({ streamUrl, channelTitle, onPlaybackStatusUpdate, onScreenPress, onScreenGesture }: LivePlayerProps) {

  useEffect(() => {
    Audio.setAudioModeAsync({
      staysActiveInBackground: true,
    });
  }, []);

  const video = useRef<Video>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTimeout, setIsTimeout] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [volume, setVolume] = useState(-1);
  const [volumeBarWork, setVolumeBarWork] = useState(false);
  const [brightness, setBrightness] = useState(-1);
  const [brightnessBarWork, setBrightnessBarWork] = useState(false);
  const [gestureMode, setGestureMode] = useState('');

  const lastT_Y = useRef(0);
  const accumulativeY = useRef(0);
  
  useKeepAwake();

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (streamUrl) {
      setIsLoading(true);
      setIsTimeout(false);
      timeoutRef.current = setTimeout(() => {
        setIsTimeout(true);
        setIsLoading(false);
      }, PLAYBACK_TIMEOUT);
    } else {
      setIsLoading(false);
      setIsTimeout(false);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [streamUrl]);

  const handlePlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (status.isLoaded) {
      if (status.isPlaying) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        setIsLoading(false);
        setIsTimeout(false);
      } else if (status.isBuffering) {
        setIsLoading(true);
      }
    } else {
      if (status.error) {
        setIsLoading(false);
        setIsTimeout(true);
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
      }
    }
    onPlaybackStatusUpdate(status);
  };

  if (!streamUrl) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>按中键选择频道</Text>
      </View>
    );
  }

  if (isTimeout) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>加载失败，请重试</Text>
      </View>
    );
  }

  // 1. 调节音量 (右侧)
  const handleVolume = (direction:string) => {
    let next = direction === 'up' ? volume + 0.05 : volume - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    SystemSetting.setVolume(next);
    setVolumeBarWork(true);
    setVolume(next);
  };

  // 2. 调节亮度 (左侧)
  const handleBrightness = (direction:string) => {
    let next = direction === 'up' ? brightness + 0.05 : brightness - 0.05;
    next = Math.max(0, Math.min(1, next));
    next = Math.round(next * 100) / 100;
    SystemSetting.setAppBrightness(next);
    setBrightnessBarWork(true);
    setBrightness(next)
  };

  // 单击显示控制条
  const singleTap = Gesture.Tap()
  .numberOfTaps(1)
  .runOnJS(true)
  .onEnd(() => {
    onScreenPress();
  });

  // --- 2. 平移手势 (快进、音量、亮度) ---
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onBegin(async () => {
      // 拖动开始时刷新音量和亮度值
      const volume = await SystemSetting.getVolume()
      setVolume(Math.round(volume * 100) / 100);
      const brightness = await SystemSetting.getAppBrightness();
      setBrightness(Math.round(brightness * 100) / 100);
      lastT_Y.current = 0;
    })
    .onUpdate((e) => {
      const { x, translationX, translationY, velocityX, velocityY } = e;
      
      const deltaY = translationY - lastT_Y.current;
      lastT_Y.current = translationY;
      accumulativeY.current += deltaY;

      const isRightSide = x > SCREEN_WIDTH / 2;
      
      const absY = Math.abs(accumulativeY.current);
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
      } else {
        // 二次判断手势，降低灵敏度阈值
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
    })
    .onFinalize((e) => {
      if (gestureMode == '') {
        const { translationX } = e;
        if (Math.abs(translationX) > 50) {
          const directionY = translationX < 0 ? 'left' : 'right';
          onScreenGesture(directionY);
        }
      }
      setGestureMode('');
      accumulativeY.current = 0;
    });

  const composedGesture = Gesture.Race(panGesture, singleTap);

  return (
    <View style={styles.container}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GestureDetector gesture={composedGesture}>
          <View style={styles.videoContainer}>
            <Video
              ref={video}
              style={styles.video}
              source={{
                uri: streamUrl,
              }}
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
              onError={(e) => {
                setIsTimeout(true);
                setIsLoading(false);
              }}
            />
          </View>
        </GestureDetector>
      </GestureHandlerRootView>
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.messageText}>加载中...</Text>
        </View>
      )}
      {channelTitle && !isLoading && !isTimeout && (
        <View style={styles.overlay}>
          <Text style={styles.title}>{channelTitle}</Text>
        </View>
      )}
      <View style={styles.brightnessBar}>
        <AnimatedVerticalProgress progress={brightness} isWork={brightnessBarWork} />
      </View>
      <View style={styles.volumeBar}>
        <AnimatedVerticalProgress progress={volume} isWork={volumeBarWork} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "black",
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    position: "absolute",
    top: 20,
    left: 20,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    padding: 10,
    borderRadius: 5,
  },
  title: {
    color: "#fff",
    fontSize: 18,
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
