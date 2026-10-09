import React, { useState, useRef, useEffect } from "react";
import { View, TextInput, StyleSheet, Alert, Keyboard, TouchableOpacity, ActivityIndicator, Pressable, ScrollView } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import VideoCard from "@/components/VideoCard";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import { api, SearchResult } from "@/services/api";
import { SearchHistoryManager } from "@/services/storage";
import { Search, QrCode } from "lucide-react-native";
import { StyledButton } from "@/components/StyledButton";
import { useRemoteControlStore } from "@/stores/remoteControlStore";
import { RemoteControlModal } from "@/components/RemoteControlModal";
import { useSettingsStore } from "@/stores/settingsStore";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/Colors";
import CustomScrollView from "@/components/CustomScrollView";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import Logger from '@/utils/Logger';
import { isTVLongPressRelease } from '@/utils/TVLongPress';

const logger = Logger.withTag('SearchScreen');

export default function SearchScreen() {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const textInputRef = useRef<TextInput>(null);
  const historyLongPressRef = useRef(false);
  const searchControllerRef = useRef<AbortController | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  // 遥控器选中的是外层容器，输入框本身要按 OK 后才获得焦点，两种状态都显示焦点边框
  const [isInputWrapperFocused, setIsInputWrapperFocused] = useState(false);
  const { showModal: showRemoteModal, lastMessage, targetPage, clearMessage } = useRemoteControlStore();
  const { remoteInputEnabled } = useSettingsStore();
  const router = useRouter();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  useEffect(() => {
    if (lastMessage && targetPage === 'search') {
      logger.debug("Received remote input:", lastMessage);
      const realMessage = lastMessage.split("_")[0];
      setKeyword(realMessage);
      handleSearch(realMessage);
      clearMessage(); // Clear the message after processing
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage, targetPage]);

  // 离开搜索页时中断未完成的 WS 搜索
  useEffect(() => {
    return () => {
      searchControllerRef.current?.abort();
      searchControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    SearchHistoryManager.get()
      .then(setSearchHistory)
      .catch((err) => logger.info("Failed to load search history:", err));
  }, []);

  // useEffect(() => {
  //   // Focus the text input when the screen loads
  //   const timer = setTimeout(() => {
  //     textInputRef.current?.focus();
  //   }, 200);
  //   return () => clearTimeout(timer);
  // }, []);

  const handleSearch = async (searchText?: string) => {
    const term = typeof searchText === "string" ? searchText : keyword;
    const trimmedTerm = term.trim();
    if (!trimmedTerm) {
      Keyboard.dismiss();
      return;
    }
    Keyboard.dismiss();

    void SearchHistoryManager.add(trimmedTerm)
      .then(() => SearchHistoryManager.get())
      .then(setSearchHistory)
      .catch((err) => logger.info("Failed to update search history:", err));

    // 取消上一次搜索，避免旧结果混进新结果
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;

    setLoading(true);
    setError(null);
    setResults([]);

    // 聚合搜索：同一个片子聚合成一条，用 source_count 记录有多少个源
    const mapResults = new Map<string, SearchResult>();
    const mergeItems = (items: SearchResult[]) => {
      let changed = false;
      items.forEach((item: any) => {
        const key = `${item.title.replace(' ', '')}-${item.year || 'unknown'}-${item.episodes.length === 1 ? 'movie' : 'tv'}`;
        const existedItem = mapResults.get(key);
        if (existedItem) {
          // 换成新对象，保证列表能感知到源数量的变化
          mapResults.set(key, { ...existedItem, source_count: (existedItem.source_count || 1) + 1 });
        } else {
          // 首个源，聚合后不需要记录具体是哪个源
          delete item['source'];
          delete item['source_name'];
          delete item['id'];
          item['source_count'] = 1;
          mapResults.set(key, item);
        }
        changed = true;
      });
      if (changed && !controller.signal.aborted) {
        setResults([...mapResults.values()].sort((a, b) => (b.source_count || 0) - (a.source_count || 0)));
      }
    };

    try {
      // WS 模式：每个源搜完就实时回调，边搜边展示
      await api.searchVideosWsStream(
        trimmedTerm,
        (message) => {
          if (message.type === 'source_result' && message.results?.length) {
            mergeItems(message.results);
          }
        },
        controller.signal
      );
      if (!controller.signal.aborted && mapResults.size === 0) {
        setError("没有找到相关内容");
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError("搜索失败，请稍后重试。");
      logger.info("Search failed:", err);
    } finally {
      if (searchControllerRef.current === controller) {
        setLoading(false);
      }
    }
  };

  const onSearchPress = () => handleSearch();

  const handleHistoryPress = (historyKeyword: string) => {
    if (historyLongPressRef.current) {
      historyLongPressRef.current = false;
      return;
    }
    setKeyword(historyKeyword);
    handleSearch(historyKeyword);
  };

  const handleHistoryLongPress = (historyKeyword: string, event: unknown) => {
    // TV 松手时会再发一次长按事件：本次长按到此结束，清掉标记以免吞掉下一次点击
    if (isTVLongPressRelease(event)) {
      historyLongPressRef.current = false;
      return;
    }
    historyLongPressRef.current = true;
    Alert.alert("删除搜索历史", `确定要删除"${historyKeyword}"吗？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          try {
            await SearchHistoryManager.remove(historyKeyword);
            setSearchHistory((history) => history.filter((item) => item !== historyKeyword));
          } catch (err) {
            logger.info("Failed to delete search history:", err);
            Alert.alert("错误", "删除搜索历史失败，请重试");
          }
        },
      },
    ]);
  };

  const handleClearSearchHistory = () => {
    Alert.alert("清空搜索历史", "确定要清空全部搜索历史吗？", [
      { text: "取消", style: "cancel" },
      {
        text: "清空",
        style: "destructive",
        onPress: async () => {
          try {
            await SearchHistoryManager.clear();
            setSearchHistory([]);
          } catch (err) {
            logger.info("Failed to clear search history:", err);
            Alert.alert("错误", "清空搜索历史失败，请重试");
          }
        },
      },
    ]);
  };

  const handleQrPress = () => {
    if (!remoteInputEnabled) {
      Alert.alert("远程输入未启用", "请先在设置页面中启用远程输入功能", [
        { text: "取消", style: "cancel" },
        { text: "去设置", onPress: () => router.push("/settings") },
      ]);
      return;
    }
    showRemoteModal('search');
  };

  const renderItem = ({ item }: { item: SearchResult; index: number }) => (
    <VideoCard
      source={item.source}
      q={keyword}
      title={item.title}
      poster={item.poster}
      year={item.year}
      sourceName={item.source_name}
      sourceCount={item.source_count}
      totalEpisodes={item.episodes.length}
      api={api}
    />
  );

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderSearchHistory = () => (
    <ScrollView
      style={dynamicStyles.historyScroll}
      contentContainerStyle={dynamicStyles.historyContainer}
      keyboardShouldPersistTaps="handled"
    >
      <View style={dynamicStyles.historyHeader}>
        <ThemedText style={dynamicStyles.historyTitle}>搜索历史</ThemedText>
        {searchHistory.length > 0 && (
          <Pressable
            onPress={handleClearSearchHistory}
            style={({ focused }) => [
              dynamicStyles.clearHistoryButton,
              focused && dynamicStyles.clearHistoryButtonFocused,
            ]}
          >
            <ThemedText style={dynamicStyles.clearHistoryText}>清空</ThemedText>
          </Pressable>
        )}
      </View>
      {searchHistory.length > 0 ? (
        <View style={dynamicStyles.historyTags}>
          {searchHistory.map((item) => (
            <Pressable
              key={item}
              onPress={() => handleHistoryPress(item)}
              onLongPress={(event) => handleHistoryLongPress(item, event)}
              delayLongPress={deviceType === 'mobile' ? 800 : 1000}
              style={({ focused }) => [
                dynamicStyles.historyTag,
                focused && dynamicStyles.historyTagFocused,
              ]}
            >
              <ThemedText style={dynamicStyles.historyTagText} numberOfLines={1}>{item}</ThemedText>
            </Pressable>
          ))}
        </View>
      ) : (
        <ThemedText style={dynamicStyles.historyEmptyText}>暂无搜索历史</ThemedText>
      )}
    </ScrollView>
  );

  const renderSearchContent = () => (
    <>
      <View style={dynamicStyles.searchContainer}>
        <TouchableOpacity
          activeOpacity={1}
          style={[
            dynamicStyles.inputContainer,
            {
              borderColor: isInputFocused || isInputWrapperFocused ? Colors.dark.primary : "transparent",
            },
          ]}
          onPress={() => textInputRef.current?.focus()}
          onFocus={() => setIsInputWrapperFocused(true)}
          onBlur={() => setIsInputWrapperFocused(false)}
        >
          <TextInput
            ref={textInputRef}
            style={dynamicStyles.input}
            placeholder="搜索电影、剧集..."
            placeholderTextColor="#888"
            value={keyword}
            onChangeText={setKeyword}
            onSubmitEditing={onSearchPress}
            onFocus={() => setIsInputFocused(true)}
            onBlur={() => setIsInputFocused(false)}
            returnKeyType="search"
          />
        </TouchableOpacity>
        <StyledButton style={dynamicStyles.searchButton} onPress={onSearchPress}>
          <Search size={deviceType === 'mobile' ? 20 : 24} color="white" />
        </StyledButton>
        {deviceType !== 'mobile' && (
          <StyledButton style={dynamicStyles.qrButton} onPress={handleQrPress}>
            <QrCode size={deviceType === 'tv' ? 24 : 20} color="white" />
          </StyledButton>
        )}
      </View>

      {loading && results.length === 0 ? (
        <VideoLoadingAnimation showProgressBar={false} />
      ) : error ? (
        <View style={[commonStyles.center, { flex: 1 }]}>
          <ThemedText style={dynamicStyles.errorText}>{error}</ThemedText>
        </View>
      ) : results.length === 0 ? (
        renderSearchHistory()
      ) : (
        <CustomScrollView
          data={results}
          renderItem={renderItem}
          error={error}
          emptyMessage="输入关键词开始搜索"
          ListFooterComponent={loading ? <ActivityIndicator style={{ marginVertical: 20 }} color="#ffffff" /> : null}
        />
      )}
      <RemoteControlModal />
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderSearchContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="搜索" />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
      paddingTop: deviceType === 'tv' ? 50 : 0,
    },
    searchContainer: {
      flexDirection: "row",
      paddingHorizontal: spacing,
      marginBottom: spacing,
      alignItems: "center",
      paddingTop: isMobile ? spacing / 2 : 0,
    },
    inputContainer: {
      flex: 1,
      height: isMobile ? minTouchTarget : 50,
      backgroundColor: Colors.dark.border,
      borderRadius: isMobile ? 8 : 8,
      marginRight: spacing / 2,
      borderWidth: 2,
      borderColor: "transparent",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      paddingHorizontal: spacing,
      color: "white",
      fontSize: isMobile ? 16 : 18,
    },
    searchButton: {
      width: isMobile ? minTouchTarget : 50,
      height: isMobile ? minTouchTarget : 50,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: isMobile ? 8 : 8,
      marginRight: deviceType !== 'mobile' ? spacing / 2 : 0,
    },
    qrButton: {
      width: isMobile ? minTouchTarget : 50,
      height: isMobile ? minTouchTarget : 50,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: isMobile ? 8 : 8,
    },
    historyScroll: {
      flex: 1,
    },
    historyContainer: {
      paddingHorizontal: spacing,
      paddingBottom: spacing,
    },
    historyHeader: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: spacing,
    },
    historyTitle: {
      color: Colors.dark.text,
      fontSize: isMobile ? 18 : 20,
      fontWeight: "600",
    },
    clearHistoryButton: {
      minHeight: 40,
      justifyContent: "center",
      marginLeft: spacing,
      paddingHorizontal: spacing / 2,
      borderRadius: 8,
      borderWidth: 2,
      borderColor: "transparent",
    },
    clearHistoryButtonFocused: {
      borderColor: Colors.dark.primary,
    },
    clearHistoryText: {
      color: Colors.dark.icon,
      fontSize: isMobile ? 14 : 16,
    },
    historyTags: {
      flexDirection: "row",
      flexWrap: "wrap",
    },
    historyTag: {
      minHeight: 40,
      maxWidth: "100%",
      justifyContent: "center",
      marginRight: spacing / 2,
      marginBottom: spacing / 2,
      paddingHorizontal: spacing,
      borderRadius: 20,
      borderWidth: 2,
      borderColor: "transparent",
      backgroundColor: Colors.dark.border,
    },
    historyTagFocused: {
      borderColor: Colors.dark.primary,
    },
    historyTagText: {
      color: Colors.dark.text,
      fontSize: isMobile ? 15 : 16,
    },
    historyEmptyText: {
      color: Colors.dark.icon,
      fontSize: isMobile ? 14 : 16,
    },
    errorText: {
      color: "red",
      fontSize: isMobile ? 14 : 16,
      textAlign: "center",
    },
  });
};
