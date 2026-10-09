import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, StyleSheet, ActivityIndicator, useTVEventHandler, HWEvent, Text, Image, Platform, Pressable, BackHandler } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Cast, ChevronLeft, MonitorSmartphone, Power } from "lucide-react-native";
import { useRouter } from "expo-router";
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
import { Immersive } from 'react-native-immersive';
import useDlnaStore from "@/stores/dlnaStore";
import { DLNAStatusPanel } from "@/components/DLNAStatusPanel";
import { DLNADeviceModal } from "@/components/DLNADeviceModal";
import Toast from "@/utils/Toast";
import { useKeepAwake } from "expo-keep-awake";

// 投屏入口只在手机和平板出现
const castAvailable = !Platform.isTV && (Platform.OS === 'android' || Platform.OS === 'ios');
const CAST_BUTTON_SIZE = 48;

export default function LiveScreen() {
  const { m3uUrl, m3uUa } = useSettingsStore();
  const router = useRouter();
  // 投屏时本机播放器已卸载，页面层保持常亮（与剧集页一致）
  useKeepAwake();
  
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

  const currentRowRef = useRef<View>(null);
  const channelListRef = useRef<FlashList<Channel>>(null);
  const groupListRef = useRef<FlashList<string>>(null);

  const selectedChannelUrl = channels.length > 0 ? getPlayableUrl(channels[currentChannelIndex].url) : null;
  const currentChannelName = channels[currentChannelIndex]?.name ?? '';

  const isCasting = useDlnaStore((state) => state.enabled);
  const dlnaPhase = useDlnaStore((state) => state.phase);
  const [showDlnaDeviceModal, setShowDlnaDeviceModal] = useState(false);
  const autoOpenedDlnaDeviceModalRef = useRef(false);

  // 与剧集页一致：搜索结束且没有自动连上设备时，自动弹出设备列表
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

  // 投屏连上后、以及投屏中换台时，把当前频道推给电视；同一地址不会重复下发
  const castConnected = isCasting && dlnaPhase === 'connected';
  useEffect(() => {
    if (!castConnected || !selectedChannelUrl) return;
    void useDlnaStore.getState().castLiveChannel({ url: selectedChannelUrl, title: currentChannelName, userAgent: m3uUa });
  }, [castConnected, selectedChannelUrl]);

  // 离开直播页时结束投屏
  useEffect(() => {
    return () => {
      if (useDlnaStore.getState().enabled) {
        void useDlnaStore.getState().disableCast({ restoreLocal: false, stopRemote: true });
      }
    };
  }, []);

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
    if (useDlnaStore.getState().enabled) {
      Toast.show({ type: 'info', text1: `电视已切换到 ${title}` });
    }
    setChannelTitle(title);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => setChannelTitle(null), 3000);
  };

  const handleSelectChannel = (channel: Channel) => {
    // 分组里的频道与 channels 是同一个对象；按对象定位，避免同一地址出现在多个分组时定位到第一个
    const globalIndex = channels.indexOf(channel);
    if (globalIndex !== -1) {
      setCurrentChannelIndex(globalIndex);
      showChannelTitle(channel.name);
      setIsChannelListVisible(false);
    }
  };

  // 每次打开频道列表都切到当前频道所在分组（换台、浏览其它分组后也能定位回当前频道）
  const openChannelList = useCallback(() => {
    const current = channels[currentChannelIndex];
    if (current) setSelectedGroup(current.group || "Other");
    setIsChannelListVisible(true);
  }, [channels, currentChannelIndex]);

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
      if (!Platform.isTV) return;
      if (isChannelListVisible) return;
      if (event.eventType === "select") openChannelList();
      else if (event.eventType === "left" || event.eventType === "up") changeChannel("prev");
      else if (event.eventType === "right" || event.eventType === "down") changeChannel("next");
    },
    [changeChannel, isChannelListVisible, openChannelList]
  );

  useTVEventHandler(Platform.isTV ? handleTVEvent : () => {});

  // 优化的屏幕点击处理
  const onScreenPress = useCallback(() => {
    if (isChannelListVisible) return;
    openChannelList();
  }, [isChannelListVisible, openChannelList]);

  // 处理屏幕手势
  const onScreenGesture = useCallback((direction: string) => {
    changeChannel(direction==='right'?'prev':'next')
  }, [changeChannel]);

  const toggleCast = () => {
    setIsChannelListVisible(false);
    const dlna = useDlnaStore.getState();
    if (dlna.enabled) {
      void dlna.disableCast({ restoreLocal: false, stopRemote: true });
      return;
    }
    if (!selectedChannelUrl) {
      Toast.show({ type: 'error', text1: '当前没有可投屏的频道' });
      return;
    }
    void dlna.enableLiveCast({ url: selectedChannelUrl, title: currentChannelName, userAgent: m3uUa });
  };

  const openDeviceModal = () => {
    setIsChannelListVisible(false);
    setShowDlnaDeviceModal(true);
  };

  // 投屏时的画面手势：单击打开频道列表，左右滑动换台（与本机播放一致）
  const castGesture = Gesture.Race(
    Gesture.Pan()
      .runOnJS(true)
      .onFinalize((e) => {
        if (Math.abs(e.translationX) > 50) onScreenGesture(e.translationX < 0 ? 'left' : 'right');
      }),
    Gesture.Tap()
      .numberOfTaps(1)
      .runOnJS(true)
      .onEnd(() => onScreenPress()),
  );

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const onClose = () => {
    setIsChannelListVisible(false);
  };
  
  // 列表每次打开都会重新挂载，等列表首次绘制完成（onLoad）后再定位到当前分组和频道
  const currentChannel = channels[currentChannelIndex];
  const groupIndex = channelGroups.indexOf(selectedGroup);
  const indexInGroup = currentChannel ? (groupedChannels[selectedGroup] || []).indexOf(currentChannel) : -1;

  // 列表打开时，返回键先关闭列表
  useEffect(() => {
    if (!isChannelListVisible) return;
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      setIsChannelListVisible(false);
      return true;
    });
    return () => backHandler.remove();
  }, [isChannelListVisible]);
  const renderLiveContent = () => (
    <>
      {/* 投屏时卸载本机播放器，主画面显示投屏状态 */}
      {isCasting ? (
        <GestureHandlerRootView style={{ flex: 1 }}>
          <GestureDetector gesture={castGesture}>
            <View style={{ flex: 1 }} collapsable={false}>
              <DLNAStatusPanel liveTitle={currentChannelName} />
            </View>
          </GestureDetector>
        </GestureHandlerRootView>
      ) : (
        <LivePlayer
          streamUrl={selectedChannelUrl}
          streamUa={m3uUa}
          channelTitle={channelTitle}
          onScreenPress={onScreenPress}
          onScreenGesture={onScreenGesture}
        />
      )}
      {/* 频道列表直接画在页面内（与剧集页控制栏一致），独立弹窗窗口会露出系统状态栏 */}
      {isChannelListVisible && (
      <View style={dynamicStyles.modalContainer}>
        <Pressable style={dynamicStyles.backdrop} onPress={onClose} />
        <View style={dynamicStyles.modalContent}>
          <View style={dynamicStyles.modalTitleRow}>
            <Text style={dynamicStyles.modalTitle}>选择频道</Text>
            {/* 与剧集页一致：返回按钮只在手机和平板显示，电视用遥控器返回键；
                放在标题之后渲染，否则整行宽的标题会盖住按钮、吃掉点击 */}
            {!Platform.isTV && (
              <Pressable onPress={() => router.back()} style={dynamicStyles.backButton}>
                <ChevronLeft color="white" size={26} />
              </Pressable>
            )}
          </View>
          <View style={dynamicStyles.listContainer}>
            <View style={dynamicStyles.groupColumn}>
              <FlashList
                ref={groupListRef}
                onLoad={() => {
                  if (groupIndex >= 0) groupListRef.current?.scrollToIndex({ index: groupIndex, animated: false });
                }}
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
                  ref={channelListRef}
                  initialScrollIndex={indexInGroup >= 0 ? indexInGroup : undefined}
                  onLoad={() => {
                    if (indexInGroup < 0) return;
                    channelListRef.current?.scrollToIndex({ index: indexInGroup, animated: false });
                    // 电视：定位完成后再把焦点交给当前频道。不用 hasTVPreferredFocus——列表回收重建视图时它会反复抢焦点，
                    // 抢焦点那一刻视图位置还没更新，列表会被拉到错误位置；手机上抢焦点则会让列表滚回顶部
                    if (Platform.isTV) setTimeout(() => currentRowRef.current?.requestTVFocus(), 100);
                  }}
                  data={groupedChannels[selectedGroup] || []}
                  keyExtractor={(item, index) => `${item.id}-${item.group}-${index}`}
                  extraData={currentChannelIndex}
                  drawDistance={2000}
                  estimatedItemSize={61}
                  renderItem={({ item }) => (
                    <StyledButton
                      onPress={() => handleSelectChannel(item)}
                      isSelected={channels[currentChannelIndex] === item}
                      ref={channels[currentChannelIndex] === item ? currentRowRef : undefined}
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
        {castAvailable && (
          <View style={dynamicStyles.castActions}>
            {isCasting && (
              <Pressable onPress={openDeviceModal} style={dynamicStyles.castButton}>
                <MonitorSmartphone color="white" size={24} />
              </Pressable>
            )}
            <Pressable onPress={toggleCast} style={dynamicStyles.castButton}>
              {isCasting ? <Power color="white" size={24} /> : <Cast color="white" size={24} />}
            </Pressable>
          </View>
        )}
      </View>
      )}
      {castAvailable && (
        <DLNADeviceModal
          visible={isCasting && showDlnaDeviceModal}
          onClose={() => setShowDlnaDeviceModal(false)}
        />
      )}
    </>
  );

  const content = (
    // 与剧集页一致：根视图可聚焦，进入页面就有焦点，遥控器中键才能直接生效
    <ThemedView focusable style={[commonStyles.container, dynamicStyles.container]}>
      {renderLiveContent()}
    </ThemedView>
  );

  return content;
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    modalContainer: {
      ...StyleSheet.absoluteFillObject,
      // 频道列表统一放左边（手机和平板右上角留给投屏按钮）
      alignItems: "flex-start",
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0, 0, 0, 0.7)",
    },
    modalContent: {
      width: 450,
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
    },
    modalTitleRow: {
      // 与剧集页顶部栏一致（top: 20）
      marginTop: 20,
      height: 48,
      marginBottom: spacing / 2,
      justifyContent: "center",
    },
    backButton: {
      position: "absolute",
      left: 10,
      height: 48,
      padding: 5,
      justifyContent: "center",
    },
    modalTitle: {
      color: "white",
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
    castActions: {
      position: "absolute",
      top: 20,
      right: 10,
      flexDirection: "row",
      alignItems: "center",
    },
    castButton: {
      minWidth: CAST_BUTTON_SIZE,
      minHeight: CAST_BUTTON_SIZE,
      padding: 12,
      marginLeft: 4,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
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
