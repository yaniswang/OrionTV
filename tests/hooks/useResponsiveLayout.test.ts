/** @jest-environment node */
import { Platform } from "react-native";
import { getDeviceType, getLayoutConfig } from "@/hooks/useResponsiveLayout";

jest.mock("react-native", () => ({
  Dimensions: { get: jest.fn(), addEventListener: jest.fn() },
  Platform: { isTV: false },
}));

const setTV = (isTV: boolean) => {
  (Platform as { isTV: boolean }).isTV = isTV;
};

describe("useResponsiveLayout", () => {
  afterEach(() => setTV(false));

  describe("getDeviceType：按宽高比例判断", () => {
    it("竖屏（手机、平板竖屏）用手机布局", () => {
      expect(getDeviceType(393, 852)).toBe("mobile");
      expect(getDeviceType(800, 1280)).toBe("mobile");
      expect(getDeviceType(834, 1194)).toBe("mobile");
    });

    it("宽高相等用手机布局", () => {
      expect(getDeviceType(600, 600)).toBe("mobile");
    });

    it("横屏（手机横屏、平板横屏）用大屏布局", () => {
      expect(getDeviceType(852, 393)).toBe("tv");
      expect(getDeviceType(1280, 800)).toBe("tv");
    });

    it("TV 始终用大屏布局", () => {
      setTV(true);
      expect(getDeviceType(540, 960)).toBe("tv");
    });
  });

  describe("getLayoutConfig", () => {
    it("手机布局：间距 8，竖屏 3 列等比卡片", () => {
      const config = getLayoutConfig("mobile", 800, 1280, true);
      expect(config.spacing).toBe(8);
      expect(config.columns).toBe(3);
      expect(config.cardWidth).toBeCloseTo(((800 - 8) / 3) * 0.85);
      expect(config.cardHeight).toBeCloseTo(config.cardWidth * 1.2);
    });

    it("大屏布局：卡片固定 160×240，列数按宽度计算", () => {
      expect(getLayoutConfig("tv", 852, 393, false)).toMatchObject({ spacing: 16, columns: 4, cardWidth: 160, cardHeight: 240 });
      expect(getLayoutConfig("tv", 1280, 800, false).columns).toBe(6);
      expect(getLayoutConfig("tv", 1180, 820, false).columns).toBe(6);
    });

    it("TV 保持固定 5 列", () => {
      setTV(true);
      expect(getLayoutConfig("tv", 960, 540, false).columns).toBe(5);
      expect(getLayoutConfig("tv", 1280, 720, false).columns).toBe(5);
    });
  });
});
