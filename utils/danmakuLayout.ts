/**
 * 弹幕时间、速度与碰撞算法参考 DanmakuFlameMaster。
 * Copyright (C) 2013-2015 Chen Hui <calmer91@gmail.com>
 * Licensed under the Apache License, Version 2.0.
 */
export type DanmakuDensity = "normal" | "more" | "overlap";

export const DANMAKU_EXIT_PADDING = 80;
export const DANMAKU_MIN_SAFE_GAP = 4;
const DANMAKU_NORMAL_SAFE_GAP = 80;
const BILIBILI_PLAYER_WIDTH = 682;
const BILIBILI_BASE_DURATION_MS = 3800;
const BILIBILI_MIN_DURATION_MS = 4000;
const BILIBILI_MAX_DURATION_MS = 9000;
const DANMAKU_MAX_SPEED = 180;

export interface DanmakuTrackTiming {
  width: number;
  startWall: number;
  durationSec: number;
}

export interface TimedDanmaku {
  time: number;
}

/** 按整秒建立弹幕桶；没有弹幕的秒保持为空。 */
export const buildDanmakuSecondBuckets = <T extends TimedDanmaku>(
  items: T[],
  durationSec: number,
): (T[] | undefined)[] => {
  const lastSecond = items.length
    ? Math.max(0, Math.floor(items[items.length - 1].time))
    : 0;
  const bucketCount = Math.max(0, Math.ceil(durationSec), lastSecond) + 1;
  const buckets = new Array<T[] | undefined>(bucketCount);
  items.forEach((item) => {
    const second = Math.max(0, Math.floor(item.time));
    (buckets[second] ??= []).push(item);
  });
  return buckets;
};

/** 从当前活动桶删除指定位置，使用交换后 pop 保持 O(1)。 */
export const takeDanmakuAt = <T>(items: T[], index: number): T | null => {
  if (index < 0 || index >= items.length) return null;
  const selected = items[index];
  items[index] = items[items.length - 1];
  items.pop();
  return selected;
};

/** 随机取一条并从当前活动桶删除。 */
export const takeRandomDanmaku = <T>(
  items: T[],
  random: () => number = Math.random,
): T | null => {
  if (!items.length) return null;
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  return takeDanmakuAt(items, index);
};

export const getDanmakuTrackCount = (
  rows: number,
  density: DanmakuDensity,
): number => (density === "overlap" ? rows * 2 : rows);

export const getDanmakuSafeGap = (
  density: DanmakuDensity,
): number => (density === "normal" ? DANMAKU_NORMAL_SAFE_GAP : DANMAKU_MIN_SAFE_GAP);

export const getDanmakuVisualLane = (
  track: number,
  density: DanmakuDensity,
): number => (density === "overlap" ? Math.floor(track / 2) : track);

/** 与 HTML 测试页一致的固定间距 + 随机间距 */
export const getDanmakuSpawnGap = (
  density: DanmakuDensity,
  random: () => number = Math.random,
): number => {
  if (density === "normal") {
    return 40 + 50 + random() * 100;
  }
  return 20 + 10 + random() * 20;
};

/** 文字越长，基础移动速度越快 */
export const getDanmakuBaseSpeed = (textWidth: number): number =>
  Math.min(DANMAKU_MAX_SPEED, 67.5 + textWidth * 0.15);

/**
 * 时间线窗口（视频秒）：最慢弹幕横穿屏幕期间视频播过的时长。
 * 屏上弹幕本来就分布在这段视频时间里，进度偏差不超过它就不清屏；也是预铺的回看范围。
 */
export const getDanmakuJumpWindowSec = (
  screenWidth: number,
  speedFactor: number,
  playbackRate: number,
): number =>
  (screenWidth / (getDanmakuBaseSpeed(0) * speedFactor)) *
  (playbackRate > 0 ? playbackRate : 1);

/**
 * 计算从左向右运动的新弹幕起点。
 * 正常从屏幕左侧 x=0 开始；被前面弹幕挤占时允许使用负坐标。
 */
export const getDanmakuLeftToRightStartX = ({
  screenWidth,
  newWidth,
  newSpeed,
  previousLeft,
  previousSpeed,
  gap,
}: {
  screenWidth: number;
  newWidth: number;
  newSpeed: number;
  previousLeft: number;
  previousSpeed: number;
  gap: number;
}): number => {
  let startX = Math.min(0, previousLeft - gap - newWidth);
  if (newSpeed > previousSpeed && previousSpeed > 0) {
    const previousExitSec = Math.max(
      0,
      (screenWidth - previousLeft) / previousSpeed,
    );
    startX = Math.min(
      startX,
      screenWidth - gap - newWidth - newSpeed * previousExitSec,
    );
  }
  return startX;
};

/**
 * 计算后一条弹幕从右侧进入后，需要等到哪一点才不会追尾。
 * 返回值大于屏幕宽度时表示当前还不能插入。
 */
export const getDanmakuCatchLeft = (
  previousLeft: number,
  previousWidth: number,
  previousSpeed: number,
  nextSpeed: number,
  gap: number,
): number =>
  gap +
  (nextSpeed / Math.max(0.001, previousSpeed)) *
    (previousLeft + previousWidth);

export interface DanmakuPrefillCandidate {
  time: number;
  width: number;
  speed: number;
}

