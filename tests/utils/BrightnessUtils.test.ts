import { gammaToLinear, linearToGamma } from '@/utils/BrightnessUtils';

describe('BrightnessUtils', () => {
  it('把系统底层亮度转换为接近系统滑块的亮度', () => {
    expect(linearToGamma(29 / 255)).toBeCloseTo(0.5737, 4);
    expect(linearToGamma(0.109873734)).toBeCloseTo(0.5659, 4);
  });

  it('把系统滑块亮度转换回底层线性亮度', () => {
    expect(gammaToLinear(0.7)).toBeCloseTo(0.2061, 4);
    expect(gammaToLinear(linearToGamma(29 / 255))).toBeCloseTo(29 / 255, 6);
  });
});
