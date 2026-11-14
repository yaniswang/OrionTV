import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TVFocusGuideView,
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
  DANMAKU_SELECTION_VERSION,
  buildDanmakuSources,
  cleanDanmakuTitle,
  danmakuEpisodeNameKey,
  danmakuTitleKey,
  fetchDanmakuBangumiEpisodes,
  formatDanmakuEpisodeTitle,
  getDanmakuAnimeYear,
  getDanmakuPlatformName,
  getDanmakuPlatformRank,
  parsePlaybackEpisodeNumber,
  parsePlaybackEpisodeNumbers,
  romanFallbackKeyword,
  searchDanmakuAnime,
  sortDanmakuAnimeCandidates,
  type DanmakuMatch,
  type DanmakuSource,
  type DanmakuSourceEpisode,
} from "@/services/danmaku";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { useScreenDimensions } from "@/hooks/useScreenDimensions";
import { DanmakuSelectionManager, type DanmakuSelectionMemory } from "@/services/storage";
import { api } from "@/services/api";
import { Colors } from "@/constants/Colors";

/** 集列表每行占用高度：episodeItem.height 38 + marginBottom 6 */
const EPISODE_ROW_HEIGHT = 44;
/** 并发拉取候选剧集列表的数量 */
const BANGUMI_CONCURRENCY = 4;
/** 焦点停留多久后预览该弹幕源，避免快速移动时频繁切换右栏 */
const PREVIEW_DELAY_MS = 200;
const PRIMARY = Colors.dark.primary;

type EpisodeRow =
  | { kind: "episode"; episode: DanmakuSourceEpisode }
  | { kind: "divider"; count: number };

const platformLabel = (source: DanmakuSource) =>
  `${getDanmakuPlatformName(source.platform)}${source.isBackup ? "（经 360）" : " · 原站"}`;

const toMatch = (source: DanmakuSource, episode: DanmakuSourceEpisode): DanmakuMatch => ({
  episodeId: episode.episodeId,
  animeId: source.anime.animeId,
  animeTitle: source.anime.animeTitle,
  episodeTitle: episode.episodeTitle,
  episodeNumber: episode.number ?? undefined,
  source: source.anime.source,
  platform: source.platform,
});

