import { useEffect, useState } from "react";
import { Dimensions, type ScaledSize } from "react-native";

/**
 * 屏幕尺寸。安卓沉浸式横屏有挖孔时，window 尺寸会扣除挖孔区域，
 * 需要铺满整个屏幕的元素（如 react-native-modal 的遮罩）应使用 screen 尺寸。
 */
export const useScreenDimensions = (): ScaledSize => {
  const [screen, setScreen] = useState(() => Dimensions.get("screen"));

  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({ screen: next }) => {
      setScreen(next);
    });
    return () => subscription.remove();
  }, []);

  return screen;
};
