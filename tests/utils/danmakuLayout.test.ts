import {
  DANMAKU_MIN_SAFE_GAP,
  buildDanmakuSecondBuckets,
  estimateDanmakuWidth,
  getBilibiliDanmakuDurationSec,
  getDanmakuBaseSpeed,
  getDanmakuCatchLeft,
  getDanmakuLeftAtTime,
  getDanmakuSafeGap,
  getDanmakuSpawnGap,
  getDanmakuTravelSpeed,
  getDanmakuTrackCount,
  getDanmakuVisualLane,
  takeRandomDanmaku,
  willDanmakuCollide,
} from "@/utils/danmakuLayout";

describe("秒桶弹幕调度参数", () => {
  it("按密度生成固定间距区间", () => {
    expect(getDanmakuSpawnGap("normal", () => 0)).toBe(90);
    expect(getDanmakuSpawnGap("normal", () => 1)).toBe(190);
    expect(getDanmakuSpawnGap("more", () => 0)).toBe(30);
    expect(getDanmakuSpawnGap("more", () => 1)).toBe(50);
  });

  it("按文本宽度计算移动速度", () => {
    expect(getDanmakuBaseSpeed(0)).toBe(67.5);
    expect(getDanmakuBaseSpeed(100)).toBe(82.5);
    expect(getDanmakuBaseSpeed(300)).toBeGreaterThan(
      getDanmakuBaseSpeed(250),
    );
    expect(getDanmakuBaseSpeed(500)).toBe(142.5);
    expect(getDanmakuBaseSpeed(1000)).toBe(180);
  });

  it("根据前后速度差计算不会追尾的插入点", () => {
    expect(getDanmakuCatchLeft(500, 200, 100, 120, 100)).toBe(940);
    expect(getDanmakuCatchLeft(700, 300, 100, 120, 100)).toBe(1300);
  });
});

describe("danmakuLayout", () => {
  it("只有重叠模式启用双泳道", () => {
    expect(getDanmakuTrackCount(5, "normal")).toBe(5);
    expect(getDanmakuTrackCount(5, "more")).toBe(5);
    expect(getDanmakuTrackCount(5, "overlap")).toBe(10);
    expect(getDanmakuVisualLane(0, "overlap")).toBe(0);
    expect(getDanmakuVisualLane(1, "overlap")).toBe(0);
    expect(getDanmakuSafeGap("normal")).toBeGreaterThan(
      getDanmakuSafeGap("more"),
    );
    expect(getDanmakuSafeGap("more")).toBe(DANMAKU_MIN_SAFE_GAP);
  });

  it("按整秒建立弹幕桶", () => {
    const comments = [
      { time: 0.2, text: "A" },
      { time: 1.1, text: "B" },
      { time: 1.9, text: "C" },
      { time: 3.2, text: "D" },
    ];
    const buckets = buildDanmakuSecondBuckets(comments, 3);
    expect(buckets[0]?.map((item) => item.text)).toEqual(["A"]);
    expect(buckets[1]?.map((item) => item.text)).toEqual(["B", "C"]);
    expect(buckets[2]).toBeUndefined();
    expect(buckets[3]?.map((item) => item.text)).toEqual(["D"]);
  });

  it("随机删除只影响活动桶副本", () => {
    const source = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const active = source.slice();
    const selected = takeRandomDanmaku(active, () => 0);
    expect(selected).toEqual({ id: 1 });
    expect(active).toHaveLength(2);
    expect(source).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("为宽字符估算足够的安全宽度", () => {
    expect(estimateDanmakuWidth("WWWWW", 25)).toBeGreaterThan(125);
    expect(estimateDanmakuWidth("弹幕测试", 25)).toBeGreaterThan(100);
  });

  it("按播放时间计算滚动弹幕位置", () => {
    expect(getDanmakuLeftAtTime(1000, 200, 5, 0)).toBe(1000);
    expect(getDanmakuLeftAtTime(1000, 200, 5, 2.5)).toBe(360);
    expect(getDanmakuTravelSpeed(1000, 200, 5)).toBe(256);
  });

  it("按B站物理像素公式计算基础时长", () => {
    expect(getBilibiliDanmakuDurationSec(682)).toBe(4);
    expect(getBilibiliDanmakuDurationSec(1920)).toBe(9);
    expect(getBilibiliDanmakuDurationSec(1920, 0.85)).toBeCloseTo(7.65);
    expect(getBilibiliDanmakuDurationSec(320)).toBe(4);
  });

  it("识别后发宽弹幕在运动途中追尾", () => {
    expect(
      willDanmakuCollide({
        screenWidth: 1280,
        newWidth: 500,
        newDurationSec: 5,
        existing: {
          width: 100,
          startWall: 0,
          durationSec: 5,
        },
        nowWall: 500,
      }),
    ).toBe(true);
  });

  it("已有弹幕远离右侧时允许进入同一泳道", () => {
    expect(
      willDanmakuCollide({
        screenWidth: 1280,
        newWidth: 180,
        newDurationSec: 5,
        existing: {
          width: 180,
          startWall: 0,
          durationSec: 5,
        },
        nowWall: 3500,
      }),
    ).toBe(false);
  });
});
