import React from "react";
import { View, StyleSheet, Pressable, GestureResponderEvent, LayoutChangeEvent } from "react-native";

interface BottomProgressBarProps {
  progress: number;
  buffered: number;
  /** 传入时进度条可点击跳转；不传则不拦截触摸 */
  onPress?: (event: GestureResponderEvent) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}

/** 贴屏幕最底部的细进度条：锁屏时和加速播放时共用 */
export const BottomProgressBar = ({ progress, buffered, onPress, onLayout }: BottomProgressBarProps) => (
  <View style={styles.container} pointerEvents={onPress ? "box-none" : "none"}>
    <View style={styles.bar}>
      <View style={styles.background} />
      <View style={[styles.buffered, { width: `${buffered * 100}%` }]} />
      <View style={[styles.filled, { width: `${progress * 100}%` }]} />
      {onPress && (
        <Pressable focusable={false} onLayout={onLayout} onPress={onPress} style={styles.touchable} />
      )}
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 0,
    width: "100%",
    justifyContent: "space-between",
  },
  bar: {
    width: "100%",
    height: 8,
    position: "relative",
  },
  background: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 8,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: 4,
  },
  buffered: {
    position: "absolute",
    zIndex: 1,
    left: 0,
    height: 8,
    backgroundColor: "rgba(255,255,255,0.5)",
    borderRadius: 4,
  },
  filled: {
    position: "absolute",
    zIndex: 2,
    left: 0,
    height: 8,
    backgroundColor: "#00bb5e",
    borderRadius: 4,
  },
  touchable: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 30,
    top: -10,
    zIndex: 10,
  },
});
