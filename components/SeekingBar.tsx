import React from "react";
import { View, StyleSheet, Text } from "react-native";
import usePlayerStore from "@/stores/playerStore";

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

export const SeekingBar = () => {
  const { isSeeking, seekPosition, progressPosition, bufferedPosition, status, playbackRate } = usePlayerStore();
  
  if (!((isSeeking && status?.isLoaded) || playbackRate != 1)) {
    return null;
  }

  const durationMillis = status.durationMillis || 0;
  const currentPositionMillis = seekPosition * durationMillis;

  return (
    <View style={styles.seekingContainer}>
      <Text style={styles.timeText}>
        {formatTime(isSeeking ? currentPositionMillis : status.positionMillis)} / {formatTime(durationMillis)}
      </Text>
      <View style={styles.seekingBarContainer}>
        <View style={styles.seekingBarBackground} />
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
            styles.seekingBarFilled,
            {
              width: `${(isSeeking ? seekPosition : progressPosition) * 100}%`,
            },
          ]}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  seekingContainer: {
    position: "absolute",
    bottom: 80,
    left: "5%",
    right: "5%",
    alignItems: "center",
  },
  timeText: {
    color: "white",
    fontSize: 18,
    fontWeight: "bold",
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: 10,
  },
  seekingBarContainer: {
    width: "100%",
    height: 5,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: 2.5,
  },
  seekingBarBackground: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: 2.5,
  },
  bufferedBarFilled: {
    position: "absolute",
    zIndex: 1,
    left: 0,
    height: "100%",
    backgroundColor: "rgba(255,255,255,0.5)",
    borderRadius: 2.5,
  },
  seekingBarFilled: {
    position: "absolute",
    zIndex: 2,
    left: 0,
    height: "100%",
    backgroundColor: "#00bb5e",
    borderRadius: 2.5,
  },
});
