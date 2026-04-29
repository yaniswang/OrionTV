import React, { useCallback, useRef, useState, useEffect, ReactElement } from "react";
import { View, StyleSheet, ActivityIndicator, TouchableOpacity, BackHandler, Platform, useWindowDimensions, InteractionManager } from "react-native";
import { ThemedText } from "@/components/ThemedText";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import { FlashList } from "@shopify/flash-list";

interface CustomScrollViewProps {
  data: any[];
  renderItem: ({ item, index }: { item: unknown; index: number }) => ReactElement;
  numColumns?: number; // 如果不提供，将使用响应式默认值
  loading?: boolean;
  loadingMore?: boolean;
  error?: string | null;
  onEndReached?: () => void;
  loadMoreThreshold?: number;
  emptyMessage?: string;
  ListFooterComponent?: React.ComponentType<any> | React.ReactElement | null;
}

const CustomScrollView: React.FC<CustomScrollViewProps> = ({
  data,
  renderItem,
  numColumns,
  loading = false,
  loadingMore = false,
  error = null,
  onEndReached,
  loadMoreThreshold = 200,
  emptyMessage = "暂无内容",
  ListFooterComponent,
}) => {
  const scrollViewRef = useRef<any>(null);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const { width, height } = useWindowDimensions();
  const [isRotating, setIsRotating] = useState(false);
  const lastOrientation = useRef<any>('');
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType } = responsiveConfig;

  const orientation = width > height ? 'landscape' : 'portrait';

  useEffect(() => {
    if (lastOrientation.current !== '') {
      // 首次不等待,二次才等待旋转
      lastOrientation.current = orientation;
      setIsRotating(true);
    
      // 主动探测：等待所有原生动画（旋转、转场等）结束
      const task = InteractionManager.runAfterInteractions(() => {
        requestAnimationFrame(() => {
          setIsRotating(false);
        });
      });
    
      return () => task.cancel();
    }
  }, [orientation]); 

  // 添加返回键处理逻辑
  useEffect(() => {
    if (deviceType === 'tv') {
      const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
        if (showScrollToTop) {
          scrollToTop();
          return true; // 阻止默认的返回行为
        }
        return false; // 允许默认的返回行为
      });

      return () => backHandler.remove();
    }
  }, [showScrollToTop,deviceType]);

  // 使用响应式列数，如果没有明确指定的话
  const effectiveColumns = numColumns || responsiveConfig.columns;

  const handleScroll = useCallback(
    ({ nativeEvent }: { nativeEvent: any }) => {
      const offsetY = nativeEvent.contentOffset.y;
      // 显示/隐藏返回顶部按钮
      setShowScrollToTop(offsetY> 200);
    },
    []
  );

  const scrollToTop = () => {
    scrollViewRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  const renderFooter = () => {
    if (ListFooterComponent) {
      if (React.isValidElement(ListFooterComponent)) {
        return ListFooterComponent;
      } else if (typeof ListFooterComponent === "function") {
        const Component = ListFooterComponent as React.ComponentType<any>;
        return <Component />;
      }
      return null;
    }
    if (loadingMore) {
      return <ActivityIndicator style={{ marginVertical: 20 }} size="large" />;
    }
    return null;
  };

  const renderEmpty = () => {
    return (
      <View style={commonStyles.center}>
        <ThemedText>{emptyMessage}</ThemedText>
      </View>
    )
  }

  if (loading) {
    return (
      <View style={commonStyles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={commonStyles.center}>
        <ThemedText type="subtitle" style={{ padding: responsiveConfig.spacing }}>
          {error}
        </ThemedText>
      </View>
    );
  }

  if (data.length === 0) {
    return (
      <View style={commonStyles.center}>
        <ThemedText>{emptyMessage}</ThemedText>
      </View>
    );
  }
  
  // 动态样式
  const dynamicStyles = StyleSheet.create({
    listContent: {
      flex: 1,
      backgroundColor: '#000000',
      opacity: 1
    },
    itemWithMargin: {
      width: responsiveConfig.cardWidth,
      marginRight: responsiveConfig.spacing,
    },
    scrollToTopButton: {
      position: 'absolute',
      right: responsiveConfig.spacing,
      bottom: responsiveConfig.spacing * 2,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      padding: responsiveConfig.spacing,
      borderRadius: responsiveConfig.spacing,
      opacity: showScrollToTop ? 1 : 0,
    },
  });

  if (isRotating) return <View style={{ flex: 1 }} />;

  return (
    <View style={dynamicStyles.listContent} renderToHardwareTextureAndroid={false}>
      <FlashList
        ref={scrollViewRef}
        data={data}
        refreshing={loading}
        numColumns={effectiveColumns}
        estimatedItemSize={300}
        renderItem={renderItem}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={renderEmpty}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        onScroll={handleScroll}
        disableAutoLayout={true}
        removeClippedSubviews={false}
        contentContainerStyle={{ padding: 5 }}
      />
      {!Platform.isTV && (
        <TouchableOpacity
          style={dynamicStyles.scrollToTopButton}
          onPress={scrollToTop}
          activeOpacity={0.8}
        >
          <ThemedText>⬆️</ThemedText>
        </TouchableOpacity>
      )}
    </View>
  );
};

export default CustomScrollView;
