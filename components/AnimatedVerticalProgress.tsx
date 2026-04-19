import React, { useRef, useEffect, useState } from 'react';
import { View, Animated } from 'react-native';

export const AnimatedVerticalProgress = ({ progress, forceShow }) => {
  if (progress == -1) {
    return null;
  }
  const animatedHeight = useRef(new Animated.Value(progress * 100)).current;
  const showTimer = useRef<NodeJS.Timeout | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (forceShow == -1) {
      return;
    }
    Animated.timing(animatedHeight, {
        toValue: progress * 100, // 对应高度百分比
        duration: 500,
        useNativeDriver: false, // 布局属性高度不支持原生驱动
      }).start();
    setIsVisible(true);
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setIsVisible(false), 1000);
    return () => {
      if (showTimer.current) clearTimeout(showTimer.current);
    }
  }, [progress, forceShow]);

  return (
    <View style={{ opacity: forceShow && isVisible ? 1 : 0, width: 15, height: 150, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 8, justifyContent: 'flex-end' }}>
      <Animated.View style={{
        width: '100%',
        borderRadius: 8,
        backgroundColor: '#ffffff',
        height: animatedHeight.interpolate({
          inputRange: [0, 100],
          outputRange: ['0%', '100%']
        })
      }} />
    </View>
  );
};