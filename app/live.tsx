import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, StyleSheet, ActivityIndicator, useTVEventHandler, HWEvent, Text, Image, Platform } from "react-native";
import { FlashList } from "@shopify/flash-list";
import LivePlayer from "@/components/LivePlayer";
import { fetchAndParseM3u, getPlayableUrl, Channel } from "@/services/m3u";
import { ThemedView } from "@/components/ThemedView";
import { StyledButton } from "@/components/StyledButton";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import * as ScreenOrientation from 'expo-screen-orientation';
import Modal from "react-native-modal";
import { Immersive } from 'react-native-immersive';

export default function LiveScreen() {
  const { m3uUrl, m3uUa } = useSettingsStore();
  
  // 处理屏幕旋转
  const setOrientation = async (fullscreen: boolean) => {
    if (fullscreen) {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    } else {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    }
  };

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  useEffect(() => {
    if(deviceType == 'mobile') {
      // 进入页面切换为横屏
      setOrientation(true);
      Immersive.on();
      return () => {
        // 退出页面时切换为坚屏
        setOrientation(false);
        Immersive.off();
      }
    }
    else if(!Platform.isTV) {
      Immersive.on();
      return () => {
        Immersive.off();
      }
    }
  }, []);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, Channel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");

  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isChannelListVisible, setIsChannelListVisible] = useState(false);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  const titleTimer = useRef<NodeJS.Timeout | null>(null);

  const selectedChannelUrl = channels.length > 0 ? getPlayableUrl(channels[currentChannelIndex].url) : null;

  useEffect(() => {
    const loadChannels = async () => {
      if (!m3uUrl) return;

      setIsLoading(true);
      const parsedChannels = await fetchAndParseM3u(m3uUrl);
      setChannels(parsedChannels);

      const groups: Record<string, Channel[]> = parsedChannels.reduce((acc, channel) => {
        const groupName = channel.group || "Other";
        if (!acc[groupName]) {
          acc[groupName] = [];
        }
        acc[groupName].push(channel);
        return acc;
      }, {} as Record<string, Channel[]>);

      const groupNames = Object.keys(groups);
      setGroupedChannels(groups);
      setChannelGroups(groupNames);
      setSelectedGroup(groupNames[0] || "");

      if (parsedChannels.length > 0) {
        showChannelTitle(parsedChannels[0].name);
      }
      setIsLoading(false);
    };
    loadChannels();
  }, [m3uUrl]);

  const showChannelTitle = (title: string) => {
    setChannelTitle(title);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => setChannelTitle(null), 3000);
  };

  const handleSelectChannel = (channel: Channel) => {
    const globalIndex = channels.findIndex((c) => c.id === channel.id);
    if (globalIndex !== -1) {
      setCurrentChannelIndex(globalIndex);
      showChannelTitle(channel.name);
      setIsChannelListVisible(false);
    }
  };

  const changeChannel = useCallback(
    (direction: "next" | "prev") => {
      if (channels.length === 0) return;
      let newIndex =
        direction === "next"
          ? (currentChannelIndex + 1) % channels.length
          : (currentChannelIndex - 1 + channels.length) % channels.length;
      setCurrentChannelIndex(newIndex);
      showChannelTitle(channels[newIndex].name);
    },
    [channels, currentChannelIndex]
  );

  const handleTVEvent = useCallback(
    (event: HWEvent) => {
      if (deviceType !== 'tv') return;
      if (isChannelListVisible) return;
      if (event.eventType === "select") setIsChannelListVisible(true);
      else if (event.eventType === "left" || event.eventType === "up") changeChannel("prev");
      else if (event.eventType === "right" || event.eventType === "down") changeChannel("next");
    },
    [changeChannel, isChannelListVisible, deviceType]
  );

  useTVEventHandler(deviceType === 'tv' ? handleTVEvent : () => {});

  // 优化的屏幕点击处理
  const onScreenPress = useCallback(() => {
    if (isChannelListVisible) return;
    setIsChannelListVisible(true);
  }, [isChannelListVisible]);

  // 处理屏幕手势
  const onScreenGesture = useCallback((direction: string) => {
    changeChannel(direction==='right'?'prev':'next')
  }, [changeChannel]);

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const onClose = () => {
    setIsChannelListVisible(false);
  };

  const renderLiveContent = () => (
    <>
      <LivePlayer 
        streamUrl={selectedChannelUrl}
        streamUa={m3uUa}
        channelTitle={channelTitle}
        onScreenPress={onScreenPress}
        onScreenGesture={onScreenGesture}
      />
      <Modal
        isVisible={isChannelListVisible} statusBarTranslucent={true} onBackButtonPress={onClose} onBackdropPress={onClose} onSwipeComplete={onClose} swipeDirection="down" style={dynamicStyles.modalContainer}
      >
        <View style={dynamicStyles.modalContent}>
          <Text style={dynamicStyles.modalTitle}>选择频道</Text>
          <View style={dynamicStyles.listContainer}>
            <View style={dynamicStyles.groupColumn}>
              <FlashList
                data={channelGroups}
                keyExtractor={(item, index) => `group-${item}-${index}`}
                extraData={selectedGroup}
                estimatedItemSize={76}
                renderItem={({ item }) => (
                  <StyledButton
                    text={item}
                    onPress={() => setSelectedGroup(item)}
                    isSelected={selectedGroup === item}
                    style={dynamicStyles.groupButton}
                    textStyle={dynamicStyles.groupButtonText}
                  />
                )}
              />
            </View>
            <View style={dynamicStyles.channelColumn}>
              {isLoading ? (
                <ActivityIndicator size="large" />
              ) : (
                <FlashList
                  data={groupedChannels[selectedGroup] || []}
                  keyExtractor={(item, index) => `${item.id}-${item.group}-${index}`}
                  extraData={channels[currentChannelIndex]?.id}
                  estimatedItemSize={65}
                  renderItem={({ item }) => (
                    <StyledButton
                      onPress={() => handleSelectChannel(item)}
                      isSelected={channels[currentChannelIndex]?.id === item.id}
                      hasTVPreferredFocus={channels[currentChannelIndex]?.id === item.id}
                      style={dynamicStyles.channelItem}
                    >
                      {item.logo && (<Image source={{ uri: item.logo }} style={dynamicStyles.channelLogo} />)}
                      <Text style={dynamicStyles.channelItemText}>
                        {item.name || "Unknown Channel"}
                      </Text>
                    </StyledButton>
                  )}
                />
              )}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderLiveContent()}
    </ThemedView>
  );

  return content;
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    modalContainer: {
      margin: 0,
      alignItems: "flex-end",
    },
    modalContent: {
      width: 450,
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
    },
    modalTitle: {
      color: "white",
      marginBottom: spacing / 2,
      textAlign: "center",
      fontSize: isMobile ? 18 : 16,
      fontWeight: "bold",
    },
    listContainer: {
      flex: 1,
      flexDirection: "row",
    },
    groupColumn: {
      flex: 1,
      marginRight: isMobile ? 0 : spacing / 2,
      marginBottom: isMobile ? spacing : 0,
    },
    channelColumn: {
      flex: 2,
    },
    groupButton: {
      paddingVertical: isMobile ? minTouchTarget / 4 : 8,
      paddingHorizontal: spacing / 2,
      marginVertical: isMobile ? 2 : 4,
    },
    groupButtonText: {
      fontSize: isMobile ? 14 : 13,
    },
    channelItem: {
      paddingVertical: isMobile ? minTouchTarget / 5 : 6,
      paddingHorizontal: spacing,
      marginVertical: isMobile ? 2 : 3,
      minHeight: isMobile ? minTouchTarget * 0.8 : undefined,
    },
    channelLogo: {
      width: 20,
      height: 20,
      borderRadius: 4,
      marginRight: 5,
      resizeMode: 'cover'
    },
    channelItemText: {
      fontSize: isMobile ? 14 : 12,
      color: '#ffffff',
    },
  });
};
