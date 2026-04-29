import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Pause, Play, SkipForward, List, Tv, ArrowDownToDot, ArrowUpFromDot, Gauge } from "lucide-react-native";
import { ThemedText } from "@/components/ThemedText";
import { MediaButton } from "@/components/MediaButton";
import { FontAwesome } from "@expo/vector-icons";

import usePlayerStore from "@/stores/playerStore";
import useDetailStore from "@/stores/detailStore";
import { useSources } from "@/stores/sourceStore";

interface PlayerControlsProps {
  showControls: boolean;
  setShowControls: (show: boolean) => void;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({ showControls, setShowControls }) => {
  const {
    currentEpisodeIndex,
    episodes,
    status,
    isSeeking,
    seekPosition,
    progressPosition,
    bufferedPosition,
    playbackRate,
    togglePlayPause,
    playEpisode,
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
  const hasNextEpisode = currentEpisodeIndex < (episodes.length || 0) - 1;

  const formatTime = (milliseconds: number) => {
    if (!milliseconds) return "00:00";
    const seconds = Math.floor(milliseconds / 1000);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (hours === 0) {
      // 不到一小时，格式为 00:00
      return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`;
    } else {
      // 超过一小时，格式为 00:00:00
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
  };

  const onPlayNextEpisode = () => {
    if (hasNextEpisode) {
      playEpisode(currentEpisodeIndex + 1);
    }
  };

  const durationMillis = status.durationMillis || 0;
  const seekPositionMillis = seekPosition * durationMillis;

  return (
    <View style={styles.controlsOverlay}>

      <View style={styles.bottomControlsContainer}>
        <View style={styles.progressBarContainer}>
          <View style={styles.progressBarBackground} />
          <View
            style={[
              styles.bufferedBarFilled,
              {
                width: `${bufferedPosition * 100}%`,
              },
            ]}
          />
          <View
            style={[
              styles.progressBarFilled,
              {
                width: `${(isSeeking ? seekPosition : progressPosition) * 100}%`,
              },
            ]}
          />
          <Pressable style={styles.progressBarTouchable} />
        </View>

        <ThemedText style={{ color: "white", marginTop: 5 }}>
          {status?.isLoaded
            ? `${formatTime(isSeeking ? seekPositionMillis : status.positionMillis)} / ${formatTime(status.durationMillis || 0)}`
            : "00:00 / 00:00"}
        </ThemedText>

        <View style={styles.bottomControls}>
          {episodes.length > 1 && (
            <MediaButton onPress={setIntroEndTime} timeLabel={introEndTime ? formatTime(introEndTime) : undefined}>
              <ArrowDownToDot color="white" size={24} />
            </MediaButton>
          )}

          <MediaButton onPress={togglePlayPause} hasTVPreferredFocus={showControls}>
            {status?.isLoaded && status.isPlaying ? (
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
            <MediaButton onPress={setOutroStartTime} timeLabel={outroStartTime ? formatTime(outroStartTime) : undefined}>
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

          <MediaButton onPress={() => setShowSpeedModal(true)} timeLabel={playbackRate !== 1.0 ? `${playbackRate}x` : undefined}>
            <Gauge color="white" size={24} />
          </MediaButton>

          <MediaButton onPress={toggleFavorite}>
            <FontAwesome
                name={isFavorited ? "heart" : "heart-o"}
                size={20}
                color={isFavorited ? "#feff5f" : "#ccc"}
              />
          </MediaButton>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  controlsOverlay: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    justifyContent: "space-between",
    padding: 20,
  },
  topControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  controlTitle: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
    flex: 1,
    textAlign: "center",
    marginHorizontal: 10,
  },
  bottomControlsContainer: {
    width: "100%",
    alignItems: "center",
  },
  bottomControls: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 15,
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
  controlButton: {
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  topRightContainer: {
    padding: 10,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 44, // Match TouchableOpacity default size for alignment
  },
  resolutionText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
});
