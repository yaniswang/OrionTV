import React from "react";
import { View, Text, StyleSheet, Pressable, Platform } from "react-native";
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
  } = usePlayerStore();

  const { detail } = useDetailStore();
  const resources = useSources();

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
    <View style={styles.controlContainer}>
      <View style={styles.topLeftContainer}>
        {!Platform.isTV && !showLockControls && (
          <Pressable onPress={handelBack} style={styles.topBackButton}>
            <ChevronLeft color="white" size={26} />
          </Pressable>
        )}
        <Text style={styles.topTitleText}>{displayTitle}</Text>
        {detail?.useProxy && <Send color="#00bb5e" size={18} />}
      </View>

      <View style={styles.topCenterContainer} pointerEvents="none">
        <Text style={styles.topCenterTimeText}>{format(new Date(), 'HH:mm')}</Text>
      </View>

      <View style={styles.topRightContainer}>
        {!Platform.isTV && (
          <>
            {batteryPercent !== null && (
              <Text style={styles.batteryPercentText}>{batteryPercent}%</Text>
            )}
            <Battery
              percent={batteryPercent ?? 0}
              size={30}
              color={'#00bb5ea0'}
              charging={batteryState === BatteryState.CHARGING}
              outlined={false}
            />
          </>
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
              <Pressable style={styles.progressBarTouchable} />
            </View>

            <View style={styles.bottomControls}>
              {episodes.length > 1 && (
                <MediaButton onPress={onIntroPress} timeLabel={introEndTime ? formatTime(introEndTime) : undefined}>
                  <ArrowDownToDot color="white" size={24} />
                </MediaButton>
              )}

              <MediaButton onPress={() => void togglePlayPause()} hasTVPreferredFocus={showControls}>
                {status.isLoaded && status.isPlaying ? (
                  <Pause color="white" size={24} />
                ) : (
                  <Play color="white" size={24} />
                )}
              </MediaButton>

              {episodes.length > 1 && (
                <MediaButton onPress={onPlayNextEpisode} disabled={!hasNextEpisode}>
                  <SkipForward color={hasNextEpisode ? "white" : "#666"} size={24} />
                </MediaButton>
              )}

              {episodes.length > 1 && (
                <MediaButton onPress={onOutroPress} timeLabel={outroStartTime ? formatTime(outroStartTime) : undefined}>
                  <ArrowUpFromDot color="white" size={24} />
                </MediaButton>
              )}

              {episodes.length > 1 && (
                <MediaButton onPress={() => setShowEpisodeModal(true)}>
                  <List color="white" size={24} />
                </MediaButton>
              )}

              <MediaButton onPress={() => setShowSourceModal(true)}>
                <Tv color="white" size={24} />
              </MediaButton>

              <MediaButton
                onPress={() => setShowSpeedModal(true)}
                timeLabel={playbackRate !== 1.0 ? `${playbackRate}x` : undefined}
              >
                <Gauge color="white" size={24} />
              </MediaButton>

              <MediaButton onPress={toggleFavorite}>
                <Heart
                  size={24}
                  color={isFavorited ? "#feff5f" : "white"}
                  fill={isFavorited ? "#feff5f" : "transparent"}
                />
              </MediaButton>

              {isCasting && castIconAvailable && (
                <MediaButton onPress={onOpenDlnaDeviceModal}>
                  <MonitorSmartphone color="white" size={24} />
                </MediaButton>
              )}
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
            <Pressable style={styles.progressBarTouchable} />
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
  },
  topBackButton: {
    padding: 5,
  },
  topCenterContainer: {
    position: "absolute",
    top: 20,
    left: 0,
    right: 0,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  topCenterTimeText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
    lineHeight: 48,
  },
  batteryPercentText: {
    color: "white",
    fontSize: 14,
    fontWeight: "bold",
    marginRight: 4,
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
