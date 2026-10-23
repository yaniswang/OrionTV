import {
  DANMAKU_MIN_SAFE_GAP,
  buildDanmakuSecondBuckets,
  estimateDanmakuWidth,
  getBilibiliDanmakuDurationSec,
  getDanmakuBaseSpeed,
  getDanmakuCatchLeft,
  getDanmakuJumpWindowSec,
  getDanmakuLeftAtTime,
  getDanmakuSafeGap,
  getDanmakuSpawnGap,
  getDanmakuTravelSpeed,
  getDanmakuTrackCount,
  getDanmakuVisualLane,
  planDanmakuPrefill,
  takeRandomDanmaku,
  willDanmakuCollide,
} from "@/utils/danmakuLayout";

describe("时间线窗口", () => {
  const slowest = getDanmakuBaseSpeed(0);

  it("1 倍速：最慢弹幕横穿屏幕的时长", () => {
    expect(getDanmakuJumpWindowSec(960, 1, 1)).toBeCloseTo(960 / slowest);
  });

  it("按播放倍速换算成视频时间", () => {
    expect(getDanmakuJumpWindowSec(960, 1, 8)).toBeCloseTo((960 / slowest) * 8);
  });

  it("弹幕调速越快窗口越短", () => {
    expect(getDanmakuJumpWindowSec(960, 2, 1)).toBeCloseTo(960 / slowest / 2);
  });

  it("倍速异常时按 1 倍速处理", () => {
    expect(getDanmakuJumpWindowSec(960, 1, 0)).toBeCloseTo(960 / slowest);
  });
});

describe("SEEK 后铺满泳道", () => {
  const plan = (
    candidates: { id: string; time: number; width: number; speed: number }[],
    laneCount = 1,
    gap = 10,
    random: () => number = () => 0,
  ) =>
    planDanmakuPrefill({
      screenWidth: 1000,
      positionSec: 20,
      candidates,
      laneCount,
      getGap: () => gap,
      random,
    });

  it("按弹幕时间与速度反推当前左端坐标", () => {
    // 提前 10 秒、速度 100：从右边缘 1000 走了 1000，正好在 x=0
    expect(plan([{ id: "a", time: 10, width: 100, speed: 100 }])).toEqual([
      { lane: 0, left: 0, item: { id: "a", time: 10, width: 100, speed: 100 } },
    ]);
    expect(plan([{ id: "b", time: 18, width: 100, speed: 100 }])[0].left).toBe(800);
  });

  it("左端小于 0 或尚未到时间的弹幕不放入", () => {
    expect(
      plan([
        { id: "early", time: 9.9, width: 100, speed: 100 },
        { id: "future", time: 20, width: 100, speed: 100 },
        { id: "later", time: 20.5, width: 100, speed: 100 },
      ]),
    ).toEqual([]);
  });

  it("同泳道按左端从小到大排列且保持间距", () => {
    const result = plan([
      { id: "c", time: 15, width: 100, speed: 100 },
      { id: "a", time: 10, width: 100, speed: 100 },
      // 左端 50，与 a(0~100) 重叠，单泳道时放不下
      { id: "overlap", time: 10.5, width: 100, speed: 100 },
    ]);
    expect(result.map((p) => [p.item.id, p.left])).toEqual([
      ["a", 0],
      ["c", 500],
    ]);
  });

  it("冲突的弹幕放入下一个泳道", () => {
    const result = plan(
      [
        { id: "a", time: 10, width: 100, speed: 100 },
        { id: "b", time: 10.5, width: 100, speed: 100 },
      ],
      2,
    );
    expect(result.map((p) => [p.item.id, p.lane, p.left])).toEqual([
      ["a", 0, 0],
      ["b", 1, 50],
    ]);
  });

  it("在所有放得下的泳道中随机挑选，避免从上到下排成阶梯", () => {
    const candidates = [{ id: "a", time: 10, width: 100, speed: 100 }];
    expect(plan(candidates, 3, 10, () => 0)[0].lane).toBe(0);
    expect(plan(candidates, 3, 10, () => 0.5)[0].lane).toBe(1);
    expect(plan(candidates, 3, 10, () => 0.99)[0].lane).toBe(2);
    // a 占用第 2 道后，与之重叠的 b 只能在剩余两道里选
    const result = plan(
      [
        { id: "a", time: 10, width: 100, speed: 100 },
        { id: "b", time: 10.5, width: 100, speed: 100 },
      ],
      3,
      10,
      () => 0.99,
    );
    expect(result.map((p) => [p.item.id, p.lane])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("后面更快的弹幕会在前一条离场前追尾时不放入", () => {
    // a 尾部需 1 秒离场；b 速度 400、左端 300，1 秒后已越过左边缘追上 a
    const result = plan([
      { id: "a", time: 10, width: 100, speed: 100 },
      { id: "b", time: 18.25, width: 100, speed: 400 },
    ]);
    expect(result.map((p) => p.item.id)).toEqual(["a"]);
  });

  it("弹幕不足时对应位置留空", () => {
    const result = plan([{ id: "only", time: 19, width: 100, speed: 100 }], 3);
    expect(result).toHaveLength(1);
    expect(result[0].left).toBe(900);
  });
});

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
