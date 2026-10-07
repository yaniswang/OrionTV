import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import usePlayerStore from "@/stores/playerStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { usePlaybackController } from "@/hooks/usePlaybackController";

export const SpeedSelectionModal: React.FC = () => {
  const { showSpeedModal, setShowSpeedModal } = usePlayerStore();
  const { playbackRate, availablePlaybackRates, setPlaybackRate } = usePlaybackController();
  const responsiveConfig = useResponsiveLayout();

  const onSelectSpeed = (rate: number) => {
    void setPlaybackRate(rate);
    setShowSpeedModal(false);
  };

  const onClose = () => {
    setShowSpeedModal(false);
  };

  return (
    <Modal isVisible={showSpeedModal} statusBarTranslucent={true} onBackButtonPress={onClose} onBackdropPress={onClose} onSwipeComplete={onClose} swipeDirection="down" style={styles.modalContainer}>
      <View style={styles.modalContent}>
        <Text style={styles.modalTitle}>播放速度</Text>
        <FlashList
          data={availablePlaybackRates}
          numColumns={Math.floor((responsiveConfig.screenWidth * 0.9) / 170)}
          keyExtractor={(item) => `speed-${item}`}
          extraData={playbackRate}
          estimatedItemSize={77}
          renderItem={({ item }) => (
            <StyledButton
              text={`${item}x`}
              onPress={() => onSelectSpeed(item)}
              isSelected={playbackRate === item}
              hasTVPreferredFocus={playbackRate === item}
              style={styles.speedItem}
              textStyle={styles.speedItemText}
            />
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
    width: '80%',
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
  speedItem: {
    flex: 1,
    paddingVertical: 10,
    margin: 4,
    marginLeft: 10,
    marginRight: 8,
  },
  speedItemText: {
    fontSize: 16,
  },
});
