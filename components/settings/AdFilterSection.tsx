import React, { useCallback } from "react";
import { View, Switch, StyleSheet, Animated, Platform, TouchableOpacity } from "react-native";
import { ThemedText } from "@/components/ThemedText";
import { SettingsSection } from "./SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useButtonAnimation } from "@/hooks/useAnimation";
import { Colors } from "@/constants/Colors";

interface AdFilterSectionProps {
  onChanged: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

/** M3U8 广告过滤开关：开启后本地代理在清单里删掉插播广告分块。 */
export const AdFilterSection: React.FC<AdFilterSectionProps> = ({ onChanged, onFocus, onBlur }) => {
  const { adFilterEnabled, setAdFilterEnabled } = useSettingsStore();
  const [isFocused, setIsFocused] = React.useState(false);
  const animationStyle = useButtonAnimation(isFocused, 1.2);

  const applyToggle = useCallback(
    (enabled: boolean) => {
      setAdFilterEnabled(enabled);
      onChanged();
    },
    [setAdFilterEnabled, onChanged]
  );

  // 点整行：SettingsSection 的 Pressable 回调
  const handlePress = useCallback(() => {
    applyToggle(!adFilterEnabled);
  }, [adFilterEnabled, applyToggle]);

  const handleSectionFocus = () => {
    setIsFocused(true);
    onFocus?.();
  };

  const handleSectionBlur = () => {
    setIsFocused(false);
    onBlur?.();
  };

  return (
    <SettingsSection focusable onFocus={handleSectionFocus} onBlur={handleSectionBlur} onPress={handlePress}>
      <View style={styles.settingItem}>
        <View style={styles.settingInfo}>
          <ThemedText style={styles.settingName}>开启广告过滤</ThemedText>
          <ThemedText style={styles.settingDescription}>
            播放时自动跳过插播广告（首次播放需几秒识别）
          </ThemedText>
        </View>
        {/*
          开关只做展示，触摸统一交给整行（SettingsSection 的 Pressable）。
          原生 Switch 会自己消费触摸并在原生侧改状态，一旦它和 store 不同步，
          就会出现"开关点不动 / 关不掉"，所以这里让整个开关区域都不接收触摸。
        */}
        <Animated.View style={animationStyle} pointerEvents="none">
          {Platform.OS === "ios" && Platform.isTV ? (
            <TouchableOpacity activeOpacity={0.8} style={styles.statusLabel}>
              <ThemedText style={styles.statusValue}>{adFilterEnabled ? "已开启" : "已关闭"}</ThemedText>
            </TouchableOpacity>
          ) : (
            <Switch
              value={adFilterEnabled}
              focusable={false}
              trackColor={{ false: "#767577", true: Colors.dark.primary }}
              thumbColor={adFilterEnabled ? "#ffffff" : "#f4f3f4"}
            />
          )}
        </Animated.View>
      </View>
    </SettingsSection>
  );
};

const styles = StyleSheet.create({
  settingItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },
  settingInfo: {
    flex: 1,
  },
  settingName: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 14,
    color: "#888",
  },
  statusLabel: {
    fontSize: 14,
    color: "#ccc",
    minWidth: 80,
  },
  statusValue: {
    fontSize: 14,
  },
});
