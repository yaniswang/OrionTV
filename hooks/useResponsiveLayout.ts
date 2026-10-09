import { useState, useEffect } from "react";
import { Dimensions, Platform } from "react-native";

/** mobile：手机布局（竖屏）；tv：大屏布局（TV、平板横屏、手机横屏）。遥控器相关行为另用 Platform.isTV 判断。 */
export type DeviceType = "mobile" | "tv";

export interface ResponsiveConfig {
  deviceType: DeviceType;
  columns: number;
  cardWidth: number;
  cardHeight: number;
  spacing: number;
  isPortrait: boolean;
  screenWidth: number;
  screenHeight: number;
}

/** 大屏卡片占位宽度：VideoCard.tv 的 pressable 宽（海报 160 + 20） */
const TV_CARD_SLOT_WIDTH = 180;

/** 按宽高比例判断：宽大于高用大屏布局，否则用手机布局；TV 始终是大屏布局。 */
export const getDeviceType = (width: number, height: number): DeviceType => {
  if (Platform.isTV) return "tv";
  return width > height ? "tv" : "mobile";
};

export const getLayoutConfig = (
  deviceType: DeviceType,
  width: number,
  height: number,
  isPortrait: boolean
): ResponsiveConfig => {
  const spacing = deviceType === "mobile" ? 8 : 16;

  let columns: number;
  let cardWidth: number;
  let cardHeight: number;

  switch (deviceType) {
    case "mobile":
      columns = isPortrait ? 3 : 4;
      // 使用flex布局，卡片可以更大一些来填充空间
      cardWidth = ((width - spacing) / columns) * 0.85; // 增大到85%
      cardHeight = cardWidth * 1.2; // 5:6 aspect ratio (reduced from 2:3)
      break;

    case "tv":
    default:
      // TV 保持固定 5 列；平板横屏、手机横屏按宽度放下尽量多的列（列表左右各有 spacing + 5 的内边距）
      columns = Platform.isTV
        ? 5
        : Math.max(1, Math.floor((width - spacing * 2 - 10) / TV_CARD_SLOT_WIDTH));
      cardWidth = 160; // Fixed width for TV
      cardHeight = 240; // Fixed height for TV
      break;
  }

  return {
    deviceType,
    columns,
    cardWidth,
    cardHeight,
    spacing,
    isPortrait,
    screenWidth: width,
    screenHeight: height,
  };
};

export const useResponsiveLayout = (): ResponsiveConfig => {
  const [dimensions, setDimensions] = useState(() => {
    const { width, height } = Dimensions.get("window");
    return { width, height };
  });

  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({ window }) => {
      setDimensions({ width: window.width, height: window.height });
    });

    return () => subscription?.remove();
  }, []);

  const { width, height } = dimensions;
  const isPortrait = height > width;
  const deviceType = getDeviceType(width, height);

  return getLayoutConfig(deviceType, width, height, isPortrait);
};

// Utility hook for responsive values
export const useResponsiveValue = <T>(values: { mobile: T; tv: T }): T => {
  const { deviceType } = useResponsiveLayout();
  return values[deviceType];
};

// Utility hook for responsive styles
export const useResponsiveStyles = () => {
  const config = useResponsiveLayout();

  return {
    // Common responsive styles
    container: {
      paddingHorizontal: config.spacing,
    },

    // Card styles
    cardContainer: {
      width: config.cardWidth,
      height: config.cardHeight,
      marginBottom: config.spacing,
    },

    // Grid styles
    gridContainer: {
      paddingHorizontal: config.spacing / 2,
    },

    // Typography
    titleFontSize: config.deviceType === "mobile" ? 18 : 28,
    bodyFontSize: config.deviceType === "mobile" ? 14 : 18,

    // Spacing
    sectionSpacing: config.deviceType === "mobile" ? 16 : 24,
    itemSpacing: config.spacing,
  };
};
