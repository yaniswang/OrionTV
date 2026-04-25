import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Image, ScrollView, ActivityIndicator, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StyledButton } from "@/components/StyledButton";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import useDetailStore from "@/stores/detailStore";
import { FontAwesome } from "@expo/vector-icons";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";

export default function DetailScreen() {
  const { source, id, q, year, stype } = useLocalSearchParams<{ source: string; id: string; q: string; year: string, stype: string }>();
  const router = useRouter();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  const [selectedTab, setSelectedTab] = useState<string>('episodes');

  const {
    detail,
    searchResults,
    loading,
    error,
    allSourcesLoaded,
    init,
    setDetail,
    abort,
    isFavorited,
    toggleFavorite,
  } = useDetailStore();

  useEffect(() => {
    if (q) {
      init(q, year, stype, source, id);
    }
    return () => {
      abort();
    };
  }, [abort, init, q, year, stype, source, id]);

  const handlePlay = (episodeIndex: number) => {
    if (!detail) return;
    // abort(); // Cancel any ongoing fetches
    router.push({
      pathname: "/play",
      params: {
        // Pass necessary identifiers, the rest will be in the store
        title: detail.title,
        year,
        stype,
        source: detail.source,
        id: detail.id.toString(),
        episodeIndex: episodeIndex.toString(),
      },
    });
  };

  if (loading) {
    return <VideoLoadingAnimation showProgressBar={false} />;
  }

  if (error) {
    const content = (
      <ThemedView style={[commonStyles.safeContainer, commonStyles.center]}>
        <ThemedText type="subtitle" style={commonStyles.textMedium}>
          {error}
        </ThemedText>
      </ThemedView>
    );

    if (deviceType === 'tv') {
      return content;
    }

    return (
      <ResponsiveNavigation>
        <ResponsiveHeader title="详情" showBackButton />
        {content}
      </ResponsiveNavigation>
    );
  }

  if (!detail) {
    const content = (
      <ThemedView style={[commonStyles.safeContainer, commonStyles.center]}>
        <ThemedText type="subtitle">未找到详情信息</ThemedText>
      </ThemedView>
    );

    if (deviceType === 'tv') {
      return content;
    }

    return (
      <ResponsiveNavigation>
        <ResponsiveHeader title="详情" showBackButton />
        {content}
      </ResponsiveNavigation>
    );
  }

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderDetailContent = () => {
    if (deviceType === 'mobile') {
      // 移动端垂直布局
      return (
        <ScrollView style={dynamicStyles.scrollContainer}>
          {/* 海报和基本信息 */}
          <View style={dynamicStyles.mobileTopContainer}>
            <Image source={{ uri: detail.poster }} style={dynamicStyles.mobilePoster} />
            <View style={dynamicStyles.mobileInfoContainer}>
              <View style={dynamicStyles.titleContainer}>
                <ThemedText style={dynamicStyles.title} numberOfLines={2}>
                  {detail.title}
                </ThemedText>
                <StyledButton onPress={toggleFavorite} variant="ghost" style={dynamicStyles.favoriteButton}>
                  <FontAwesome
                    name={isFavorited ? "heart" : "heart-o"}
                    size={20}
                    color={isFavorited ? "#feff5f" : "#ccc"}
                  />
                </StyledButton>
              </View>
              <View style={dynamicStyles.metaContainer}>
                <ThemedText style={dynamicStyles.metaText}>{detail.year}</ThemedText>
                <ThemedText style={dynamicStyles.metaText}>{detail.type_name}</ThemedText>
              </View>
            </View>
          </View>

          {/* 描述 */}
          <View style={dynamicStyles.descriptionContainer}>
            <ThemedText style={dynamicStyles.description}>{detail.desc}</ThemedText>
          </View>

          {/* Tabs切换 */}
          <View style={dynamicStyles.tabButtonContainer}>
            <StyledButton
              text={'选集'}
              onPress={() => setSelectedTab('episodes')}
              isSelected={selectedTab==='episodes'}
              style={dynamicStyles.tabButton}
              textStyle={dynamicStyles.tabButtonText}
            />
            <StyledButton
              text={`换源 (${searchResults.length})`}
              onPress={() => setSelectedTab('sources')}
              isSelected={selectedTab==='sources'}
              style={dynamicStyles.tabButton}
              textStyle={dynamicStyles.tabButtonText}
              isLoading={!allSourcesLoaded }
            />
          </View>

          {/* 剧集列表 */}
          {selectedTab === 'episodes' && (
            <View style={dynamicStyles.episodesContainer}>
              <View style={dynamicStyles.episodeList}>
                {detail.episodes.map((episode, index) => (
                  <StyledButton
                    key={index}
                    style={dynamicStyles.episodeButton}
                    onPress={() => handlePlay(index)}
                    text={`第 ${index + 1} 集`}
                    textStyle={dynamicStyles.episodeButtonText}
                  />
                ))}
              </View>
            </View>
          )}

          {/* 播放源 */}
          {selectedTab === 'sources' && (
            <View style={dynamicStyles.sourcesContainer}>
              <View style={dynamicStyles.sourceList}>
                {searchResults.map((item, index) => {
                  const isSelected = detail?.source === item.source;
                  return (
                    <StyledButton
                      key={index}
                      onPress={() => setDetail(item)}
                      isSelected={isSelected}
                      style={dynamicStyles.sourceButton}
                    >
                      <ThemedText style={dynamicStyles.sourceButtonText}>{item.source_name}</ThemedText>
                      {item.episodes.length > 1 && (
                        <View style={[dynamicStyles.badge, isSelected && dynamicStyles.selectedBadge]}>
                          <Text style={dynamicStyles.badgeText}>
                            {`${item.episodes.length}`} 集
                          </Text>
                        </View>
                      )}
                      {/* {item.resolution && (
                        <View style={[dynamicStyles.badge, { backgroundColor: "#666" }, isSelected && dynamicStyles.selectedBadge]}>
                          <Text style={dynamicStyles.badgeText}>{item.resolution}</Text>
                        </View>
                      )} */}
                    </StyledButton>
                  );
                })}
              </View>
            </View>
          )}
        </ScrollView>
      );
    } else {
      // 平板和TV端水平布局
      return (
        <ScrollView style={dynamicStyles.scrollContainer}>
          <View style={dynamicStyles.topContainer}>
            <Image source={{ uri: detail.poster }} style={dynamicStyles.poster} />
            <View style={dynamicStyles.infoContainer}>
              <View style={dynamicStyles.titleContainer}>
                <ThemedText style={dynamicStyles.title} numberOfLines={1} ellipsizeMode="tail">
                  {detail.title}
                </ThemedText>
                <StyledButton onPress={toggleFavorite} variant="ghost" style={dynamicStyles.favoriteButton}>
                  <FontAwesome
                    name={isFavorited ? "heart" : "heart-o"}
                    size={24}
                    color={isFavorited ? "#feff5f" : "#ccc"}
                  />
                </StyledButton>
              </View>
              <View style={dynamicStyles.metaContainer}>
                <ThemedText style={dynamicStyles.metaText}>{detail.year}</ThemedText>
                <ThemedText style={dynamicStyles.metaText}>{detail.type_name}</ThemedText>
              </View>

              <ScrollView style={dynamicStyles.descriptionScrollView}>
                <ThemedText style={dynamicStyles.description}>{detail.desc}</ThemedText>
              </ScrollView>
            </View>
          </View>

          <View style={dynamicStyles.bottomContainer}>
            {/* Tabs切换 */}
            <View style={dynamicStyles.tabButtonContainer}>
              <StyledButton
                text={'选集'}
                onPress={() => setSelectedTab('episodes')}
                isSelected={selectedTab==='episodes'}
                style={dynamicStyles.tabButton}
                textStyle={dynamicStyles.tabButtonText}
              />
              <StyledButton
                text={`换源 (${searchResults.length})`}
                onPress={() => setSelectedTab('sources')}
                isSelected={selectedTab==='sources'}
                style={dynamicStyles.tabButton}
                textStyle={dynamicStyles.tabButtonText}
                isLoading={!allSourcesLoaded }
              />
            </View>
            {selectedTab === 'episodes' && (
              <View style={dynamicStyles.episodesContainer}>
                <ScrollView contentContainerStyle={dynamicStyles.episodeList}>
                  {detail.episodes.map((episode, index) => (
                    <StyledButton
                      key={index}
                      hasTVPreferredFocus={Platform.isTV && index === 0}
                      style={dynamicStyles.episodeButton}
                      onPress={() => handlePlay(index)}
                      text={`第 ${index + 1} 集`}
                      textStyle={dynamicStyles.episodeButtonText}
                    />
                  ))}
                </ScrollView>
              </View>
            )}
            {selectedTab === 'sources' && (
              <View style={dynamicStyles.sourcesContainer}>
                <View style={dynamicStyles.sourceList}>
                  {searchResults.map((item, index) => {
                    const isSelected = detail?.source === item.source;
                    return (
                      <StyledButton
                        key={index}
                        onPress={() => setDetail(item)}
                        hasTVPreferredFocus={index === 0}
                        isSelected={isSelected}
                        style={dynamicStyles.sourceButton}
                      >
                        <ThemedText style={dynamicStyles.sourceButtonText}>{item.source_name}</ThemedText>
                        {item.episodes.length > 1 && (
                          <View style={[dynamicStyles.badge, isSelected && dynamicStyles.selectedBadge]}>
                            <Text style={dynamicStyles.badgeText}>
                              {`${item.episodes.length}`} 集
                            </Text>
                          </View>
                        )}
                        {/* {item.resolution && (
                          <View style={[dynamicStyles.badge, { backgroundColor: "#666" }, isSelected && dynamicStyles.selectedBadge]}>
                            <Text style={dynamicStyles.badgeText}>{item.resolution}</Text>
                          </View>
                        )} */}
                      </StyledButton>
                    );
                  })}
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      );
    }
  };

  const content = (
    <ThemedView style={[commonStyles.container, { paddingTop: deviceType === 'tv' ? 40 : 0 }]}>
      {renderDetailContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title={detail?.title || "详情"} showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isTV = deviceType === 'tv';
  const isTablet = deviceType === 'tablet';
  const isMobile = deviceType === 'mobile';

  return StyleSheet.create({
    scrollContainer: {
      flex: 1,
    },
    
    // 移动端专用样式
    mobileTopContainer: {
      paddingHorizontal: spacing,
      paddingTop: spacing,
      paddingBottom: spacing / 2,
    },
    mobilePoster: {
      width: '100%',
      height: 280,
      borderRadius: 8,
      alignSelf: 'center',
      marginBottom: spacing,
    },
    mobileInfoContainer: {
      flex: 1,
    },
    descriptionContainer: {
      paddingHorizontal: spacing,
      paddingBottom: spacing,
    },

    // 平板和TV端样式
    topContainer: {
      flexDirection: "row",
      padding: spacing,
    },
    poster: {
      width: isTV ? 200 : 160,
      height: isTV ? 300 : 240,
      borderRadius: 8,
    },
    infoContainer: {
      flex: 1,
      marginLeft: spacing,
      justifyContent: "flex-start",
    },
    descriptionScrollView: {
      height: 150,
    },

    // 通用样式
    titleContainer: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: spacing / 2,
    },
    title: {
      paddingTop: 16,
      fontSize: isMobile ? 20 : isTablet ? 24 : 28,
      fontWeight: "bold",
      flexShrink: 1,
      color: 'white',
    },
    favoriteButton: {
      padding: 10,
      marginLeft: 10,
      backgroundColor: "transparent",
    },
    metaContainer: {
      flexDirection: "row",
      marginBottom: spacing / 2,
    },
    metaText: {
      color: "#aaa",
      marginRight: spacing / 2,
      fontSize: isMobile ? 12 : 14,
    },
    description: {
      fontSize: isMobile ? 13 : 14,
      color: "#ccc",
      lineHeight: isMobile ? 18 : 22,
    },

    tabButtonContainer: {
      flexDirection: "row",
      alignItems: "center",
    },
    tabButton: {
      margin: isMobile ? 4 : 8,
      minHeight: isMobile ? 36 : 44,
      paddingHorizontal: spacing,
    },
    tabButtonText:  {
      color: "white",
      fontSize: isMobile ? 14 : 16,
    },

    // 播放源和剧集样式
    bottomContainer: {
      paddingHorizontal: spacing,
    },
    sourcesContainer: {
      marginTop: spacing,
    },
    sourcesTitleContainer: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: spacing / 2,
    },
    sourcesTitle: {
      fontSize: isMobile ? 16 : isTablet ? 18 : 20,
      fontWeight: "bold",
      color: 'white',
    },
    sourceList: {
      flexDirection: "row",
      flexWrap: "wrap",
    },
    sourceButton: {
      margin: isMobile ? 4 : 8,
      minHeight: isMobile ? 36 : 44,
    },
    sourceButtonText: {
      color: "white",
      fontSize: isMobile ? 14 : 16,
    },
    badge: {
      backgroundColor: "#666",
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 2,
      marginLeft: 8,
    },
    badgeText: {
      color: "#fff",
      fontSize: isMobile ? 10 : 12,
      fontWeight: "bold",
      paddingBottom: 2.5,
    },
    selectedBadge: {
      backgroundColor: "#4c4c4c",
    },

    episodesContainer: {
      marginTop: spacing,
      paddingBottom: spacing * 2,
    },
    episodesTitle: {
      fontSize: isMobile ? 16 : isTablet ? 18 : 20,
      fontWeight: "bold",
      marginBottom: spacing / 2,
      color: 'white',
    },
    episodeList: {
      flexDirection: "row",
      flexWrap: "wrap",
    },
    episodeButton: {
      margin: isMobile ? 3 : 5,
      minHeight: isMobile ? 32 : 36,
    },
    episodeButtonText: {
      color: "white",
      fontSize: isMobile ? 12 : 14,
    },
  });
};
