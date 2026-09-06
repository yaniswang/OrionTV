import React from "react";
import { View, Text, StyleSheet, ActivityIndicator, TextInput, Pressable } from "react-native";
import { FlashList } from "@shopify/flash-list";
import Modal from "react-native-modal";
import { StyledButton } from "./StyledButton";
import useDanmakuStore from "@/stores/danmakuStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { formatDanmakuSourceLabel } from "@/utils/danmaku";

export const DanmakuSourceModal: React.FC = () => {
  const {
    showModal,
    setShowModal,
    sources,
    episodes,
    selectedAnime,
    selection,
    searchKeyword,
    setSearchKeyword,
    search,
    selectAnime,
    selectEpisode,
    loading,
    searchError,
    enabled,
    toggleEnabled,
    count,
    area,
    density,
    setArea,
    setDensity,
  } = useDanmakuStore();
  const responsiveConfig = useResponsiveLayout();

  const onClose = () => setShowModal(false);

  return (
    <Modal
      isVisible={showModal}
      statusBarTranslucent={true}
      onBackButtonPress={onClose}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection="down"
      style={styles.modalContainer}
    >
      <View style={styles.modalContent}>
        <Text style={styles.modalTitle}>弹幕源</Text>
        <View style={styles.toolbar}>
          <StyledButton
            text={enabled ? "弹幕开" : "弹幕关"}
            isSelected={enabled}
            onPress={toggleEnabled}
            style={styles.toggle}
            textStyle={styles.toggleText}
          />
          {count > 0 ? <Text style={styles.count}>{count} 条</Text> : null}
        </View>
        <View style={styles.settingBlock}>
          <Text style={styles.settingLabel}>显示区域</Text>
          <View style={styles.settingRow}>
            {([
              { value: 0.25, label: "25%" },
              { value: 0.5, label: "50%" },
              { value: 0.75, label: "75%" },
            ] as const).map((item) => (
              <StyledButton
                key={item.label}
                text={item.label}
                isSelected={area === item.value}
                hasTVPreferredFocus={area === item.value}
                onPress={() => setArea(item.value)}
                style={styles.settingBtn}
                textStyle={styles.settingBtnText}
              />
            ))}
          </View>
        </View>
        <View style={styles.settingBlock}>
          <Text style={styles.settingLabel}>密度</Text>
          <View style={styles.settingRow}>
            {([
              { value: "sparse", label: "稀疏" },
              { value: "medium", label: "中等" },
              { value: "unlimited", label: "无限" },
            ] as const).map((item) => (
              <StyledButton
                key={item.value}
                text={item.label}
                isSelected={density === item.value}
                onPress={() => setDensity(item.value)}
                style={styles.settingBtn}
                textStyle={styles.settingBtnText}
              />
            ))}
          </View>
        </View>
        <View style={styles.searchRow}>
          <TextInput
            value={searchKeyword}
            onChangeText={setSearchKeyword}
            placeholder="搜索弹幕源"
            placeholderTextColor="#888"
            style={styles.input}
            onSubmitEditing={() => search()}
            returnKeyType="search"
          />
          <StyledButton text="搜索" onPress={() => search()} style={styles.searchBtn} textStyle={styles.searchBtnText} />
        </View>
        {loading ? <ActivityIndicator color="#00bb5e" style={{ marginVertical: 8 }} /> : null}
        {searchError ? <Text style={styles.error}>{searchError}</Text> : null}

        {selectedAnime ? (
          <>
            <Pressable onPress={() => useDanmakuStore.setState({ selectedAnime: null, episodes: [] })}>
              <Text style={styles.back}>‹ 返回源列表 · {selectedAnime.animeTitle}</Text>
            </Pressable>
            <FlashList
              data={episodes}
              estimatedItemSize={52}
              extraData={selection?.episodeId}
              keyExtractor={(item) => `ep-${item.episodeId}`}
              numColumns={Math.max(1, Math.floor((responsiveConfig.screenWidth * 0.8) / 160))}
              renderItem={({ item }) => (
                <StyledButton
                  text={item.episodeTitle}
                  onPress={() => selectEpisode(item)}
                  isSelected={selection?.episodeId === item.episodeId}
                  style={styles.item}
                  textStyle={styles.itemText}
                />
              )}
            />
          </>
        ) : (
          <FlashList
            data={sources}
            estimatedItemSize={64}
            extraData={selection?.animeId}
            keyExtractor={(item) => `anime-${item.animeId}-${item.source}`}
            renderItem={({ item, index }) => (
              <StyledButton
                text={formatDanmakuSourceLabel(item)}
                onPress={() => selectAnime(item, index)}
                isSelected={selection?.animeId === item.animeId}
                style={styles.item}
                textStyle={styles.itemText}
              />
            )}
          />
        )}
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
    width: "82%",
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    padding: 16,
  },
  modalTitle: {
    color: "white",
    marginBottom: 8,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "bold",
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    gap: 10,
  },
  toggle: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    minWidth: 72,
  },
  toggleText: {
    fontSize: 14,
  },
  count: {
    color: "#9adbb5",
    fontSize: 13,
  },
  settingBlock: {
    marginBottom: 8,
  },
  settingLabel: {
    color: "#9adbb5",
    fontSize: 13,
    marginBottom: 6,
  },
  settingRow: {
    flexDirection: "row",
    gap: 8,
  },
  settingBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    minWidth: 0,
  },
  settingBtnText: {
    fontSize: 14,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  input: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "white",
  },
  searchBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  searchBtnText: {
    fontSize: 14,
  },
  error: {
    color: "#ff8a8a",
    marginBottom: 8,
  },
  back: {
    color: "#00bb5e",
    marginBottom: 8,
    fontSize: 14,
  },
  item: {
    paddingVertical: 10,
    margin: 4,
  },
  itemText: {
    fontSize: 14,
    textAlign: "left",
  },
});
