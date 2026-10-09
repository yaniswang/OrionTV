import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import { ThemedText } from "@/components/ThemedText";
import useDetailStore, { EXCELLENT_SEGMENT_RATIO, SearchResultWithResolution } from "@/stores/detailStore";
import usePlayerStore from "@/stores/playerStore";
import Logger from '@/utils/Logger';
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import { FontAwesome } from "@expo/vector-icons";
import { SpeedTestIcon } from "./SpeedTestIcon";
import { usePlaybackController } from "@/hooks/usePlaybackController";

const logger = Logger.withTag('SourceSelectionModal');

export const SourceSelectionModal: React.FC = () => {
  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);
  
  // 只订阅需要的字段：播放进度每 500ms 更新一次，整店订阅会让这个弹窗跟着每秒重渲染两次
  const showSourceModal = usePlayerStore((s) => s.showSourceModal);
  const setShowSourceModal = usePlayerStore((s) => s.setShowSourceModal);
  const searchResults = useDetailStore((s) => s.searchResults);
  const detail = useDetailStore((s) => s.detail);
  const allSourcesLoaded = useDetailStore((s) => s.allSourcesLoaded);
  const testingSource = useDetailStore((s) => s.testingSource);
  const { selectSource } = usePlaybackController();

  // 按源（而不是列表下标）选择：测速过程中列表会随时按倍率重排，用下标会点错源
  const onSelectSource = async (item: SearchResultWithResolution) => {
    logger.debug("onSelectSource", item.source, item.id, detail?.id);
    await selectSource(item);
    setShowSourceModal(false);
  };

  const onClose = () => {
    setShowSourceModal(false);
  };

  return (
    <Modal isVisible={showSourceModal} statusBarTranslucent={true} onBackButtonPress={onClose} onBackdropPress={onClose} onSwipeComplete={onClose} swipeDirection="down" style={styles.modalContainer}>
      <View style={styles.modalContent}>
        <View style={styles.modalTitleContainer}>
          {!allSourcesLoaded && (<ActivityIndicator style={{marginRight: 5}} />)}
          <Text style={styles.modalTitle}>换源 ({searchResults.length})</Text>
        </View>
        <FlashList
          data={searchResults}
          numColumns={Math.floor((responsiveConfig.screenWidth * 0.9) / 250)}
          // 列表会随测速结果重排，key 必须跟着源走（不同源可能有相同的 id）
          keyExtractor={(item) => `${item.source}-${item.id}`}
          extraData={detail?.id}
          estimatedItemSize={60}
          renderItem={({ item }) => {
            const isSelected = detail?.source === item.source && detail?.id === item.id;
            return (
              <StyledButton
                onPress={() => onSelectSource(item)}
                isSelected={isSelected}
                hasTVPreferredFocus={isSelected}
                style={styles.sourceItem}
                textStyle={dynamicStyles.sourceButton}
              >
                  <ThemedText style={dynamicStyles.sourceButtonText}>{item.source_name}</ThemedText>
                  {item.episodes.length > 1 && (
                    <View style={[dynamicStyles.badge, isSelected && dynamicStyles.selectedBadge]}>
                      <Text style={dynamicStyles.badgeText}>
                        {`${item.episodes.length}`} 集
                      </Text>
                    </View>
                  )}
                  {/* 分片时长 / 加载耗时 ≥ 阈值：下载比播放快，够流畅 */}
                  {!!item.segmentRatio && item.segmentRatio >= EXCELLENT_SEGMENT_RATIO && (
                    <View style={[dynamicStyles.badge, dynamicStyles.excellentBadge]}>
                      <FontAwesome name="bolt" size={deviceType === "mobile" ? 10 : 12} color="#08331a" />
                      <Text style={[dynamicStyles.badgeText, dynamicStyles.excellentBadgeText]}>优</Text>
                    </View>
                  )}
                  {/* 测速中的图标放整行最后（集数、优 的后面） */}
                  {testingSource === item.source && <SpeedTestIcon size={deviceType === "mobile" ? 12 : 14} />}
              </StyledButton>
            );
          }}
        />
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    margin: 0,
    alignItems: "flex-end",
  },
  modalContent: {
    width: '90%',
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    padding: 20,
  },
  modalTitleContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    color: "white",
    textAlign: "center",
    fontSize: 18,
    fontWeight: "bold",
  },
  sourceItem: {
    flex: 1,
    paddingVertical: 2,
    margin: 4,
    marginLeft: 10,
    marginRight: 8,
  },
  sourceItemText: {
    fontSize: 14,
  },
});

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isTV = deviceType === 'tv';
  const isMobile = deviceType === 'mobile';

  return StyleSheet.create({
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
    excellentBadge: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "#4ade80",
    },
    excellentBadgeText: {
      color: "#08331a",
      marginLeft: 2,
    },
  });
};
