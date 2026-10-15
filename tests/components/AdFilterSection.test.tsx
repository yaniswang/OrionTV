import * as React from "react";
import { Switch } from "react-native";
import { act, create } from "react-test-renderer";

import { AdFilterSection } from "@/components/settings/AdFilterSection";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

describe("AdFilterSection", () => {
  beforeEach(() => {
    act(() => {
      useSettingsStore.setState({ adFilterEnabled: false });
    });
  });

  it("点整行就能开关，并通知设置已改动", () => {
    const onChanged = jest.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<AdFilterSection onChanged={onChanged} />);
    });

    // 关键点：开关一定要挂上 onPress，否则手机上点不动（只靠遥控器 select 事件）
    const section = tree!.root.findByType(SettingsSection);
    expect(typeof section.props.onPress).toBe("function");

    act(() => {
      section.props.onPress();
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);

    act(() => {
      section.props.onPress();
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("开关只做展示：自己不吃触摸、不改状态，避免和 store 不同步", () => {
    const onChanged = jest.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<AdFilterSection onChanged={onChanged} />);
    });

    const toggle = tree!.root.findByType(Switch);
    // 开关自己不接 onValueChange：原生 Switch 会自己消费触摸并改状态，
    // 一旦它和 store 不同步，就会表现为"点不动 / 关不掉"
    expect(toggle.props.onValueChange).toBeUndefined();
    // 遥控器焦点必须落在整行上，否则确认键只会切到原生开关
    expect(toggle.props.focusable).toBe(false);

    // 整个开关区域都不接收触摸，触摸透传给整行
    const nonTouchable = tree!.root.findAll(
      (node) => node.props?.pointerEvents === "none" && node.type === "View",
    );
    expect(nonTouchable.length).toBeGreaterThan(0);

    // 唯一的状态入口是整行
    const section = tree!.root.findByType(SettingsSection);
    act(() => {
      section.props.onPress();
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
