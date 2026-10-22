import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  findNodeHandle,
  useTVEventHandler,
  useWindowDimensions,
} from "react-native";
import Modal from "react-native-modal";
import usePlayerStore from "@/stores/playerStore";
import {
  DEFAULT_DANMAKU_SETTINGS,
  useDanmakuStore,
  type DanmakuSettings,
} from "@/stores/danmakuStore";
import { StyledButton } from "./StyledButton";

type RowKey = "density" | "opacity" | "area" | "fontSize" | "speed";
const SLIDER_APPLY_DELAY_MS = 400;
const VISUAL_REFRESH_INTERVAL_MS = 60;

const AREA_LABELS: Record<number, string> = { 25: "1/4", 50: "半屏", 75: "3/4", 100: "满屏" };

const SPEED_LABELS = ["极慢", "较慢", "适中", "较快", "极快"];
const speedIndex = (value: number): number => Math.min(4, Math.max(0, Math.round(value) - 1));
const speedLabel = (value: number): string => SPEED_LABELS[speedIndex(value)];

interface SliderRowProps {
  rowKey: RowKey;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  ticks?: string[];
  focused: boolean;
  hasTVPreferredFocus?: boolean;
  nativeRef?: React.Ref<View>;
  nextFocusUp?: number;
  nextFocusDown?: number;
  verticalPadding: number;
  trackHeight: number;
  onFocus: () => void;
  onChange: (value: number) => void;
}

const SliderRow = ({
  rowKey,
  label,
  value,
  min,
  max,
  step,
  display,
  ticks,
  focused,
  hasTVPreferredFocus,
  nativeRef,
  nextFocusUp,
  nextFocusDown,
  verticalPadding,
  trackHeight,
  onFocus,
  onChange,
}: SliderRowProps) => {
  const trackWidthRef = useRef(0);
  const sliderConfigRef = useRef({ min, max, step, onChange });
  sliderConfigRef.current = { min, max, step, onChange };
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;

  const updateFromTouchX = (locationX: number) => {
    const width = trackWidthRef.current;
    if (width <= 0 || !Number.isFinite(locationX)) return;
    const { min: nextMin, max: nextMax, step: nextStep, onChange: onNextChange } =
      sliderConfigRef.current;
    const ratio = Math.max(0, Math.min(1, locationX / width));
    const raw = nextMin + ratio * (nextMax - nextMin);
    const next = Math.round(raw / nextStep) * nextStep;
    onNextChange(Math.max(nextMin, Math.min(nextMax, next)));
  };

  return (
    <Pressable
      ref={nativeRef}
      focusable
      hasTVPreferredFocus={hasTVPreferredFocus}
      nextFocusUp={nextFocusUp}
      nextFocusDown={nextFocusDown}
      onFocus={onFocus}
      onPress={(event) => {
        // 遥控器没有可靠的 locationX，按一次前进一档，左右键微调
        if (Platform.isTV) {
          onChange(Math.min(max, value + step));
        }
      }}
      style={[
        styles.row,
        { paddingVertical: verticalPadding },
        focused && styles.rowFocused,
      ]}
      testID={`danmaku-row-${rowKey}`}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <View
        style={styles.trackWrap}
      >
        <Pressable
          style={[styles.trackTouchArea, { minHeight: trackHeight }]}
          onLayout={(event) => {
            trackWidthRef.current = event.nativeEvent.layout.width;
          }}
          onPress={(event) => {
            if (!Platform.isTV) {
              updateFromTouchX(event.nativeEvent.locationX);
            }
          }}
        >
          <View style={styles.track}>
            <View style={[styles.trackFill, { width: `${percent}%` }]} />
            <View style={[styles.thumb, { left: `${percent}%` }]} />
          </View>
        </Pressable>
        {ticks && (
          <View style={styles.ticks}>
            {ticks.map((tick) => (
              <Text key={tick} style={styles.tickText}>
                {tick}
              </Text>
            ))}
          </View>
        )}
      </View>
      <Text style={styles.rowValue}>{display}</Text>
    </Pressable>
  );
};

