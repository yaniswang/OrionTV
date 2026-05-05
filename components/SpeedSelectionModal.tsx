import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import usePlayerStore from "@/stores/playerStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface SpeedOption {
  rate: number;
  label: string;
}

const SPEED_OPTIONS: SpeedOption[] = [
  { rate: 0.5, label: "0.5x" },
  { rate: 0.75, label: "0.75x" },
  { rate: 1.0, label: "1x" },
  { rate: 1.25, label: "1.25x" },
  { rate: 1.5, label: "1.5x" },
  { rate: 2.0, label: "2x" },
  { rate: 4.0, label: "4x" },
  { rate: 8.0, label: "8x" },
];

export const SpeedSelectionModal: React.FC = () => {
  const { showSpeedModal, setShowSpeedModal, playbackRate, setPlaybackRate } = usePlayerStore();
  const responsiveConfig = useResponsiveLayout();

  const onSelectSpeed = (rate: number) => {
    setPlaybackRate(rate);
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
          data={SPEED_OPTIONS}
          numColumns={Math.floor((responsiveConfig.screenWidth * 0.9) / 170)}
          keyExtractor={(item) => `speed-${item.rate}`}
          extraData={playbackRate}
          estimatedItemSize={77}
          renderItem={({ item }) => (
            <StyledButton
              text={item.label}
              onPress={() => onSelectSpeed(item.rate)}
              isSelected={playbackRate === item.rate}
              hasTVPreferredFocus={playbackRate === item.rate}
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