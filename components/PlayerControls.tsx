import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  findNodeHandle,
  type GestureResponderEvent,
} from "react-native";
import {
  Pause,
  Play,
  SkipForward,
  List,
  Tv,
  ArrowDownToDot,
  ArrowUpFromDot,
  Gauge,
  Unlock,
  Lock,
  ChevronLeft,
  Send,
  Cast,
  Power,
  MonitorSmartphone,
  Heart,
} from "lucide-react-native";
import { ThemedText } from "@/components/ThemedText";
import { MediaButton } from "@/components/MediaButton";
import { StyledButton } from "./StyledButton";
import usePlayerStore from "@/stores/playerStore";
import useDetailStore from "@/stores/detailStore";
import { useSources } from "@/stores/sourceStore";
import { Battery } from '@brightlayer-ui/react-native-progress-icons';
import { useBatteryLevel, useBatteryState, BatteryState } from 'expo-battery';
import { format } from 'date-fns';
import { usePlaybackController } from '@/hooks/usePlaybackController';
import { buildPlaybackTitle } from '@/utils/PlaybackTitleUtils';
import { DanmakuOnIcon, DanmakuOffIcon, DanmakuSettingsIcon } from "@/components/icons/DanmakuIcons";
import { DanmakuInfoBar } from "@/components/DanmakuInfoBar";
import { useDanmakuStore } from "@/stores/danmakuStore";

