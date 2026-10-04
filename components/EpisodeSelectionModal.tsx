import React, { useState, useMemo, useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import usePlayerStore from "@/stores/playerStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface EpisodeSelectionModalProps {}

interface FlashItemData {
  id: string;
  title: string;
}

export const EpisodeSelectionModal: React.FC<EpisodeSelectionModalProps> = () => {
  // 只订阅需要的字段：播放进度每 500ms 变一次，整店订阅会让这个弹窗跟着每秒重渲染两次
  const showEpisodeModal = usePlayerStore((s) => s.showEpisodeModal);
  const episodes = usePlayerStore((s) => s.episodes);
  const currentEpisodeIndex = usePlayerStore((s) => s.currentEpisodeIndex);
  const playEpisode = usePlayerStore((s) => s.playEpisode);
  const setShowEpisodeModal = usePlayerStore((s) => s.setShowEpisodeModal);

  const [episodeGroupSize] = useState(30);
  // 组件挂载时可能还没拿到剧集（currentEpisodeIndex 为 -1），这里必须夹到 0，
  // 否则分组会是 -1，下面的 slice 取不到数据、初始滚动位置又会越界
  const [selectedEpisodeGroup, setSelectedEpisodeGroup] = useState(
    Math.max(0, Math.floor(currentEpisodeIndex / episodeGroupSize)),
  );

  // 打开弹窗或切集时，把分组跟到当前集所在的那一组
  useEffect(() => {
    if (!showEpisodeModal) return;
    setSelectedEpisodeGroup(Math.max(0, Math.floor(currentEpisodeIndex / episodeGroupSize)));
  }, [showEpisodeModal, currentEpisodeIndex, episodeGroupSize]);

  // 这两个数组以前是每次渲染都新建，导致 FlashList 的缓存全部失效、每帧重新测量
  const groupCount = Math.max(1, Math.ceil(episodes.length / episodeGroupSize));
  const safeGroupIndex = Math.min(selectedEpisodeGroup, groupCount - 1);
  const groupData = useMemo(() => new Array(groupCount).fill(0), [groupCount]);
  const visibleEpisodes = useMemo(
    () =>
      episodes.slice(
        safeGroupIndex * episodeGroupSize,
        (safeGroupIndex + 1) * episodeGroupSize,
      ),
    [episodes, safeGroupIndex, episodeGroupSize],
  );
  // 初始滚动位置一旦超过列表长度，FlashList 会直接抛 "No layout available"
  const initialEpisodeIndex =
    visibleEpisodes.length > 0
      ? Math.min(Math.max(currentEpisodeIndex, 0) % episodeGroupSize, visibleEpisodes.length - 1)
      : undefined;

  const responsiveConfig = useResponsiveLayout();
  const onSelectEpisode = (index: number) => {
    playEpisode(index);
    setShowEpisodeModal(false);
  };

  const onClose = () => {
    setShowEpisodeModal(false);
  };
  
  return (
    <Modal isVisible={showEpisodeModal} statusBarTranslucent={true} onBackButtonPress={onClose} onBackdropPress={onClose} onSwipeComplete={onClose} swipeDirection="down" style={styles.modalContainer}>
      <View style={styles.modalContent}>
        <Text style={styles.modalTitle}>{'选集'+(episodes.length>1?` (${episodes.length})`:'')}</Text>
        {episodes.length > episodeGroupSize && (
          <View style={styles.episodeGroupContainer}>
            <FlashList
              data={groupData}
              horizontal
              estimatedItemSize={87}
              initialScrollIndex={safeGroupIndex}
              renderItem={({ index }) => <StyledButton
                key={index}
                text={`${index * episodeGroupSize + 1}-${Math.min(
                  (index + 1) * episodeGroupSize,
                  episodes.length
                )}`}
                onPress={() => setSelectedEpisodeGroup(index)}
                isSelected={safeGroupIndex === index}
                style={styles.episodeGroupButton}
                textStyle={styles.episodeGroupButtonText}
                />
              }
            />
          </View>
        )}
        <FlashList
          data={visibleEpisodes}
          initialScrollIndex={initialEpisodeIndex}
          numColumns={Math.floor((responsiveConfig.screenWidth * 0.9) / 120)}
          keyExtractor={(_, index) => `episode-${safeGroupIndex * episodeGroupSize + index}`}
          extraData={currentEpisodeIndex} 
          estimatedItemSize={60}
          renderItem={({ item, index }) => {
            const absoluteIndex = safeGroupIndex * episodeGroupSize + index;
            return (
              <StyledButton
                text={item.title || `第 ${absoluteIndex + 1} 集`}
                onPress={() => onSelectEpisode(absoluteIndex)}
                isSelected={currentEpisodeIndex === absoluteIndex}
                hasTVPreferredFocus={currentEpisodeIndex === absoluteIndex}
                style={styles.episodeItem}
                textStyle={styles.episodeItemText}
              />
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
  modalTitle: {
    color: "white",
    marginBottom: 12,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "bold",
  },
  episodeItem: {
    flex: 1,
    paddingVertical: 2,
    margin: 4,
  },
  episodeItemText: {
    fontSize: 14,
  },
  episodeGroupContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  episodeGroupButton: {
    paddingHorizontal: 0,
    margin: 2,
  },
  episodeGroupButtonText: {
    fontSize: 12,
  },
});
