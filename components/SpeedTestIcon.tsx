import React, { useEffect, useRef } from "react";
import { Animated } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

interface SpeedTestIconProps {
  size?: number;
  color?: string;
}

/** 正在测速的源：脉冲的测速表图标 */
export const SpeedTestIcon: React.FC<SpeedTestIconProps> = ({ size = 12, color = "#ffd166" }) => {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 450, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 450, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={{
        marginLeft: 8,
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) }],
      }}
    >
      <MaterialCommunityIcons name="speedometer" size={size} color={color} />
    </Animated.View>
  );
};
