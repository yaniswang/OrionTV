import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import usePlayerStore from "@/stores/playerStore";

interface EpisodeSelectionModalProps {}

export const EpisodeSelectionModal: React.FC<EpisodeSelectionModalProps> = () => {
  const { showEpisodeModal, episodes, currentEpisodeIndex, playEpisode, setShowEpisodeModal } = usePlayerStore();

  const [episodeGroupSize] = useState(30);
  const [selectedEpisodeGroup, setSelectedEpisodeGroup] = useState(Math.floor(currentEpisodeIndex / episodeGroupSize));

  const onSelectEpisode = (index: number) => {
    playEpisode(index);
    setShowEpisodeModal(false);
  };

  const onClose = () => {
    setShowEpisodeModal(false);
  };

  useEffect(() => {
    setSelectedEpisodeGroup(Math.floor(currentEpisodeIndex / episodeGroupSize));
  }, [currentEpisodeIndex]);

  return (
    <Modal isVisible={showEpisodeModal} statusBarTranslucent={true} onBackButtonPress={onClose} onBackdropPress={onClose} onSwipeComplete={onClose} swipeDirection="down" style={styles.modalContainer}>
      <View style={styles.modalContent}>
        <Text style={styles.modalTitle}>选择剧集</Text>
        {episodes.length > episodeGroupSize && (
          <View style={styles.episodeGroupContainer}>
            {Array.from({ length: Math.ceil(episodes.length / episodeGroupSize) }, (_, groupIndex) => (
              <StyledButton
                key={groupIndex}
                text={`${groupIndex * episodeGroupSize + 1}-${Math.min(
                  (groupIndex + 1) * episodeGroupSize,
                  episodes.length
                )}`}
                onPress={() => setSelectedEpisodeGroup(groupIndex)}
                isSelected={selectedEpisodeGroup === groupIndex}
                style={styles.episodeGroupButton}
                textStyle={styles.episodeGroupButtonText}
              />
            ))}
          </View>
        )}
        <FlashList
          data={episodes.slice(
            selectedEpisodeGroup * episodeGroupSize,
            (selectedEpisodeGroup + 1) * episodeGroupSize
          )}
          numColumns={5}
          keyExtractor={(_, index) => `episode-${selectedEpisodeGroup * episodeGroupSize + index}`}
          extraData={currentEpisodeIndex} 
          estimatedItemSize={60}
          renderItem={({ item, index }) => {
            const absoluteIndex = selectedEpisodeGroup * episodeGroupSize + index;
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
    width: 600,
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
    width: "18%",
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
    paddingHorizontal: 6,
    margin: 8,
  },
  episodeGroupButtonText: {
    fontSize: 12,
  },
});