export const DanmakuManualMatchModal: React.FC = () => {
  const show = usePlayerStore((state) => state.showDanmakuManualModal);
  const setShow = usePlayerStore((state) => state.setShowDanmakuManualModal);
  // 用片名而不是源标题：源标题可能带"国语1995"之类后缀
  const title = useDetailStore((state) => (state.detail ? state.title || state.detail.title : ""));
  const year = useDetailStore((state) => state.detail?.year || "");
  const playbackSource = useDetailStore((state) => state.detail?.source || "");
  const playbackId = useDetailStore((state) => state.detail?.id);
  const baseUrl = useSettingsStore((state) => state.danmakuApiUrl);
  const currentMatch = useDanmakuStore((state) => state.match);
  const matchMode = useDanmakuStore((state) => state.matchMode);
  const loadEpisode = useDanmakuStore((state) => state.loadEpisode);
  const resetToAuto = useDanmakuStore((state) => state.resetToAuto);
  const currentEpisodeIndex = usePlayerStore((state) => state.currentEpisodeIndex);
  const currentEpisodeCount = usePlayerStore((state) => state.episodes.length);
  const playbackEpisodeTitles = useDetailStore((state) => state.detail?.episodes_titles);
  // 片源真实集号；null 表示当前不是可对齐的正片（番外、合集）
  const playbackEpisodeNumbers = useMemo(
    () =>
      playbackEpisodeTitles?.length === currentEpisodeCount
        ? parsePlaybackEpisodeNumbers(playbackEpisodeTitles)
        : null,
    [playbackEpisodeTitles, currentEpisodeCount],
  );
  const currentEpisodeNumber = playbackEpisodeNumbers
    ? playbackEpisodeNumbers[currentEpisodeIndex] ?? null
    : parsePlaybackEpisodeNumber("", currentEpisodeIndex, currentEpisodeCount);
  const { screenWidth } = useResponsiveLayout();
  const screen = useScreenDimensions();

  const [keyword, setKeyword] = useState("");
  const [sources, setSources] = useState<DanmakuSource[]>([]);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [saved, setSaved] = useState<DanmakuSelectionMemory | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  /** 弹幕源全部加载完后递增，触发把电视焦点移到定位的那一行 */
  const [focusPreviewToken, setFocusPreviewToken] = useState(0);
  const searchSeq = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const episodeListRef = useRef<FlashList<EpisodeRow>>(null);
  const inputRef = useRef<TextInput>(null);
  const inputAnchorRef = useRef<View>(null);
  const searchButtonRef = useRef<View>(null);
  const closeButtonRef = useRef<View>(null);
  const resetButtonRef = useRef<View>(null);
  const previewSourceRef = useRef<View>(null);
  const entryEpisodeRef = useRef<View>(null);
  const [focusTags, setFocusTags] = useState<{
    input?: number;
    inputAnchor?: number;
    search?: number;
    close?: number;
    reset?: number;
    previewSource?: number;
    entryEpisode?: number;
  }>({});

  const preview = useMemo(
    () => sources.find((source) => source.key === previewKey) || null,
    [sources, previewKey],
  );

  // 只负责计算原生 tag，供上下左右焦点链使用
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(() => {
      setFocusTags({
        input: findNodeHandle(inputRef.current) ?? undefined,
        inputAnchor: findNodeHandle(inputAnchorRef.current) ?? undefined,
        search: findNodeHandle(searchButtonRef.current) ?? undefined,
        close: findNodeHandle(closeButtonRef.current) ?? undefined,
        reset: findNodeHandle(resetButtonRef.current) ?? undefined,
        previewSource: findNodeHandle(previewSourceRef.current) ?? undefined,
        entryEpisode: findNodeHandle(entryEpisodeRef.current) ?? undefined,
      });
    }, 320);
    return () => clearTimeout(timer);
  }, [show, sources.length, previewKey, matchMode]);

  // hasTVPreferredFocus 在 Modal 刚挂载时经常被忽略，等弹窗动画结束后显式请求焦点
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(() => {
      (searchButtonRef.current as unknown as { requestTVFocus?: () => void })?.requestTVFocus?.();
    }, 320);
    return () => clearTimeout(timer);
  }, [show]);

  useEffect(() => () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
  }, []);

  // 弹幕源加载完成后，把电视焦点移到定位的那一行（列表已渲染后 hasTVPreferredFocus 不可靠）
  useEffect(() => {
    if (!focusPreviewToken || !Platform.isTV) return;
    const timer = setTimeout(() => {
      (previewSourceRef.current as unknown as { requestTVFocus?: () => void })?.requestTVFocus?.();
    }, 50);
    return () => clearTimeout(timer);
  }, [focusPreviewToken]);

  /**
   * 弹幕源排序与自动匹配的选择顺序一致：年份相同 → 剧名与片源相同 → 原站在前、360 在后
   * → 平台优先级 → 候选排序（集数接近）。360 与原站重复的也显示，平台写成"腾讯（经 360）"区分渠道。
   */
  const arrangeSources = useCallback(
    (loaded: Map<number, DanmakuSource[]>, order: number[]) => {
      const targetYear = Number(year);
      const titleKey = danmakuTitleKey(title);
      const visible = order.flatMap((animeId) => loaded.get(animeId) || []);
      const rank = (source: DanmakuSource) => [
        getDanmakuAnimeYear(source.anime) === targetYear ? 0 : 1,
        danmakuTitleKey(source.anime.animeTitle) === titleKey ? 0 : 1,
        source.isBackup ? 1 : 0,
        getDanmakuPlatformRank(source.platform),
        order.indexOf(source.anime.animeId),
      ];
      return visible
        .map((source, index) => ({ source, index, rank: rank(source) }))
        .sort((a, b) => {
          for (let i = 0; i < a.rank.length; i++) {
            if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
          }
          return a.index - b.index;
        })
        .map((item) => item.source);
    },
    [title, year],
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
      setSources([]);
      try {
        let found = await searchDanmakuAnime(baseUrl, trimmed);
        // 与自动匹配一致：搜不到时把中文间的 II/III 换成 Ⅱ/Ⅲ 再搜
        const fallbackKeyword = romanFallbackKeyword(trimmed);
        if (!found.length && fallbackKeyword !== trimmed) {
          found = await searchDanmakuAnime(baseUrl, fallbackKeyword);
        }
        const animes = sortDanmakuAnimeCandidates(
          found,
          year,
          currentEpisodeCount,
        );
        if (seq !== searchSeq.current) return;
        const memory =
          playbackSource && playbackId
            ? await DanmakuSelectionManager.get(playbackSource, playbackId)
            : null;
        if (seq !== searchSeq.current) return;
        setSaved(memory);
        setSearching(false);
        if (!animes.length) {
          setError("没有找到匹配的弹幕源");
          return;
        }

        // 逐个拉取剧集列表，拉到一个就刷新一次列表
        const order = animes.map((anime) => anime.animeId);
        const loaded = new Map<number, DanmakuSource[]>();
        let next = 0;
        setLoadingSources(true);
        // 定位：手动记住的 → 当前匹配的 → 第一项
        const savedKey =
          memory && memory.version === DANMAKU_SELECTION_VERSION && memory.platform
            ? `${memory.animeId}:${memory.platform}`
            : null;
        const matchKey = currentMatch?.platform ? `${currentMatch.animeId}:${currentMatch.platform}` : null;
        const choosePreview = (list: DanmakuSource[]) =>
          (list.find((source) => source.key === savedKey) ||
            list.find((source) => source.key === matchKey) ||
            list[0])?.key ?? null;
        const worker = async () => {
          while (next < animes.length) {
            const anime = animes[next++];
            try {
              const episodes = await fetchDanmakuBangumiEpisodes(baseUrl, anime.animeId);
              loaded.set(anime.animeId, buildDanmakuSources(anime, episodes));
            } catch {
              loaded.set(anime.animeId, []);
            }
            if (seq !== searchSeq.current) return;
            const list = arrangeSources(loaded, order);
            setSources(list);
            // 加载中先跟着定位规则预览，加载完再最终定位一次
            setPreviewKey(choosePreview(list));
          }
        };
        setPreviewKey(null);
        await Promise.all(Array.from({ length: BANGUMI_CONCURRENCY }, worker));
        if (seq !== searchSeq.current) return;
        const finalList = arrangeSources(loaded, order);
        if (!finalList.length) {
          setError("搜索结果里没有可用的剧集");
          return;
        }
        // 全部加载完：取消焦点触发的预览，定位到目标弹幕源并把电视焦点移过去
        if (previewTimer.current) clearTimeout(previewTimer.current);
        setPreviewKey(choosePreview(finalList));
        setFocusPreviewToken((token) => token + 1);
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setError(err instanceof Error ? err.message : "搜索失败");
      } finally {
        if (seq === searchSeq.current) {
          setSearching(false);
          setLoadingSources(false);
        }
      }
    },
    [arrangeSources, baseUrl, currentEpisodeCount, currentMatch, playbackId, playbackSource, year],
  );

  // 打开时用当前剧名预搜索，TV 上无需输入即可选
  useEffect(() => {
    if (!show) return;
    const initial = title || currentMatch?.animeTitle || "";
    setKeyword(initial);
    if (initial) void runSearch(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  // 当前播放这一条：正片按集号在正片里找，番外（没有集号）按名称在番外里找
  const currentPlaybackTitle = playbackEpisodeTitles?.[currentEpisodeIndex]?.trim() || "";
  const currentNameKey =
    currentEpisodeNumber === null ? danmakuEpisodeNameKey(currentPlaybackTitle, title) : "";
  const currentLabel =
    currentEpisodeNumber !== null ? `第${currentEpisodeNumber}集` : currentNameKey ? `“${currentPlaybackTitle}”` : "";
  const findCurrent = useCallback(
    (source: DanmakuSource): DanmakuSourceEpisode | undefined =>
      currentEpisodeNumber !== null
        ? source.byNumber.get(currentEpisodeNumber)
        : currentNameKey
          ? source.extras.find(
              (episode) => danmakuEpisodeNameKey(episode.episodeTitle, source.anime.animeTitle) === currentNameKey,
            )
          : undefined,
    [currentEpisodeNumber, currentNameKey],
  );

  /** 右栏的当前集：已匹配的那一集，否则按当前这一条找 */
  const isCurrentEpisode = useCallback(
    (source: DanmakuSource, episode: DanmakuSourceEpisode) =>
      currentMatch && currentMatch.animeId === source.anime.animeId && currentMatch.platform === source.platform
        ? currentMatch.episodeId === episode.episodeId
        : findCurrent(source)?.episodeId === episode.episodeId,
    [currentMatch, findCurrent],
  );

  const episodeRows = useMemo<EpisodeRow[]>(() => {
    if (!preview) return [];
    const rows: EpisodeRow[] = preview.main.map((episode) => ({ kind: "episode", episode }));
    if (preview.extras.length) {
      rows.push({ kind: "divider", count: preview.extras.length });
      preview.extras.forEach((episode) => rows.push({ kind: "episode", episode }));
    }
    return rows;
  }, [preview]);

  const currentRowIndex = useMemo(
    () =>
      preview
        ? episodeRows.findIndex((row) => row.kind === "episode" && isCurrentEpisode(preview, row.episode))
        : -1,
    [episodeRows, isCurrentEpisode, preview],
  );

  // 预览的弹幕源变化后滚到当前集
  useEffect(() => {
    if (currentRowIndex < 0) return;
    const timer = setTimeout(() => {
      episodeListRef.current?.scrollToIndex({ index: currentRowIndex, animated: false, viewPosition: 0 });
    }, 80);
    return () => clearTimeout(timer);
  }, [currentRowIndex, previewKey]);

  const schedulePreview = (key: string) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreviewKey(key), PREVIEW_DELAY_MS);
  };

  const apply = async (
    source: DanmakuSource,
    episode: DanmakuSourceEpisode,
    mode: "auto" | "offset",
  ) => {
    if (applyingId !== null) return;
    setApplyingId(episode.episodeId);
    try {
      await loadEpisode(toMatch(source, episode), {
        force: true,
        rememberSelection:
          playbackSource && playbackId
            ? {
                source: playbackSource,
                id: String(playbackId),
                mode,
                playbackEpisodeNumber: currentEpisodeNumber ?? undefined,
              }
            : undefined,
      });
      setShow(false);
    } finally {
      setApplyingId(null);
    }
  };

  /** 左栏确认：只选站点，正片按集号、番外按名称自动对齐 */
  const onSelectSource = (source: DanmakuSource) => {
    setPreviewKey(source.key);
    if (!currentLabel) {
      setError("当前这一条没有集号也没有名称，无法自动对齐，请在右侧指定具体某一集");
      return;
    }
    const episode = findCurrent(source);
    if (!episode) {
      setError(`该弹幕源没有${currentLabel}，可在右侧指定具体某一集`);
      return;
    }
    setError(null);
    void apply(source, episode, "auto");
  };

  /** 删除手动记忆，按自动规则重新匹配当前集，与选弹幕源后一样关闭弹窗 */
  const onResetToAuto = async () => {
    if (resetting || applyingId !== null) return;
    setResetting(true);
    try {
      await resetToAuto();
      setShow(false);
    } finally {
      setResetting(false);
    }
  };

  const onClose = () => setShow(false);
  const isWide = screenWidth >= 700;
  const targetYear = Number(year);

  const statusText = (() => {
    if (!currentMatch) return "当前没有匹配到弹幕";
    const head = `${cleanDanmakuTitle(currentMatch.animeTitle)} · ${getDanmakuPlatformName(currentMatch.platform) || currentMatch.source || ""}${
      currentMatch.episodeNumber ? ` · 第${currentMatch.episodeNumber}集` : ""
    }`;
    const offset =
      matchMode === "manual" &&
      saved?.version === DANMAKU_SELECTION_VERSION &&
      saved.mode === "offset" &&
      saved.animeId === currentMatch.animeId;
    const mode = offset
      ? `固定偏移：播放第${saved?.playbackEpisodeNumber ?? "?"}集 → 弹幕第${saved?.episodeNumber ?? "?"}集`
      : matchMode === "manual"
        ? "手动选择 · 按集号自动对齐"
        : "自动匹配 · 按集号对齐";
    return { head, mode };
  })();

  return (
    <Modal
      isVisible={show}
      statusBarTranslucent
      deviceWidth={screen.width}
      deviceHeight={screen.height}
      onBackButtonPress={onClose}
      onBackdropPress={onClose}
      style={styles.modal}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>手动匹配弹幕</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              选弹幕源即按集号自动对齐；进入剧集可指定具体某一集
            </Text>
          </View>
          {/* TV 用遥控器返回键关闭，不显示关闭按钮 */}
          {!Platform.isTV && (
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
          )}
        </View>

        {/* TextInput 不支持 nextFocusUp，向上只能靠几何查找，会被集列表里滚出可视区的行抢走；
            手动匹配时向上只在状态行和搜索行内查找，落到「恢复自动匹配」 */}
        <TVFocusGuideView trapFocusUp={matchMode === "manual"}>
          <View style={styles.status}>
            <Text style={styles.statusText} numberOfLines={1}>
              {typeof statusText === "string" ? (
                statusText
              ) : (
                <>
                  当前弹幕：<Text style={styles.statusHead}>{statusText.head}</Text>
                  {"　"}
                  <Text style={styles.statusMode}>{statusText.mode}</Text>
                </>
              )}
            </Text>
            {matchMode === "manual" && (
              <Pressable
                ref={resetButtonRef}
                focusable
                nextFocusDown={focusTags.search}
                style={({ focused }) => [styles.resetButton, focused && styles.itemFocused]}
                onPress={() => void onResetToAuto()}
                disabled={resetting || applyingId !== null}
              >
                <Text style={styles.resetButtonText}>{resetting ? "匹配中…" : "恢复自动匹配"}</Text>
              </Pressable>
            )}
          </View>

          {/* TextInput 不支持 nextFocusRight，向右只能靠几何查找；集列表滚动后可视区上方被裁掉的行
              与本行同高且更近，会抢走焦点，所以向右只在本行内查找 */}
          <TVFocusGuideView style={styles.searchRow} trapFocusRight>
            <Pressable
              ref={inputAnchorRef}
              focusable
              nextFocusRight={focusTags.search}
              nextFocusDown={focusTags.previewSource}
              onFocus={() => inputRef.current?.focus()}
              style={styles.inputAnchor}
              accessibilityLabel="搜索关键词输入区"
            >
              <TextInput
                ref={inputRef}
                focusable
                nextFocusRight={focusTags.search}
                nextFocusDown={focusTags.previewSource}
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
              nextFocusUp={matchMode === "manual" ? focusTags.reset : focusTags.close}
              nextFocusDown={focusTags.previewSource}
              style={({ focused }) => [styles.searchButton, focused && styles.searchButtonFocused]}
              hasTVPreferredFocus={!sources.length}
              onPress={() => void runSearch(keyword)}
              disabled={searching}
            >
              {searching ? <ActivityIndicator color="#04150c" size="small" /> : <Search color="#04150c" size={16} />}
              <Text style={styles.searchButtonText}>搜索弹幕源</Text>
            </Pressable>
          </TVFocusGuideView>
        </TVFocusGuideView>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <View style={[styles.columns, !isWide && styles.columnsStacked]}>
          <View style={[styles.column, isWide && styles.sourceColumn]}>
            <Text style={styles.columnHead} numberOfLines={1}>
              弹幕源{loadingSources ? "（加载中…）" : ""}
            </Text>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {sources.map((source) => {
                const isPreview = source.key === previewKey;
                const isCurrent =
                  !!currentMatch &&
                  currentMatch.animeId === source.anime.animeId &&
                  currentMatch.platform === source.platform;
                const yearDiff = getDanmakuAnimeYear(source.anime) !== targetYear;
                const noNumber = !source.main.length;
                const hasCurrent = !!findCurrent(source);
                const sourceYear = getDanmakuAnimeYear(source.anime);
                const meta = [
                  sourceYear ? String(sourceYear) : "年份未知",
                  platformLabel(source),
                  noNumber
                    ? `${source.extras.length} 条`
                    : `正片 ${source.main.length} 集${source.extras.length ? ` + 番外 ${source.extras.length}` : ""}`,
                  !currentLabel
                    ? ""
                    : hasCurrent
                      ? `含${currentLabel}`
                      : currentEpisodeNumber !== null && noNumber
                        ? "不能自动对齐"
                        : `无${currentLabel}`,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <Pressable
                    key={source.key}
                    ref={isPreview ? previewSourceRef : undefined}
                    hasTVPreferredFocus={isPreview && !loadingSources}
                    nextFocusUp={source === sources[0] ? focusTags.inputAnchor : undefined}
                    nextFocusRight={focusTags.entryEpisode}
                    // 加载中列表会重排，焦点落到哪行不代表用户选择，不跟着预览
                    onFocus={() => {
                      if (!loadingSources) schedulePreview(source.key);
                    }}
                    onPress={() => onSelectSource(source)}
                    style={({ focused }) => [
                      styles.sourceItem,
                      isPreview && styles.sourceItemSelected,
                      focused && styles.itemFocused,
                    ]}
                    disabled={applyingId !== null}
                  >
                    {/* 底色作占位：无海报或加载失败时显示 */}
                    <View style={styles.poster}>
                      {!!source.anime.imageUrl && (
                        <Image source={api.getImageProxySource(source.anime.imageUrl)} style={styles.posterImage} />
                      )}
                    </View>
                    <View style={styles.sourceInfo}>
                      <View style={styles.sourceTitleRow}>
                        <Text
                          style={[styles.sourceTitle, (yearDiff || noNumber) && styles.sourceTitleMuted]}
                          numberOfLines={1}
                        >
                          {cleanDanmakuTitle(source.anime.animeTitle)}
                        </Text>
                        {isCurrent && <Text style={[styles.tag, styles.tagCurrent]}>当前</Text>}
                        {yearDiff && <Text style={[styles.tag, styles.tagWarn]}>年份不同</Text>}
                        {noNumber && <Text style={[styles.tag, styles.tagGray]}>无集号</Text>}
                      </View>
                      <Text style={styles.sourceMeta} numberOfLines={1}>
                        {meta}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {!sources.length && !searching && !loadingSources && (
                <Text style={styles.emptyText}>暂无结果</Text>
              )}
              {(searching || (loadingSources && !sources.length)) && (
                <ActivityIndicator color={PRIMARY} style={styles.loading} />
              )}
            </ScrollView>
          </View>

          <View style={styles.column}>
            {!preview ? (
              <Text style={styles.emptyText}>{sources.length ? "请选择左侧弹幕源" : ""}</Text>
            ) : (
              <>
                <Text style={styles.columnHead} numberOfLines={1}>
                  {platformLabel(preview)} · 正片 {preview.main.length} 集
                  {findCurrent(preview) ? ` · 已定位到${currentLabel}` : ""}
                </Text>
                <View style={styles.list}>
                  <FlashList
                    key={preview.key}
                    ref={episodeListRef}
                    data={episodeRows}
                    initialScrollIndex={currentRowIndex >= 0 ? currentRowIndex : undefined}
                    estimatedItemSize={EPISODE_ROW_HEIGHT}
                    drawDistance={500}
                    keyExtractor={(row, index) =>
                      row.kind === "divider" ? `divider-${index}` : `${row.episode.episodeId}-${index}`
                    }
                    getItemType={(row) => row.kind}
                    extraData={`${currentMatch?.episodeId || ""}-${currentEpisodeNumber}-${applyingId || ""}`}
                    contentContainerStyle={styles.flashListContent}
                    renderItem={({ item: row, index }) => {
                      if (row.kind === "divider") {
                        return (
                          <View style={styles.divider}>
                            <Text style={styles.dividerText}>番外 {row.count}（不参与自动对齐）</Text>
                          </View>
                        );
                      }
                      const { episode } = row;
                      const isCurrent = isCurrentEpisode(preview, episode);
                      const applying = applyingId === episode.episodeId;
                      return (
                        <Pressable
                          // 列表打开即定位到当前集，第 0 项未必渲染；焦点从外部进入时落到当前集
                          ref={index === Math.max(0, currentRowIndex) ? entryEpisodeRef : undefined}
                          nextFocusUp={focusTags.search}
                          nextFocusLeft={focusTags.previewSource}
                          onPress={() => void apply(preview, episode, "offset")}
                          style={({ focused }) => [
                            styles.episodeItem,
                            isCurrent && styles.episodeItemCurrent,
                            focused && styles.itemFocused,
                          ]}
                          disabled={applyingId !== null}
                        >
                          {({ focused }) => (
                            <>
                              <Text
                                style={[styles.episodeTitle, episode.number === null && styles.episodeTitleExtra]}
                                numberOfLines={1}
                              >
                                {formatDanmakuEpisodeTitle({
                                  episodeTitle: episode.episodeTitle,
                                  episodeNumber: episode.number,
                                })}
                              </Text>
                              <Text style={styles.episodeAction}>
                                {applying ? "应用中…" : focused ? "固定用这一集" : isCurrent ? "当前集" : ""}
                              </Text>
                            </>
                          )}
                        </Pressable>
                      );
                    }}
                  />
                </View>
              </>
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
    alignItems: "center",
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
  // 副标题与标题同一行（基线对齐），节约标题栏高度
  titleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
  },
  subtitle: {
    flexShrink: 1,
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
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
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  statusText: {
    flex: 1,
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
  },
  // 次要按钮：描边无底色，焦点沿用 itemFocused
  resetButton: {
    height: 24,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
  },
  resetButtonText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 12,
  },
  statusHead: {
    color: "white",
  },
  statusMode: {
    color: PRIMARY,
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
    borderColor: PRIMARY,
  },
  searchButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: 8,
    backgroundColor: PRIMARY,
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
  // 弹幕源一行信息较多，左栏略宽
  sourceColumn: {
    flex: 1.3,
  },
  columnHead: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 11,
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 12,
    gap: 6,
  },
  flashListContent: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 12,
  },
  sourceItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  sourceItemSelected: {
    borderColor: "rgba(0,187,94,0.7)",
    backgroundColor: "rgba(0,187,94,0.12)",
  },
  itemFocused: {
    borderWidth: 2,
    borderColor: PRIMARY,
    backgroundColor: "rgba(0,187,94,0.16)",
  },
  poster: {
    width: 30,
    height: 42,
    borderRadius: 5,
    backgroundColor: "#2b3a41",
    overflow: "hidden",
  },
  posterImage: {
    width: "100%",
    height: "100%",
  },
  sourceInfo: {
    flex: 1,
    minWidth: 0,
  },
  sourceTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  sourceTitle: {
    flexShrink: 1,
    color: "white",
    fontSize: 13,
  },
  sourceTitleMuted: {
    color: "rgba(255,255,255,0.45)",
  },
  sourceMeta: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
    marginTop: 2,
  },
  tag: {
    fontSize: 10,
    lineHeight: 16,
    paddingHorizontal: 5,
    borderRadius: 4,
    overflow: "hidden",
  },
  tagCurrent: {
    color: "#4fe39a",
    backgroundColor: "rgba(0,187,94,0.2)",
  },
  tagGray: {
    color: "rgba(255,255,255,0.6)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  tagWarn: {
    color: "#ffcf66",
    backgroundColor: "rgba(255,207,102,0.15)",
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
    // 固定行高（+ marginBottom 6 = EPISODE_ROW_HEIGHT），保证按索引定位时未渲染行的偏移准确
    height: 38,
    paddingHorizontal: 10,
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
  episodeTitleExtra: {
    color: "rgba(255,255,255,0.6)",
  },
  episodeAction: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
  },
  // 与剧集行同高，保证按索引定位准确
  divider: {
    height: 38,
    marginBottom: 6,
    justifyContent: "flex-end",
    paddingHorizontal: 2,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.16)",
    borderStyle: "dashed",
  },
  dividerText: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 11,
  },
});

export default DanmakuManualMatchModal;
