import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useResponsiveLayout } from '@/hooks/useResponsiveLayout';
import MobileTabContainer from './MobileTabContainer';

interface ResponsiveNavigationProps {
  children: React.ReactNode;
}

const ResponsiveNavigation: React.FC<ResponsiveNavigationProps> = ({ children }) => {
  const { deviceType } = useResponsiveLayout();

  switch (deviceType) {
    case 'mobile':
      // 移动端使用Tab容器包装children
      return <MobileTabContainer>{children}</MobileTabContainer>;

    case 'tv':
    default:
      // 只有竖屏（手机布局）有底部导航；横屏和 TV 使用大屏布局，不加导航容器
      return <>{children}</>;
  }
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});

export default ResponsiveNavigation;