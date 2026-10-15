import * as React from "react";
import { Switch } from "react-native";
import { act, create } from "react-test-renderer";

import { AdFilterSection } from "@/components/settings/AdFilterSection";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";

// 捕获组件注册的电视遥控器处理函数，模拟遥控器确认键
var tvEventHandler: ((event: { eventType: string }) => void) | null = null;
jest.mock("react-native/Libraries/Components/TV/useTVEventHandler", () => {
  return (handler: (event: { eventType: string }) => void) => {
    tvEventHandler = handler;
  };
});

// 焦点动画用的是 Animated.spring，会在测试结束后继续跑定时器；本用例只关心开关逻辑
jest.mock("@/hooks/useAnimation", () => ({
  useButtonAnimation: () => ({ transform: [{ scale: 1 }] }),
}));

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

  it("开关只做展示：触摸走整行，开关自身不接收触摸也不改状态", () => {
    const onChanged = jest.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<AdFilterSection onChanged={onChanged} />);
    });

    const toggle = tree!.root.findByType(Switch);
    // 开关自己不处理交互（和"启用远程输入"一致），避免原生开关和 store 不同步
    expect(toggle.props.pointerEvents).toBe("none");
    act(() => {
      toggle.props.onValueChange(true);
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(false);

    // 整个开关区域也不接收触摸，触摸透传给整行
    const nonTouchable = tree!.root.findAll(
      (node) => node.props?.pointerEvents === "none" && node.type === "View",
    );
    expect(nonTouchable.length).toBeGreaterThan(0);

    // 手机：点整行切换
    const section = tree!.root.findByType(SettingsSection);
    act(() => {
      section.props.onPress();
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("电视：整行获得焦点后按确认键（select 事件）能开关", () => {
    const onChanged = jest.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<AdFilterSection onChanged={onChanged} />);
    });
    const section = tree!.root.findByType(SettingsSection);

    // 整行没焦点时不响应遥控器
    act(() => {
      tvEventHandler?.({ eventType: "select" });
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(false);

    // 整行获得焦点后，确认键切换
    act(() => {
      section.props.onFocus();
    });
    act(() => {
      tvEventHandler?.({ eventType: "select" });
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);

    act(() => {
      tvEventHandler?.({ eventType: "select" });
    });
    expect(useSettingsStore.getState().adFilterEnabled).toBe(false);
  });
});
