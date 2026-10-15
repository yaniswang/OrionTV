import React, { useCallback } from "react";
import { View, Switch, StyleSheet, Animated, Platform, TouchableOpacity, useTVEventHandler } from "react-native";
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

  // 电视遥控器：和"启用远程输入"同一套做法——整行获得焦点后按确认键发的是 select 事件，
  // Pressable 的 onPress 在电视上不触发，必须在这里处理。
  const handleTVEvent = useCallback(
    (event: any) => {
      if (isFocused && event.eventType === "select") {
        applyToggle(!adFilterEnabled);
      }
    },
    [isFocused, adFilterEnabled, applyToggle]
  );
  useTVEventHandler(handleTVEvent);

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
          开关只做展示：触摸和遥控器都交给整行，避免原生 Switch 自己改状态后和 store 不同步
          （表现为"点不动 / 关不掉"）。做法和"启用远程输入"一致。
        */}
        <Animated.View style={animationStyle} pointerEvents="none">
          {Platform.OS === "ios" && Platform.isTV ? (
            <TouchableOpacity activeOpacity={0.8} style={styles.statusLabel}>
              <ThemedText style={styles.statusValue}>{adFilterEnabled ? "已开启" : "已关闭"}</ThemedText>
            </TouchableOpacity>
          ) : (
            <Switch
              value={adFilterEnabled}
              onValueChange={() => { }} // 禁用 Switch 的直接交互
              pointerEvents="none"
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