export const DanmakuSettingsModal: React.FC = () => {
  const { height: viewportHeight } = useWindowDimensions();
  const show = usePlayerStore((state) => state.showDanmakuSettingsModal);
  const setShow = usePlayerStore((state) => state.setShowDanmakuSettingsModal);
  const settings = useDanmakuStore((state) => state.settings);
  const updateSettings = useDanmakuStore((state) => state.updateSettings);
  const [draftSettings, setDraftSettings] = useState<DanmakuSettings>(settings);
  const draftSettingsRef = useRef(settings);
  const pendingSettingsRef = useRef<Partial<DanmakuSettings>>({});
  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusedRow, setFocusedRow] = useState<RowKey | null>(null);
  const densityRef = useRef<View>(null);
  const opacityRowRef = useRef<View>(null);
  const areaRowRef = useRef<View>(null);
  const fontSizeRowRef = useRef<View>(null);
  const speedRowRef = useRef<View>(null);
  const resetButtonRef = useRef<View>(null);
  const doneButtonRef = useRef<View>(null);
  const [focusTags, setFocusTags] = useState<{
    density?: number;
    opacity?: number;
    area?: number;
    fontSize?: number;
    speed?: number;
    reset?: number;
    done?: number;
  }>({});
  const focusedRef = useRef<RowKey | null>(null);
  focusedRef.current = focusedRow;

  const flushPendingSettings = useCallback(() => {
    if (applyTimerRef.current) {
      clearTimeout(applyTimerRef.current);
      applyTimerRef.current = null;
    }
    const pending = pendingSettingsRef.current;
    pendingSettingsRef.current = {};
    if (Object.keys(pending).length) {
      updateSettings(pending);
    }
  }, [updateSettings]);

  const onClose = useCallback(() => {
    flushPendingSettings();
    setShow(false);
  }, [flushPendingSettings, setShow]);

  const stageSliderValue = useCallback(
    (patch: Partial<DanmakuSettings>) => {
      const next = { ...draftSettingsRef.current, ...patch };
      draftSettingsRef.current = next;
      if (!visualTimerRef.current) {
        visualTimerRef.current = setTimeout(() => {
          visualTimerRef.current = null;
          setDraftSettings(draftSettingsRef.current);
        }, VISUAL_REFRESH_INTERVAL_MS);
      }
      pendingSettingsRef.current = {
        ...pendingSettingsRef.current,
        ...patch,
      };
      if (applyTimerRef.current) {
        clearTimeout(applyTimerRef.current);
      }
      applyTimerRef.current = setTimeout(() => {
        applyTimerRef.current = null;
        const pending = pendingSettingsRef.current;
        pendingSettingsRef.current = {};
        if (Object.keys(pending).length) {
          updateSettings(pending);
        }
      }, SLIDER_APPLY_DELAY_MS);
    },
    [updateSettings],
  );

  useEffect(() => {
    if (!show) return;
    if (visualTimerRef.current) {
      clearTimeout(visualTimerRef.current);
      visualTimerRef.current = null;
    }
    const current = useDanmakuStore.getState().settings;
    draftSettingsRef.current = current;
    setDraftSettings(current);
    pendingSettingsRef.current = {};
  }, [show]);

  useEffect(() => flushPendingSettings, [flushPendingSettings]);

  useEffect(
    () => () => {
      if (visualTimerRef.current) {
        clearTimeout(visualTimerRef.current);
      }
    },
    [],
  );

  const adjust = useCallback(
    (row: RowKey, direction: number) => {
      const current = draftSettingsRef.current;
      switch (row) {
        case "density": {
          const densities: DanmakuSettings["density"][] = [
            "normal",
            "more",
            "overlap",
          ];
          const density = useDanmakuStore.getState().settings.density;
          const index = Math.max(0, densities.indexOf(density));
          const nextIndex = Math.max(
            0,
            Math.min(densities.length - 1, index + direction),
          );
          if (nextIndex !== index) {
            updateSettings({ density: densities[nextIndex] });
          }
          break;
        }
        case "opacity":
          stageSliderValue({
            opacity: Math.max(
              0.1,
              Math.min(1, Number((current.opacity + direction * 0.05).toFixed(2))),
            ),
          });
          break;
        case "area":
          stageSliderValue({
            area: Math.max(0.25, Math.min(1, current.area + direction * 0.25)),
          });
          break;
        case "fontSize":
          stageSliderValue({
            fontSize: Math.max(12, Math.min(40, current.fontSize + direction)),
          });
          break;
        case "speed":
          stageSliderValue({
            speed: Math.max(1, Math.min(5, current.speed + direction)),
          });
          break;
        default:
          break;
      }
    },
    [stageSliderValue, updateSettings],
  );

  const handleTVEvent = useCallback(
    (event: any) => {
      if (!Platform.isTV || !show || !focusedRef.current) return;
      if (event.eventType === "left") adjust(focusedRef.current, -1);
      if (event.eventType === "right") adjust(focusedRef.current, 1);
    },
    [adjust, show],
  );

  useTVEventHandler(handleTVEvent);

  // 计算密度选项/滑杆的原生 tag，用于显式焦点链
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(() => {
      setFocusTags({
        density: findNodeHandle(densityRef.current) ?? undefined,
        opacity: findNodeHandle(opacityRowRef.current) ?? undefined,
        area: findNodeHandle(areaRowRef.current) ?? undefined,
        fontSize: findNodeHandle(fontSizeRowRef.current) ?? undefined,
        speed: findNodeHandle(speedRowRef.current) ?? undefined,
        reset: findNodeHandle(resetButtonRef.current) ?? undefined,
        done: findNodeHandle(doneButtonRef.current) ?? undefined,
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [show]);

  // 弹窗打开后强制把焦点给弹幕密度
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(() => {
      (densityRef.current as unknown as { requestTVFocus?: () => void })?.requestTVFocus?.();
    }, 320);
    return () => clearTimeout(timer);
  }, [show]);

  const areaValue = Math.round(draftSettings.area * 100);
  const opacityValue = Math.round(draftSettings.opacity * 100);
  const spacingScale = Platform.isTV
    ? 1
    : Math.max(0.3, Math.min(0.6, viewportHeight / 1200));
  const rowGap = Math.max(2, Math.round(8 * spacingScale));
  const sliderVerticalPadding = Math.max(2, Math.round(8 * spacingScale));
  const densityVerticalPadding = Math.max(2, Math.round(6 * spacingScale));
  const contentPadding = Platform.isTV ? 20 : Math.max(10, Math.round(20 * spacingScale));
  const titleMarginBottom = Platform.isTV
    ? 12
    : Math.max(6, Math.round(12 * spacingScale));
  const footerPaddingTop = Platform.isTV
    ? 12
    : Math.max(6, Math.round(12 * spacingScale));
  const trackHeight = Platform.isTV ? 36 : viewportHeight < 500 ? 28 : 32;

  return (
    <Modal
      isVisible={show}
      statusBarTranslucent
      backdropOpacity={0}
      onBackButtonPress={onClose}
      onBackdropPress={onClose}
      onSwipeComplete={onClose}
      swipeDirection="down"
      style={styles.modalContainer}
    >
      <View style={[styles.modalContent, { padding: contentPadding }]}>
        <Text style={[styles.modalTitle, { marginBottom: titleMarginBottom }]}>
          弹幕设置
        </Text>

        <ScrollView
          style={styles.rows}
          contentContainerStyle={[styles.rowsContent, { gap: rowGap }]}
          showsVerticalScrollIndicator={false}
        >
          <View
            style={[
              styles.densityRow,
              { paddingVertical: densityVerticalPadding },
              focusedRow === "density" && styles.densityRowFocused,
            ]}
          >
            <Text style={styles.densityLabel}>弹幕密度</Text>
            <View style={styles.densityOptions}>
              {[
                { value: "normal" as const, label: "正常" },
                { value: "more" as const, label: "较多" },
                { value: "overlap" as const, label: "重叠" },
              ].map((option, index) => {
                const isSelected = (settings.density ?? "more") === option.value;
                return (
                  <Pressable
                    key={option.value}
                    ref={index === 0 ? densityRef : undefined}
                    focusable
                    hasTVPreferredFocus={index === 0}
                    nextFocusDown={focusTags.opacity}
                    onFocus={() => setFocusedRow("density")}
                    onPress={() => updateSettings({ density: option.value })}
                    style={() => [
                      styles.densityOption,
                      isSelected && styles.densityOptionSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.densityOptionText,
                        isSelected && styles.densityOptionTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <SliderRow
            rowKey="opacity"
            label="不透明度"
            value={opacityValue}
            min={10}
            max={100}
            step={5}
            display={`${opacityValue}%`}
            focused={focusedRow === "opacity"}
            nativeRef={opacityRowRef}
            nextFocusUp={focusTags.density}
            nextFocusDown={focusTags.area}
            verticalPadding={sliderVerticalPadding}
            trackHeight={trackHeight}
            onFocus={() => setFocusedRow("opacity")}
            onChange={(value) => stageSliderValue({ opacity: value / 100 })}
          />

          <SliderRow
            rowKey="area"
            label="显示区域"
            value={areaValue}
            min={25}
            max={100}
            step={25}
            display={AREA_LABELS[areaValue] || "1/4"}
            ticks={["1/4", "半屏", "3/4", "满屏"]}
            focused={focusedRow === "area"}
            nativeRef={areaRowRef}
            nextFocusUp={focusTags.opacity}
            nextFocusDown={focusTags.fontSize}
            verticalPadding={sliderVerticalPadding}
            trackHeight={trackHeight}
            onFocus={() => setFocusedRow("area")}
            onChange={(value) => stageSliderValue({ area: value / 100 })}
          />

          <SliderRow
            rowKey="fontSize"
            label="弹幕字号"
            value={draftSettings.fontSize}
            min={12}
            max={40}
            step={1}
            display={`${draftSettings.fontSize}px`}
            focused={focusedRow === "fontSize"}
            nativeRef={fontSizeRowRef}
            nextFocusUp={focusTags.area}
            nextFocusDown={focusTags.speed}
            verticalPadding={sliderVerticalPadding}
            trackHeight={trackHeight}
            onFocus={() => setFocusedRow("fontSize")}
            onChange={(value) => stageSliderValue({ fontSize: value })}
          />

          <SliderRow
            rowKey="speed"
            label="弹幕速度"
            value={draftSettings.speed}
            min={1}
            max={5}
            step={1}
            display={speedLabel(draftSettings.speed)}
            ticks={["极慢", "适中", "极快"]}
            focused={focusedRow === "speed"}
            nativeRef={speedRowRef}
            nextFocusUp={focusTags.fontSize}
            nextFocusDown={focusTags.reset}
            verticalPadding={sliderVerticalPadding}
            trackHeight={trackHeight}
            onFocus={() => setFocusedRow("speed")}
            onChange={(value) => stageSliderValue({ speed: value })}
          />
        </ScrollView>

        <View style={[styles.footer, { paddingTop: footerPaddingTop }]}>
          <StyledButton
            ref={resetButtonRef}
            text="恢复默认"
            nextFocusUp={focusTags.speed}
            nextFocusRight={focusTags.done}
            onFocus={() => setFocusedRow(null)}
            onPress={() => {
              pendingSettingsRef.current = {};
              if (visualTimerRef.current) {
                clearTimeout(visualTimerRef.current);
                visualTimerRef.current = null;
              }
              draftSettingsRef.current = { ...DEFAULT_DANMAKU_SETTINGS };
              setDraftSettings({ ...DEFAULT_DANMAKU_SETTINGS });
              updateSettings({ ...DEFAULT_DANMAKU_SETTINGS });
            }}
            style={styles.footerButton}
            textStyle={styles.footerButtonText}
          />
          <StyledButton
            ref={doneButtonRef}
            text="完成"
            nextFocusUp={focusTags.speed}
            nextFocusLeft={focusTags.reset}
            onFocus={() => setFocusedRow(null)}
            onPress={onClose}
            style={styles.footerButton}
            buttonStyle={styles.primaryButton}
            buttonFocusStyle={styles.primaryButtonFocused}
            textStyle={[styles.footerButtonText, styles.primaryText]}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    margin: 0,
    alignItems: "flex-start",
    zIndex: 1000,
    elevation: 1000,
  },
  modalContent: {
    width: "68%",
    maxWidth: 620,
    height: "100%",
    backgroundColor: "rgba(10, 12, 13, 0.96)",
    padding: 20,
  },
  modalTitle: {
    color: "white",
    textAlign: "center",
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 12,
  },
  rows: {
    flex: 1,
  },
  rowsContent: {
    gap: 10,
    paddingBottom: 8,
  },
  densityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
  },
  densityRowFocused: {
    borderColor: "#00bb5e",
    backgroundColor: "rgba(0,187,94,0.08)",
  },
  densityLabel: {
    color: "white",
    fontSize: 15,
    width: 92,
  },
  densityOptions: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 8,
    padding: 2,
  },
  densityOption: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "transparent",
  },
  densityOptionSelected: {
    backgroundColor: "#00bb5e",
  },
  densityOptionText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
  },
  densityOptionTextSelected: {
    color: "#04150c",
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
    gap: 12,
  },
  rowFocused: {
    borderColor: "#00bb5e",
    backgroundColor: "rgba(0,187,94,0.08)",
  },
  rowLabel: {
    color: "white",
    fontSize: 15,
    width: 92,
  },
  trackWrap: {
    flex: 1,
  },
  trackTouchArea: {
    justifyContent: "center",
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.25)",
    justifyContent: "center",
  },
  trackFill: {
    position: "absolute",
    left: 0,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#00bb5e",
  },
  thumb: {
    position: "absolute",
    width: 18,
    height: 18,
    borderRadius: 9,
    marginLeft: -9,
    backgroundColor: "#00bb5e",
  },
  ticks: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 5,
  },
  tickText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
  },
  rowValue: {
    color: "white",
    fontSize: 15,
    width: 56,
    textAlign: "right",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
  footerButton: {
    minWidth: 110,
    paddingVertical: 10,
  },
  footerButtonText: {
    textAlign: "center",
    fontSize: 15,
  },
  primaryButton: {
    backgroundColor: "#00bb5e",
    borderColor: "#00bb5e",
  },
  primaryButtonFocused: {
    backgroundColor: "#00d96b",
    borderColor: "#00d96b",
    elevation: 6,
    shadowColor: "#00bb5e",
    shadowOpacity: 0.8,
    shadowRadius: 8,
  },
  primaryText: {
    color: "#04150c",
    fontWeight: "bold",
  },
});

export default DanmakuSettingsModal;
