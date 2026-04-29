import React, { useState, useEffect, useRef, forwardRef } from "react";
import { View, Text, Image, StyleSheet, TouchableOpacity, Animated } from "react-native";
import { useRouter } from "expo-router";
import { Star, Play } from "lucide-react-native";
import { API } from "@/services/api";
import { ThemedText } from "@/components/ThemedText";
import { Colors } from "@/constants/Colors";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { DeviceUtils } from "@/utils/DeviceUtils";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('VideoCardMobile');

interface VideoCardMobileProps extends React.ComponentProps<typeof TouchableOpacity> {
  id?: string;
  source?: string;
  q?: string;
  title: string;
  poster: string;
  year?: string;
  rate?: string;
  sourceName?: string;
  sourceCount?: number;
  progress?: number;
  playTime?: number;
  episodeIndex?: number;
  totalEpisodes?: number;
  onFocus?: () => void;
  onLongPress?: (title: string, source: string, id: string) => void;
  api: API;
  stype?: string | null;
}

const VideoCardMobile = forwardRef<View, VideoCardMobileProps>(
  (
    {
      id,
      source,
      q,
      title,
      poster,
      year,
      rate,
      sourceName,
      sourceCount,
      progress,
      episodeIndex,
      totalEpisodes,
      onFocus,
      onLongPress,
      api,
      playTime = 0,
      stype,
    }: VideoCardMobileProps,
    ref
  ) => {
    const router = useRouter();
    const { cardWidth, cardHeight, spacing } = useResponsiveLayout();
    const [fadeAnim] = useState(new Animated.Value(0));

    const longPressTriggered = useRef(false);

    const handlePress = () => {
      if (longPressTriggered.current) {
        longPressTriggered.current = false;
        return;
      }

      const videoStype = stype || (totalEpisodes !== undefined ? (totalEpisodes > 1 ? 'tv' : 'movie') : null);

      if (progress !== undefined && episodeIndex !== undefined) {
        router.push({
          pathname: "/play",
          params: { source, id, episodeIndex: episodeIndex - 1, q, title, year, stype: videoStype, position: playTime * 1000 },
        });
      } else {
        router.push({
          pathname: "/detail",
          params: { source, id, q, title, year, stype: videoStype },
        });
      }
    };

    useEffect(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: DeviceUtils.getAnimationDuration(300),
        delay: Math.random() * 100,
        useNativeDriver: true,
      }).start();
    }, [fadeAnim]);

    const handleLongPress = () => {
      longPressTriggered.current = true;
      onLongPress?.(title, source, id);
    };

    const isContinueWatching = progress !== undefined && progress > 0 && progress < 1;

    const styles = createMobileStyles(cardWidth, cardHeight, spacing);
    
    return (
      <Animated.View style={[styles.wrapper, { opacity: fadeAnim }]} ref={ref}>
        <TouchableOpacity
          onPress={handlePress}
          onLongPress={handleLongPress}
          style={styles.pressable}
          activeOpacity={0.8}
          delayLongPress={800}
        >
          <View style={styles.card}>
            <Image source={{ uri: api.getImageProxyUrl(poster) }} style={styles.poster} />
            
            {/* 进度条 */}
            {isContinueWatching && (
              <View style={styles.progressContainer}>
                <View style={[styles.progressBar, { width: `${(progress || 0) * 100}%` }]} />
              </View>
            )}

            {/* 评分 */}
            {rate && (
              <View style={styles.ratingContainer}>
                <Star size={10} color="#FFD700" fill="#FFD700" />
                <Text style={styles.ratingText}>{rate}</Text>
              </View>
            )}

            {/* 年份 */}
            {year && (
              <View style={styles.yearBadge}>
                <Text style={styles.badgeText}>{year}</Text>
              </View>
            )}

            {/* 来源 */}
            {sourceName && (
              <View style={styles.sourceNameBadge}>
                <Text style={styles.badgeText}>{sourceName}</Text>
              </View>
            )}
            {sourceCount && (
              <View style={styles.sourceNameBadge}>
                <Text style={styles.badgeText}>源:{sourceCount}</Text>
              </View>
            )}
            {(totalEpisodes && totalEpisodes>1) && (
              <View style={styles.episodesInfoBadge}>
                <Text style={styles.badgeText}>{episodeIndex?episodeIndex+'/':null}{totalEpisodes}</Text>
              </View>
            )}
          </View>

          <View style={styles.infoContainer}>
            <ThemedText numberOfLines={2} style={styles.title}>{title}</ThemedText>
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  }
);

VideoCardMobile.displayName = "VideoCardMobile";

const createMobileStyles = (cardWidth: number, cardHeight: number, spacing: number) => {
  return StyleSheet.create({
    wrapper: {
      width: cardWidth,
      marginBottom: spacing,
    },
    pressable: {
      alignItems: 'flex-start',
    },
    card: {
      width: cardWidth,
      height: cardHeight,
      borderRadius: 8,
      backgroundColor: "#222",
      overflow: "hidden",
    },
    poster: {
      width: "100%",
      height: "100%",
      resizeMode: 'cover',
    },
    progressContainer: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: 3,
      backgroundColor: "rgba(0, 0, 0, 0.6)",
    },
    progressBar: {
      height: 3,
      backgroundColor: Colors.dark.primary,
    },
    continueWatchingBadge: {
      position: 'absolute',
      top: 6,
      left: 6,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: Colors.dark.primary,
      paddingHorizontal: 6,
      paddingVertical: 3,
      borderRadius: 4,
    },
    continueWatchingText: {
      color: "white",
      marginLeft: 3,
      fontSize: 10,
      fontWeight: "bold",
    },
    ratingContainer: {
      position: "absolute",
      top: 6,
      right: 6,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "rgba(0, 0, 0, 0.7)",
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    ratingText: {
      color: "#FFD700",
      fontSize: 10,
      fontWeight: "bold",
      marginLeft: 2,
    },
    yearBadge: {
      position: "absolute",
      top: 6,
      left: 6,
      backgroundColor: "rgba(0, 0, 0, 0.7)",
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    sourceNameBadge: {
      position: "absolute",
      top: 6,
      right: 6,
      backgroundColor: "rgba(0, 0, 0, 0.7)",
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    episodesInfoBadge: {
      position: "absolute",
      right: 8,
      bottom: 8,
      backgroundColor: "rgba(34, 197, 94, 0.7)",
      borderRadius: 6,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    badgeText: {
      color: "white",
      fontSize: 9,
      fontWeight: "500",
    },
    infoContainer: {
      width: cardWidth,
      marginTop: 6,
      paddingHorizontal: 2,
    },
    title: {
      fontSize: 13,
      lineHeight: 16,
      marginBottom: 2,
    },
    continueLabel: {
      color: Colors.dark.primary,
      fontSize: 11,
    },
  });
};

export default VideoCardMobile;