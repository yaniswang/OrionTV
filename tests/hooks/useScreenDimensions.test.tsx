import React from "react";
import { Dimensions, type ScaledSize } from "react-native";
import renderer, { act } from "react-test-renderer";
import { useScreenDimensions } from "@/hooks/useScreenDimensions";

const size = (width: number, height: number): ScaledSize => ({
  width,
  height,
  scale: 2.75,
  fontScale: 1,
});

describe("useScreenDimensions", () => {
  let changeListener: ((dims: { window: ScaledSize; screen: ScaledSize }) => void) | null;
  const remove = jest.fn();

  beforeEach(() => {
    changeListener = null;
    remove.mockClear();
    jest.spyOn(Dimensions, "get").mockImplementation((dim) =>
      dim === "screen" ? size(872.7, 392.7) : size(834.9, 392.7),
    );
    jest.spyOn(Dimensions, "addEventListener").mockImplementation((_type, handler) => {
      changeListener = handler as typeof changeListener;
      return { remove } as unknown as ReturnType<typeof Dimensions.addEventListener>;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const render = () => {
    const result: { current: ScaledSize | null } = { current: null };
    const Probe = () => {
      result.current = useScreenDimensions();
      return null;
    };
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Probe />);
    });
    return { result, tree: tree! };
  };

  it("返回屏幕尺寸而不是扣除挖孔后的 window 尺寸", () => {
    const { result } = render();
    expect(result.current?.width).toBe(872.7);
    expect(result.current?.height).toBe(392.7);
  });

  it("屏幕尺寸变化（旋转）时更新，卸载时取消订阅", () => {
    const { result, tree } = render();
    act(() => {
      changeListener?.({ window: size(392.7, 834.9), screen: size(392.7, 872.7) });
    });
    expect(result.current?.width).toBe(392.7);
    expect(result.current?.height).toBe(872.7);
    act(() => tree.unmount());
    expect(remove).toHaveBeenCalled();
  });
});