/**
 * SEEK 后一次性铺满泳道：弹幕视为在 time 时刻从右边缘进入、以 speed 匀速左移，
 * 由此反推 positionSec 时的左端坐标，只保留落在 [0, screenWidth) 内的弹幕；
 * 按左端从小到大，在所有不与前一条重叠、也不会追尾的泳道中随机挑一条放入
 *（总选最上面的泳道会让各泳道起点从上到下排成阶梯），放不下的位置留空。
 */
export const planDanmakuPrefill = <T extends DanmakuPrefillCandidate>({
  screenWidth,
  positionSec,
  candidates,
  laneCount,
  getGap,
  random = Math.random,
}: {
  screenWidth: number;
  positionSec: number;
  candidates: T[];
  laneCount: number;
  getGap: () => number;
  random?: () => number;
}): { lane: number; left: number; item: T }[] => {
  const placed = candidates
    .filter((item) => item.time < positionSec && item.speed > 0)
    .map((item) => ({
      item,
      left: screenWidth - item.speed * (positionSec - item.time),
    }))
    .filter(({ left }) => left >= 0)
    .sort((a, b) => a.left - b.left);
  const lanes = Array.from({ length: laneCount }, () => ({
    last: null as { left: number; item: T } | null,
    gap: getGap(),
  }));
  const result: { lane: number; left: number; item: T }[] = [];
  placed.forEach(({ item, left }) => {
    const fitting: number[] = [];
    lanes.forEach(({ last, gap }, index) => {
      if (
        !last ||
        (left >= last.left + last.item.width + gap &&
          left >=
            getDanmakuCatchLeft(
              last.left,
              last.item.width,
              last.item.speed,
              item.speed,
              gap,
            ))
      ) {
        fitting.push(index);
      }
    });
    if (!fitting.length) return;
    const laneIndex =
      fitting[Math.min(fitting.length - 1, Math.floor(random() * fitting.length))];
    lanes[laneIndex] = { last: { left, item }, gap: getGap() };
    result.push({ lane: laneIndex, left, item });
  });
  return result;
};

export const estimateDanmakuWidth =(text: string, fontSize: number): number => {
  // 略高于一个 em 的宽度上限，既避免漏判，也不会人为制造过大空隙
  const glyphCount = Array.from(text).length;
  return Math.max(fontSize, glyphCount * fontSize * 1.04 + 6);
};

export const getBilibiliDanmakuDurationSec = (
  physicalWidth: number,
  speedFactor = 1,
): number => {
  const baseMs =
    (BILIBILI_BASE_DURATION_MS * physicalWidth) / BILIBILI_PLAYER_WIDTH;
  const scaledMs = Math.min(
    BILIBILI_MAX_DURATION_MS,
    Math.max(BILIBILI_MIN_DURATION_MS, baseMs),
  );
  return (scaledMs * speedFactor) / 1000;
};

export const getDanmakuTravelSpeed = (
  screenWidth: number,
  textWidth: number,
  durationSec: number,
): number => (screenWidth + textWidth + DANMAKU_EXIT_PADDING) / durationSec;

export const getDanmakuLeftAtTime = (
  screenWidth: number,
  textWidth: number,
  durationSec: number,
  elapsedSec: number,
): number =>
  screenWidth -
  getDanmakuTravelSpeed(screenWidth, textWidth, durationSec) * elapsedSec;

interface CollisionParams {
  screenWidth: number;
  newWidth: number;
  newDurationSec: number;
  existing: DanmakuTrackTiming;
  nowWall: number;
  newStartLeft?: number;
  safeGap?: number;
}

/**
 * 判断新弹幕是否会从后方追上同一泳道内的已有弹幕。
 * 两条弹幕各自匀速运动，比较相对距离在当前时刻与任一弹幕离场时刻的值。
 */
export const willDanmakuCollide = ({
  screenWidth,
  newWidth,
  newDurationSec,
  existing,
  nowWall,
  newStartLeft = screenWidth,
  safeGap = DANMAKU_MIN_SAFE_GAP,
}: CollisionParams): boolean => {
  if (newDurationSec <= 0 || existing.durationSec <= 0) return true;

  const existingSpeed =
    (screenWidth + existing.width + DANMAKU_EXIT_PADDING) / existing.durationSec;
  const elapsedSec = Math.max(0, nowWall - existing.startWall) / 1000;
  const existingRight =
    screenWidth - existingSpeed * elapsedSec + existing.width;

  // 已有弹幕已经完全离开屏幕
  if (existingRight <= 0) return false;

  const newSpeed =
    (screenWidth + newWidth + DANMAKU_EXIT_PADDING) / newDurationSec;
  const currentGap = newStartLeft - existingRight;
  if (currentGap < safeGap) return true;

  // 新弹幕不更快时，间距只会增大，后续不会追尾
  if (newSpeed <= existingSpeed) return false;

  const existingTailExitSec = existingRight / existingSpeed;
  const newTailExitSec = (screenWidth + newWidth) / newSpeed;
  const horizonSec = Math.min(existingTailExitSec, newTailExitSec);
  const existingRightAtHorizon =
    existingRight - existingSpeed * horizonSec;
  const newLeftAtHorizon = newStartLeft - newSpeed * horizonSec;

  return newLeftAtHorizon - existingRightAtHorizon < safeGap;
};