interface PlayerControlsProps {
  showControls: boolean;
  setShowControls: (show: boolean) => void;
  handelBack: () => Promise<void>;
  onOpenDlnaDeviceModal: () => void;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  showControls,
  setShowControls,
  handelBack,
  onOpenDlnaDeviceModal,
}) => {
  const batteryLevel = useBatteryLevel();
  const batteryState = useBatteryState();
  const {
    isCasting,
    status,
    progressPosition,
    bufferedPosition,
    isSeeking,
    seekPosition,
    playbackRate,
    seekBy,
    togglePlayPause,
    playEpisode,
    enableCast,
    disableCast,
  } = usePlaybackController();

  const {
    currentEpisodeIndex,
    episodes,
    showLockControls,
    toggleLock,
    setShowEpisodeModal,
    setShowSourceModal,
    setShowSpeedModal,
    setIntroEndTime,
    setOutroStartTime,
    toggleFavorite,
    introEndTime,
    outroStartTime,
    isFavorited,
    setShowDanmakuSettingsModal,
  } = usePlayerStore();

  const { detail } = useDetailStore();
  const resources = useSources();
  const danmakuEnabled = useDanmakuStore((state) => state.enabled);
  const toggleDanmaku = useDanmakuStore((state) => state.toggleEnabled);
  const preferDanmakuFocus = usePlayerStore((state) => state.preferDanmakuFocus);

  const videoTitle = detail?.title || "";
  const currentEpisode = episodes[currentEpisodeIndex];
  const currentEpisodeTitle = currentEpisode?.title;
  const currentSource = resources.find((r) => r.source === detail?.source);
  const currentSourceName = currentSource?.source_name;
  const displayTitle = buildPlaybackTitle({
    title: videoTitle,
    episodeCount: episodes.length,
    episodeTitle: currentEpisodeTitle,
    sourceName: currentSourceName,
  });
  const hasNextEpisode = currentEpisodeIndex < (episodes.length || 0) - 1;
  const progressBarWidthRef = React.useRef(0);
  const pillRef = React.useRef<View>(null);
  const playButtonRef = React.useRef<View>(null);
  const [focusTags, setFocusTags] = React.useState<{ pill?: number; play?: number }>({});
  // 面板常驻、隐藏时屏蔽子树焦点；重新显示时要等容器解除屏蔽（上一次提交）后再请求焦点
  const [focusReady, setFocusReady] = React.useState(false);

  React.useEffect(() => {
    setFocusReady(showControls);
  }, [showControls]);

  React.useEffect(() => {
    setFocusTags({
      pill: findNodeHandle(pillRef.current) ?? undefined,
      play: findNodeHandle(playButtonRef.current) ?? undefined,
    });
  }, [showControls, danmakuEnabled]);

  const formatTime = (milliseconds: number) => {
    if (!milliseconds) return "00:00";
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (hours === 0) {
      return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const onPlayNextEpisode = () => {
    if (hasNextEpisode) void playEpisode(currentEpisodeIndex + 1);
  };

  const durationMillis = status.durationMillis || 0;
  const seekPositionMillis = seekPosition * durationMillis;
  const castIconAvailable = !Platform.isTV && (Platform.OS === 'android' || Platform.OS === 'ios');
  const batteryPercent = batteryLevel >= 0 ? Math.round(batteryLevel * 100) : null;

  const handleProgressPress = (event: GestureResponderEvent) => {
    const width = progressBarWidthRef.current;
    if (showLockControls || !status.isLoaded || durationMillis <= 0 || width <= 0) return;

    const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / width));
    const currentPositionMillis = isSeeking ? seekPosition * durationMillis : status.positionMillis;
    const targetPositionMillis = ratio * durationMillis;

    void seekBy(targetPositionMillis - currentPositionMillis);
  };

  const onIntroPress = () => {
    setIntroEndTime(isCasting ? status.positionMillis : undefined);
  };

  const onOutroPress = () => {
    setOutroStartTime(
      isCasting ? status.positionMillis : undefined,
      isCasting ? status.durationMillis : undefined,
    );
  };

  return (
    <View
      style={[styles.controlContainer, !showControls && styles.hidden]}
      pointerEvents={showControls ? undefined : "none"}
      // @ts-expect-error react-native-tvos Android 原生属性，类型未声明；false 时屏蔽子树焦点
      tvFocusable={Platform.isTV ? showControls : undefined}
    >
      <View style={styles.topLeftContainer}>
        {!Platform.isTV && !showLockControls && (
          <Pressable onPress={handelBack} style={styles.topBackButton}>
            <ChevronLeft color="white" size={26} />
          </Pressable>
        )}
        <Text style={styles.topTitleText} numberOfLines={1}>
          {displayTitle}
        </Text>
        {detail?.useProxy && <Send color="#00bb5e" size={18} />}
        {!showLockControls && (
          <DanmakuInfoBar
            pillRef={pillRef}
            downFocusTag={focusTags.play}
            preferFocus={focusReady && preferDanmakuFocus}
            visible={showControls}
          />
        )}
      </View>

      <View style={styles.topRightContainer}>
        <Text style={styles.topTimeText}>{format(new Date(), 'HH:mm')}</Text>
        {!Platform.isTV && (
          <>
            <Battery
              percent={batteryPercent ?? 0}
              size={30}
              color={'#00bb5ea0'}
              charging={batteryState === BatteryState.CHARGING}
              outlined={false}
            />
            {batteryPercent !== null && (
              <Text style={styles.batteryPercentText}>{batteryPercent}%</Text>
            )}
          </>
        )}
        {isCasting && castIconAvailable && !showLockControls && (
          <Pressable onPress={onOpenDlnaDeviceModal} style={styles.castButton}>
            <MonitorSmartphone color="white" size={24} />
          </Pressable>
        )}
        {castIconAvailable && !showLockControls && (
          <Pressable
            onPress={() => void (isCasting ? disableCast({ restoreLocal: true, stopRemote: true }) : enableCast())}
            style={styles.castButton}
          >
            {isCasting ? <Power color="white" size={24} /> : <Cast color="white" size={24} />}
          </Pressable>
        )}
      </View>

      {!Platform.isTV && (
        <View style={styles.lockContainer}>
          <StyledButton onPress={toggleLock} variant="ghost">
            {showLockControls ? <Lock color="white" size={20} /> : <Unlock color="white" size={20} />}
          </StyledButton>
        </View>
      )}

      {!showLockControls && (
        <View style={styles.controlsOverlay}>
          <View style={styles.bottomControlsContainer}>
            <View style={styles.bottomTimesContainer}>
              <ThemedText style={{ color: "white", marginTop: 5 }}>
                {status.isLoaded
                  ? `${formatTime(isSeeking ? seekPositionMillis : status.positionMillis)} / ${formatTime(status.durationMillis || 0)}`
                  : "00:00 / 00:00"}
              </ThemedText>
            </View>

            <View style={styles.progressBarContainer}>
              <View style={styles.progressBarBackground} />
              <View style={[styles.bufferedBarFilled, { width: `${bufferedPosition * 100}%` }]} />
              <View
                style={[
                  styles.progressBarFilled,
                  { width: `${(isSeeking ? seekPosition : progressPosition) * 100}%` },
                ]}
              />
              <Pressable
                focusable={false}
                onLayout={(event) => {
                  progressBarWidthRef.current = event.nativeEvent.layout.width;
                }}
                onPress={handleProgressPress}
                style={styles.progressBarTouchable}
              />
            </View>

            <View style={styles.bottomControls}>
              {episodes.length > 1 && (
                <MediaButton
                  onPress={onIntroPress}
                  timeLabel={introEndTime ? formatTime(introEndTime) : undefined}
                  nextFocusUp={focusTags.pill}
                >
                  <ArrowDownToDot color="white" size={24} />
                </MediaButton>
              )}

              <MediaButton
                ref={playButtonRef}
                onPress={() => void togglePlayPause()}
                hasTVPreferredFocus={focusReady && !(preferDanmakuFocus && danmakuEnabled)}
                nextFocusUp={focusTags.pill}
              >
                {status.isLoaded && status.isPlaying ? (
                  <Pause color="white" size={24} />
                ) : (
                  <Play color="white" size={24} />
                )}
              </MediaButton>

              {episodes.length > 1 && (
                <MediaButton onPress={onPlayNextEpisode} disabled={!hasNextEpisode} nextFocusUp={focusTags.pill}>
                  <SkipForward color={hasNextEpisode ? "white" : "#666"} size={24} />
                </MediaButton>
              )}

              {episodes.length > 1 && (
                <MediaButton
                  onPress={onOutroPress}
                  timeLabel={outroStartTime ? formatTime(outroStartTime) : undefined}
                  nextFocusUp={focusTags.pill}
                >
                  <ArrowUpFromDot color="white" size={24} />
                </MediaButton>
              )}

              {episodes.length > 1 && (
                <MediaButton onPress={() => setShowEpisodeModal(true)} nextFocusUp={focusTags.pill}>
                  <List color="white" size={24} />
                </MediaButton>
              )}

              <MediaButton onPress={() => setShowSourceModal(true)} nextFocusUp={focusTags.pill}>
                <Tv color="white" size={24} />
              </MediaButton>

              <MediaButton
                onPress={() => setShowSpeedModal(true)}
                timeLabel={playbackRate !== 1.0 ? `${playbackRate}x` : undefined}
                nextFocusUp={focusTags.pill}
              >
                <Gauge color="white" size={24} />
              </MediaButton>

              <MediaButton onPress={toggleDanmaku} nextFocusUp={focusTags.pill}>
                {danmakuEnabled ? <DanmakuOnIcon size={26} /> : <DanmakuOffIcon size={26} />}
              </MediaButton>

              {danmakuEnabled && (
                <MediaButton onPress={() => setShowDanmakuSettingsModal(true)} nextFocusUp={focusTags.pill}>
                  <DanmakuSettingsIcon size={26} />
                </MediaButton>
              )}

              <MediaButton onPress={toggleFavorite} nextFocusUp={focusTags.pill}>
                <Heart
                  size={24}
                  color={isFavorited ? "#feff5f" : "white"}
                  fill={isFavorited ? "#feff5f" : "transparent"}
                />
              </MediaButton>
            </View>
          </View>
        </View>
      )}

      {showLockControls && (
        <View style={styles.lockBottomBarContainer}>
          <View style={{ ...styles.progressBarContainer, marginTop: 0 }}>
            <View style={styles.progressBarBackground} />
            <View style={[styles.bufferedBarFilled, { width: `${bufferedPosition * 100}%` }]} />
            <View
              style={[
                styles.progressBarFilled,
                { width: `${(isSeeking ? seekPosition : progressPosition) * 100}%` },
              ]}
            />
            <Pressable
              focusable={false}
              onLayout={(event) => {
                progressBarWidthRef.current = event.nativeEvent.layout.width;
              }}
              onPress={handleProgressPress}
              style={styles.progressBarTouchable}
            />
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  controlContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  hidden: {
    opacity: 0,
  },
  controlsOverlay: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    justifyContent: "space-between",
    padding: 16,
  },
  bottomControlsContainer: {
    width: "100%",
    alignItems: "center",
  },
  bottomTimesContainer: {
    width: '100%',
  },
  bottomControls: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    marginTop: 10,
  },
  progressBarContainer: {
    width: "100%",
    height: 8,
    position: "relative",
    marginTop: 10,
  },
  progressBarBackground: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 8,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: 4,
  },
  bufferedBarFilled: {
    position: "absolute",
    zIndex: 1,
    left: 0,
    height: 8,
    backgroundColor: "rgba(255,255,255,0.5)",
    borderRadius: 4,
  },
  progressBarFilled: {
    position: "absolute",
    zIndex: 2,
    left: 0,
    height: 8,
    backgroundColor: "#00bb5e",
    borderRadius: 4,
  },
  progressBarTouchable: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 30,
    top: -10,
    zIndex: 10,
  },
  topTitleText: {
    // 标题完整显示，不截断
    flexShrink: 0,
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
    marginRight: 5,
  },
  topLeftContainer: {
    position: "absolute",
    top: 20,
    left: 10,
    height: 48,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    // 标题后面接弹幕信息条，按内容自然宽度排列
    zIndex: 20,
  },
  topBackButton: {
    padding: 5,
  },
  topTimeText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
    lineHeight: 48,
    marginRight: 8,
  },
  batteryPercentText: {
    color: "white",
    fontSize: 14,
    fontWeight: "bold",
    marginLeft: 4,
  },
  topRightContainer: {
    position: "absolute",
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    top: 20,
    right: 10,
    minHeight: 48,
  },
  castButton: {
    minWidth: 48,
    minHeight: 48,
    padding: 12,
    marginLeft: 4,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockContainer: {
    position: "absolute",
    left: 0,
    top: '50%',
    marginTop: -35,
    zIndex: 999,
  },
  lockBottomBarContainer: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    justifyContent: "space-between",
  },
});
