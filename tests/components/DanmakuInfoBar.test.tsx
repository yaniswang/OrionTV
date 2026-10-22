jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import React from "react";
import { Text } from "react-native";
import renderer, { act } from "react-test-renderer";
import { DanmakuInfoBar } from "@/components/DanmakuInfoBar";
import { useDanmakuStore } from "@/stores/danmakuStore";
import { useSettingsStore } from "@/stores/settingsStore";

const collectText = (tree: renderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(Text).map((node) => String(node.props.children));

describe("DanmakuInfoBar", () => {
  beforeEach(() => {
    useDanmakuStore.setState({
      enabled: true,
      comments: [],
      loading: false,
      error: null,
      match: null,
      matchMode: null,
      loadedAt: null,
    });
    useSettingsStore.setState({ danmakuApiUrl: "" });
  });

  it("未配置弹幕API时显示提示", () => {
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<DanmakuInfoBar />);
    });
    expect(collectText(tree!)).toContain("未配置弹幕API");
    act(() => tree!.unmount());
  });

  it("弹幕关闭时整块信息区不渲染", () => {
    useDanmakuStore.setState({ enabled: false });
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<DanmakuInfoBar />);
    });
    expect(tree!.toJSON()).toBeNull();
    act(() => tree!.unmount());
  });

  it("加载完成后显示弹幕条数", () => {
    useDanmakuStore.setState({
      comments: [{ time: 1, text: "a", color: "#ffffff", mode: 1 }],
      match: {
        episodeId: 1,
        animeId: 2,
        animeTitle: "庆余年第二季(2024)【电视剧】from 360",
        episodeTitle: "【qq】 第12集",
        episodeNumber: 12,
        source: "360",
      },
      matchMode: "auto",
    });
    useSettingsStore.setState({ danmakuApiUrl: "https://danmu.example.com" });
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<DanmakuInfoBar />);
    });
    expect(collectText(tree!)).toContain("弹幕 1 条 · 360");
    act(() => {
      tree!.root
        .findByProps({ accessibilityLabel: "查看弹幕加载详情" })
        .props.onPress();
    });
    expect(collectText(tree!)).toContain("来源平台");
    expect(collectText(tree!)).toContain("360");
    expect(collectText(tree!)).toContain("庆余年第二季 · 第12集");
    expect(collectText(tree!)).toContain("自动匹配");
    act(() => {
      useDanmakuStore.setState({ matchMode: "manual" });
    });
    expect(collectText(tree!)).toContain("手动匹配");
    expect(collectText(tree!)).not.toContain("数据来源");
    expect(collectText(tree!)).not.toContain("网络");
    act(() => tree!.unmount());
  });
});
