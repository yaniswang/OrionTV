import React, { useState, useEffect, useRef } from "react";
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
  const { showEpisodeModal, episodes, currentEpisodeIndex, playEpisode, setShowEpisodeModal } = usePlayerStore();

  const [episodeGroupSize] = useState(30);
  const [selectedEpisodeGroup, setSelectedEpisodeGroup] = useState(Math.floor(currentEpisodeIndex / episodeGroupSize));

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
              data={new Array(Math.ceil(episodes.length / episodeGroupSize))}
              horizontal
              estimatedItemSize={87}
              initialScrollIndex={selectedEpisodeGroup}
              renderItem={({ index }) => <StyledButton
                key={index}
                text={`${index * episodeGroupSize + 1}-${Math.min(
                  (index + 1) * episodeGroupSize,
                  episodes.length
                )}`}
                onPress={() => setSelectedEpisodeGroup(index)}
                isSelected={selectedEpisodeGroup === index}
                style={styles.episodeGroupButton}
                textStyle={styles.episodeGroupButtonText}
                />
              }
            />
          </View>
        )}
        <FlashList
          data={episodes.slice(
            selectedEpisodeGroup * episodeGroupSize,
            (selectedEpisodeGroup + 1) * episodeGroupSize
          )}
          initialScrollIndex={currentEpisodeIndex % episodeGroupSize}
          numColumns={Math.floor((responsiveConfig.screenWidth * 0.9) / 120)}
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
