import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  findNodeHandle,
} from "react-native";
import Modal from "react-native-modal";
import { Search, X } from "lucide-react-native";
import { FlashList } from "@shopify/flash-list";
import usePlayerStore from "@/stores/playerStore";
import useDetailStore from "@/stores/detailStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useDanmakuStore } from "@/stores/danmakuStore";
import {
  searchDanmakuAnime,
  fetchDanmakuBangumiEpisodes,
  formatDanmakuEpisodeTitle,
  getDanmakuEpisodeNumber,
  sortDanmakuAnimeCandidates,
  type DanmakuAnime,
  type DanmakuEpisode,
} from "@/services/danmaku";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { DanmakuSelectionManager } from "@/services/storage";

export const DanmakuManualMatchModal: React.FC = () => {
  const show = usePlayerStore((state) => state.showDanmakuManualModal);
  const setShow = usePlayerStore((state) => state.setShowDanmakuManualModal);
  const title = useDetailStore((state) => state.detail?.title || "");
  const year = useDetailStore((state) => state.detail?.year || "");
  const playbackSource = useDetailStore((state) => state.detail?.source || "");
  const playbackId = useDetailStore((state) => state.detail?.id);
  const baseUrl = useSettingsStore((state) => state.danmakuApiUrl);
  const currentMatch = useDanmakuStore((state) => state.match);
  const loadEpisode = useDanmakuStore((state) => state.loadEpisode);
  const currentEpisodeIndex = usePlayerStore((state) => state.currentEpisodeIndex);
  const currentEpisodeCount = usePlayerStore((state) => state.episodes.length);
  const currentEpisodeNumber = currentEpisodeIndex + 1;
  const { screenWidth } = useResponsiveLayout();

  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<DanmakuAnime[]>([]);
  const [selected, setSelected] = useState<DanmakuAnime | null>(null);
  const [episodes, setEpisodes] = useState<DanmakuEpisode[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const searchSeq = useRef(0);
  const episodeSeq = useRef(0);
  const episodeListRef = useRef<FlashList<DanmakuEpisode>>(null);
  const inputRef = useRef<TextInput>(null);
  const inputAnchorRef = useRef<View>(null);
  const searchButtonRef = useRef<View>(null);
  const closeButtonRef = useRef<View>(null);
  const firstAnimeRef = useRef<View>(null);
  const firstEpisodeRef = useRef<View>(null);
  const [focusTags, setFocusTags] = useState<{
    input?: number;
    inputAnchor?: number;
    search?: number;
    close?: number;
    firstAnime?: number;
    firstEpisode?: number;
  }>({});

  // 只负责计算原生 tag，供上下左右焦点链使用
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(() => {
      setFocusTags({
        input: findNodeHandle(inputRef.current) ?? undefined,
        inputAnchor: findNodeHandle(inputAnchorRef.current) ?? undefined,
        search: findNodeHandle(searchButtonRef.current) ?? undefined,
        close: findNodeHandle(closeButtonRef.current) ?? undefined,
        firstAnime: findNodeHandle(firstAnimeRef.current) ?? undefined,
        firstEpisode: findNodeHandle(firstEpisodeRef.current) ?? undefined,
      });
    }, 320);
    return () => clearTimeout(timer);
  }, [show, results.length, episodes.length, selected?.animeId]);

  // hasTVPreferredFocus 在 Modal 刚挂载时经常被忽略，等弹窗动画结束后显式请求焦点
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(() => {
      (searchButtonRef.current as unknown as { requestTVFocus?: () => void })?.requestTVFocus?.();
    }, 320);
    return () => clearTimeout(timer);
  }, [show]);

  const runLoadEpisodes = useCallback(
    async (anime: DanmakuAnime) => {
      if (!baseUrl.trim()) return;
      const seq = ++episodeSeq.current;
      setLoadingEpisodes(true);
      setError(null);
      try {
        const list = await fetchDanmakuBangumiEpisodes(baseUrl, anime.animeId);
        if (seq !== episodeSeq.current) return;
        setEpisodes(list);
        if (!list.length) setError("该番剧暂无可用剧集");
      } catch (err) {
        if (seq !== episodeSeq.current) return;
        setError(err instanceof Error ? err.message : "获取剧集失败");
      } finally {
        if (seq === episodeSeq.current) setLoadingEpisodes(false);
      }
    },
    [baseUrl],
  );

  const runSearch = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setError("请输入搜索关键词");
        return;
      }
      if (!baseUrl.trim()) {
        setError("请先在设置中填写弹幕API");
        return;
      }
      const seq = ++searchSeq.current;
      setSearching(true);
      setError(null);
      try {
        const animes = sortDanmakuAnimeCandidates(
          await searchDanmakuAnime(baseUrl, trimmed),
          year,
          currentEpisodeCount,
        );
        if (seq !== searchSeq.current) return;
        setResults(animes);
        // 有手动选择记忆时优先回到上次选的番剧
        const saved =
          playbackSource && playbackId
            ? await DanmakuSelectionManager.get(playbackSource, playbackId)
            : null;
        const preferred =
          (saved ? animes.find((anime) => anime.animeId === saved.animeId) : null) ||
          animes[0] ||
          null;
        setSelected(preferred);
        setEpisodes([]);
        if (!animes.length) {
          setError("没有找到匹配的番剧");
        } else if (preferred) {
          void runLoadEpisodes(preferred);
        }
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setError(err instanceof Error ? err.message : "搜索失败");
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [baseUrl, currentEpisodeCount, playbackId, playbackSource, runLoadEpisodes, year],
  );

  // 剧集列表加载后滚到当前播放集，避免用户以为没有选中
  useEffect(() => {
    if (!episodes.length) return;
    const matchedEpisodeId =
      currentMatch && currentMatch.animeId === selected?.animeId
        ? currentMatch.episodeId
        : undefined;
    const matchedIndex =
      matchedEpisodeId === undefined
        ? -1
        : episodes.findIndex((episode) => episode.episodeId === matchedEpisodeId);
    const playbackIndex = episodes.findIndex(
      (episode, position) =>
        (getDanmakuEpisodeNumber(episode) ?? position + 1) === currentEpisodeNumber,
    );
    const index = matchedIndex >= 0 ? matchedIndex : playbackIndex;
    if (index < 0) return;
    const timer = setTimeout(() => {
      episodeListRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
    }, 80);
    return () => clearTimeout(timer);
  }, [episodes, currentEpisodeNumber, currentMatch, selected?.animeId]);

  // 打开时用当前剧名预搜索，TV 上无需输入即可选剧
  useEffect(() => {
    if (!show) return;
    const initial = title || currentMatch?.animeTitle || "";
    setKeyword(initial);
    if (title || currentMatch?.animeTitle) {
      void runSearch(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const onSelectAnime = (anime: DanmakuAnime) => {
    setSelected(anime);
    void runLoadEpisodes(anime);
  };

  const onSelectEpisode = async (episode: DanmakuEpisode) => {
    if (!selected || applyingId !== null) return;
    setApplyingId(episode.episodeId);
    try {
      await loadEpisode(
        {
          episodeId: episode.episodeId,
          animeId: selected.animeId,
          animeTitle: selected.animeTitle,
          episodeTitle: episode.episodeTitle,
          episodeNumber: getDanmakuEpisodeNumber(episode) ?? undefined,
          source: selected.source,
        },
        {
          force: true,
          rememberSelection:
            playbackSource && playbackId
              ? {
                  source: playbackSource,
                  id: String(playbackId),
                  playbackEpisodeNumber: currentEpisodeNumber,
                }
              : undefined,
        },
      );
      setShow(false);
    } finally {
      setApplyingId(null);
    }
  };

  const onClose = () => setShow(false);
  const isWide = screenWidth >= 700;

  return (
    <Modal
      isVisible={show}
      statusBarTranslucent
      onBackButtonPress={onClose}
      onBackdropPress={onClose}
      style={styles.modal}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>手动匹配弹幕</Text>
            <Text style={styles.subtitle}>搜索番剧并指定集数，立即覆盖当前弹幕</Text>
          </View>
          <Pressable
            ref={closeButtonRef}
            focusable
            nextFocusDown={focusTags.search}
            nextFocusLeft={focusTags.inputAnchor}
            style={({ focused }) => [styles.closeButton, focused && styles.closeButtonFocused]}
            onPress={onClose}
            accessibilityLabel="关闭手动匹配弹窗"
          >
            <X color="#ffffff" size={20} />
          </Pressable>
        </View>

        <View style={styles.searchRow}>
          <Pressable
            ref={inputAnchorRef}
            focusable
            nextFocusRight={focusTags.search}
            nextFocusDown={focusTags.firstAnime}
            onFocus={() => inputRef.current?.focus()}
            style={styles.inputAnchor}
            accessibilityLabel="搜索关键词输入区"
          >
            <TextInput
              ref={inputRef}
              focusable
              nextFocusRight={focusTags.search}
              nextFocusDown={focusTags.firstAnime}
              style={[styles.input, inputFocused && styles.inputFocused]}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              value={keyword}
              onChangeText={setKeyword}
              placeholder="输入标题关键词"
              placeholderTextColor="#777"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => void runSearch(keyword)}
            />
          </Pressable>
          <Pressable
            ref={searchButtonRef}
            focusable
            nextFocusLeft={focusTags.inputAnchor}
            nextFocusUp={focusTags.close}
            nextFocusDown={focusTags.firstEpisode}
            style={({ focused }) => [styles.searchButton, focused && styles.searchButtonFocused]}
            hasTVPreferredFocus={!results.length}
            onPress={() => void runSearch(keyword)}
            disabled={searching}
          >
            {searching ? <ActivityIndicator color="#04150c" size="small" /> : <Search color="#04150c" size={16} />}
            <Text style={styles.searchButtonText}>搜索弹幕源</Text>
          </Pressable>
        </View>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <View style={[styles.columns, !isWide && styles.columnsStacked]}>
          <View style={styles.column}>
            <Text style={styles.columnTitle}>搜索结果（选择正确番剧）</Text>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {results.map((anime, index) => {
                const isSelected = selected?.animeId === anime.animeId;
                return (
                  <Pressable
                    key={`${anime.animeId}-${index}`}
                    ref={index === 0 ? firstAnimeRef : undefined}
                    hasTVPreferredFocus={index === 0}
                    nextFocusUp={index === 0 ? focusTags.inputAnchor : undefined}
                    nextFocusRight={focusTags.firstEpisode}
                    onPress={() => onSelectAnime(anime)}
                    style={({ focused }) => [
                      styles.animeItem,
                      isSelected && styles.animeItemSelected,
                      focused && styles.itemFocused,
                    ]}
                  >
                    <View style={styles.poster} />
                    <View style={styles.animeInfo}>
                      <Text style={styles.animeTitle} numberOfLines={2}>
                        {anime.animeTitle}
                      </Text>
                      <Text style={styles.animeMeta}>
                        {anime.type || "未知类型"}
                        {anime.episodeCount ? ` · 共 ${anime.episodeCount} 集` : ""}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {!results.length && !searching && (
                <Text style={styles.emptyText}>暂无结果</Text>
              )}
            </ScrollView>
          </View>

          <View style={styles.column}>
            <Text style={styles.columnTitle}>
              {selected ? `集数列表：${selected.animeTitle}` : "集数列表"}
            </Text>
            {loadingEpisodes ? (
              <ActivityIndicator color="#00bb5e" style={styles.loading} />
            ) : !selected ? (
              <Text style={styles.emptyText}>请先选择左侧番剧</Text>
            ) : (
              <View style={styles.list}>
                <FlashList
                  ref={episodeListRef}
                  data={episodes}
                  estimatedItemSize={46}
                  drawDistance={500}
                  keyExtractor={(episode, index) => `${episode.episodeId}-${index}`}
                  extraData={`${currentMatch?.episodeId || ""}-${selected?.animeId || ""}-${currentEpisodeNumber}-${applyingId || ""}`}
                  contentContainerStyle={styles.flashListContent}
                  renderItem={({ item: episode, index }) => {
                    const parsedNumber = getDanmakuEpisodeNumber(episode);
                    const matchBelongsToSelectedAnime =
                      currentMatch?.animeId === selected?.animeId;
                    const isCurrent =
                      matchBelongsToSelectedAnime
                        ? currentMatch?.episodeId === episode.episodeId
                        : parsedNumber !== null
                          ? parsedNumber === currentEpisodeNumber
                          : index + 1 === currentEpisodeNumber;
                    const applying = applyingId === episode.episodeId;
                    return (
                      <Pressable
                        ref={index === 0 ? firstEpisodeRef : undefined}
                        nextFocusUp={focusTags.search}
                        nextFocusLeft={focusTags.firstAnime}
                        onPress={() => void onSelectEpisode(episode)}
                        style={({ focused }) => [
                          styles.episodeItem,
                          isCurrent && styles.episodeItemCurrent,
                          focused && styles.itemFocused,
                        ]}
                        disabled={applyingId !== null}
                      >
                        <Text style={styles.episodeTitle} numberOfLines={1}>
                          {formatDanmakuEpisodeTitle(episode) || `第${index + 1}集`}
                        </Text>
                        <Text style={styles.episodeAction}>
                          {applying ? "应用中…" : isCurrent ? "当前集" : "使用此集"}
                        </Text>
                      </Pressable>
                    );
                  }}
                />
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modal: {
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1000,
    elevation: 1000,
  },
  content: {
    width: "92%",
    maxWidth: 900,
    height: "100%",
    backgroundColor: "#0f1213",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  title: {
    color: "white",
    fontSize: 17,
    fontWeight: "bold",
  },
  subtitle: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    marginTop: 4,
  },
  closeButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButtonFocused: {
    backgroundColor: "rgba(0,187,94,0.18)",
    borderRadius: 16,
  },
  searchRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  inputAnchor: {
    flex: 1,
  },
  input: {
    flex: 1,
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "white",
    paddingHorizontal: 12,
    fontSize: 14,
  },
  inputFocused: {
    borderColor: "#00bb5e",
  },
  searchButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: 8,
    backgroundColor: "#00bb5e",
  },
  searchButtonFocused: {
    backgroundColor: "#00d96b",
  },
  searchButtonText: {
    color: "#04150c",
    fontSize: 14,
    fontWeight: "bold",
  },
  error: {
    color: "#ffcf66",
    fontSize: 12,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  columns: {
    flex: 1,
    flexDirection: "row",
  },
  columnsStacked: {
    flexDirection: "column",
  },
  column: {
    flex: 1,
    minHeight: 0,
    borderRightWidth: 1,
    borderRightColor: "rgba(255,255,255,0.1)",
  },
  columnTitle: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 6,
  },
  flashListContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  animeItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  animeItemSelected: {
    borderColor: "rgba(0,187,94,0.7)",
    backgroundColor: "rgba(0,187,94,0.12)",
  },
  itemFocused: {
    borderWidth: 2,
    borderColor: "#00bb5e",
    backgroundColor: "rgba(0,187,94,0.16)",
  },
  poster: {
    width: 30,
    height: 42,
    borderRadius: 5,
    backgroundColor: "#2b3a41",
  },
  animeInfo: {
    flex: 1,
    minWidth: 0,
  },
  animeTitle: {
    color: "white",
    fontSize: 13,
  },
  animeMeta: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
    marginTop: 2,
  },
  emptyText: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
  loading: {
    marginTop: 16,
  },
  episodeItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(255,255,255,0.03)",
    marginBottom: 6,
  },
  episodeItemCurrent: {
    borderColor: "rgba(0,187,94,0.55)",
    backgroundColor: "rgba(0,187,94,0.1)",
  },
  episodeTitle: {
    flex: 1,
    color: "white",
    fontSize: 13,
  },
  episodeAction: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
  },
});

export default DanmakuManualMatchModal;
