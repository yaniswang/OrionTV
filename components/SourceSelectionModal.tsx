import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import { ThemedText } from "@/components/ThemedText";
import useDetailStore from "@/stores/detailStore";
import usePlayerStore from "@/stores/playerStore";
import Logger from '@/utils/Logger';
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";

const logger = Logger.withTag('SourceSelectionModal');

export const SourceSelectionModal: React.FC = () => {
  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);
  
  const { showSourceModal, setShowSourceModal, loadVideo, currentEpisodeIndex, status } = usePlayerStore();
  const { searchResults, detail, setDetail } = useDetailStore();

  const onSelectSource = (index: number) => {
    logger.debug("onSelectSource", index, searchResults[index].source, detail?.source);
    if (searchResults[index].source !== detail?.source) {
      const newDetail = searchResults[index];
      setDetail(newDetail);
      
      // Reload the video with the new source, preserving current position
      const currentPosition = status?.isLoaded ? status.positionMillis : undefined;
      loadVideo({
        source: newDetail.source,
        id: newDetail.id.toString(),
        episodeIndex: currentEpisodeIndex,
        title: newDetail.title,
        year: newDetail.year,
        stype: newDetail.episodes.length > 1 ? 'tv' : 'movie',
        position: currentPosition
      });
    }
    setShowSourceModal(false);
  };

  const onClose = () => {
    setShowSourceModal(false);
  };

  return (
    <Modal isVisible={showSourceModal} statusBarTranslucent={true} onBackButtonPress={onClose} onBackdropPress={onClose} onSwipeComplete={onClose} swipeDirection="down" style={styles.modalContainer}>
      <View style={styles.modalContent}>
        <Text style={styles.modalTitle}>选择播放源 ({searchResults.length})</Text>
        <FlashList
          data={searchResults}
          numColumns={3}
          keyExtractor={(item, index) => `source-${item.source}-${index}`}
          extraData={detail?.source}
          estimatedItemSize={60}
          renderItem={({ item, index }) => (
            <StyledButton
              onPress={() => onSelectSource(index)}
              isSelected={detail?.source === item.source}
              hasTVPreferredFocus={detail?.source === item.source}
              style={styles.sourceItem}
              textStyle={dynamicStyles.sourceButton}
            >
                <ThemedText style={dynamicStyles.sourceButtonText}>{item.source_name}</ThemedText>
                {item.episodes.length > 1 && (
                  <View style={[dynamicStyles.badge, detail?.source === item.source && dynamicStyles.selectedBadge]}>
                    <Text style={dynamicStyles.badgeText}>
                      {item.episodes.length > 99 ? "99+" : `${item.episodes.length}`} 集
                    </Text>
                  </View>
                )}
                {item.resolution && (
                  <View style={[dynamicStyles.badge, { backgroundColor: "#666" }, detail?.source === item.source && dynamicStyles.selectedBadge]}>
                    <Text style={dynamicStyles.badgeText}>{item.resolution}</Text>
                  </View>
                )}
            </StyledButton>
          )}
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
    width: 800,
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    padding: 20,
  },
  modalTitle: {
    color: "white",
    marginBottom: 12,
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
    width: "30%",
  },
  sourceItemText: {
    fontSize: 14,
  },
});

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isTV = deviceType === 'tv';
  const isTablet = deviceType === 'tablet';
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
  });
};
