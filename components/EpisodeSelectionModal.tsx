import React, { useState, useMemo, useEffect } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import usePlayerStore from "@/stores/playerStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { useScreenDimensions } from "@/hooks/useScreenDimensions";
import { usePlaybackController } from "@/hooks/usePlaybackController";
import { getEpisodeGroups, getEpisodeTotal } from "@/utils/EpisodeLabelUtils";

interface EpisodeSelectionModalProps {}

interface FlashItemData {
  id: string;
  title: string;
}

export const EpisodeSelectionModal: React.FC<EpisodeSelectionModalProps> = () => {
  // 只订阅需要的字段：播放进度每 500ms 变一次，整店订阅会让这个弹窗跟着每秒重渲染两次
  const showEpisodeModal = usePlayerStore((s) => s.showEpisodeModal);
  const screen = useScreenDimensions();
  const episodes = usePlayerStore((s) => s.episodes);
  const currentEpisodeIndex = usePlayerStore((s) => s.currentEpisodeIndex);
  const { playEpisode } = usePlaybackController();
  const setShowEpisodeModal = usePlayerStore((s) => s.setShowEpisodeModal);

  // 集数、分组标签按片源分集标题里的集号算；没有集号的特别篇显示在最后
  const episodeTitles = useMemo(() => episodes.map((episode) => episode.title), [episodes]);
  const episodeTotal = useMemo(
    () => getEpisodeTotal(episodeTitles, episodes.length),
    [episodeTitles, episodes.length],
  );
  // 分组：正片按集号每 30 集一组，没有集号的条目放最后的"其它"组；组内存的是原始下标，播放、选中都用原始下标
  const [episodeGroupSize] = useState(30);
  const groups = useMemo(
    () => getEpisodeGroups(episodeTitles, episodeGroupSize),
    [episodeTitles, episodeGroupSize],
  );
  // 组件挂载时可能还没拿到剧集（currentEpisodeIndex 为 -1），找不到所在组时落到第 0 组
  const currentGroup = Math.max(
    0,
    groups.findIndex((group) => group.indices.includes(currentEpisodeIndex)),
  );
  const [selectedEpisodeGroup, setSelectedEpisodeGroup] = useState(currentGroup);

  // 打开弹窗或切集时，把分组跟到当前集所在的那一组
  useEffect(() => {
    if (!showEpisodeModal) return;
    setSelectedEpisodeGroup(currentGroup);
  }, [showEpisodeModal, currentGroup]);

  const groupCount = Math.max(1, groups.length);
  const safeGroupIndex = Math.min(selectedEpisodeGroup, groupCount - 1);
  // 这两个数组以前是每次渲染都新建，导致 FlashList 的缓存全部失效、每帧重新测量
  const groupData = useMemo(() => new Array(groupCount).fill(0), [groupCount]);
  const visibleEpisodes = useMemo(
    () => (groups[safeGroupIndex]?.indices || []).map((index) => ({ index, title: episodes[index]?.title })),
    [groups, episodes, safeGroupIndex],
  );
  // 初始滚动位置一旦超过列表长度，FlashList 会直接抛 "No layout available"
  const positionInGroup = visibleEpisodes.findIndex((item) => item.index === currentEpisodeIndex);
  const initialEpisodeIndex =
    visibleEpisodes.length > 0 ? Math.max(0, positionInGroup) : undefined;

  const responsiveConfig = useResponsiveLayout();
  const onSelectEpisode = (index: number) => {
    void playEpisode(index);
    setShowEpisodeModal(false);
  };

  const onClose = () => {
    setShowEpisodeModal(false);
  };
  
  return (
    <Modal isVisible={showEpisodeModal} statusBarTranslucent={true} deviceWidth={screen.width} deviceHeight={screen.height} onBackButtonPress={onClose} onBackdropPress={onClose} onSwipeComplete={onClose} swipeDirection="down" style={styles.modalContainer}>
      <View style={styles.modalContent}>
        <Text style={styles.modalTitle}>{'选集'+(episodes.length>1?` (${episodeTotal})`:'')}</Text>
        {groups.length > 1 && (
          <View style={styles.episodeGroupContainer}>
            <FlashList
              data={groupData}
              horizontal
              estimatedItemSize={87}
              initialScrollIndex={safeGroupIndex}
              renderItem={({ index }) => <StyledButton
                key={index}
                text={groups[index]?.label}
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
          keyExtractor={(item) => `episode-${item.index}`}
          extraData={currentEpisodeIndex}
          estimatedItemSize={60}
          renderItem={({ item }) => {
            const absoluteIndex = item.index;
            return (
              <StyledButton
                text={item.title || `第 ${absoluteIndex + 1} 集`}
                onPress={() => onSelectEpisode(absoluteIndex)}
                isSelected={currentEpisodeIndex === absoluteIndex}
                // 只在 TV 上抢焦点：手机上焦点会让按压水波纹常驻，选中的绿色被叠成青色
                hasTVPreferredFocus={Platform.isTV && currentEpisodeIndex === absoluteIndex}
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
