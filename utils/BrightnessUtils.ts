/**
 * Android SystemUI 使用 HLG 曲线在系统滑块位置和底层线性亮度之间换算。
 * 参考: frameworks/base/core/java/com/android/internal/display/BrightnessUtils.java
 */

const R = 0.5;
const A = 0.17883277;
const B = 0.28466892;
const C = 0.55991073;
const HLG_MAX = 12;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 底层线性亮度 -> 系统滑块亮度。 */
export function linearToGamma(value: number): number {
  const normalized = clamp(value) * HLG_MAX;
  const result =
    normalized <= 1
      ? Math.sqrt(normalized) * R
      : A * Math.log(normalized - B) + C;
  return clamp(result);
}

/** 系统滑块亮度 -> 底层线性亮度。 */
export function gammaToLinear(value: number): number {
  const normalized = clamp(value);
  const result =
    normalized <= R
      ? Math.pow(normalized / R, 2)
      : Math.exp((normalized - C) / A) + B;
  return clamp(result / HLG_MAX);
}
