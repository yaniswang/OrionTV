import {
  convertDanmakuFormat,
  DANMAKU_AREA_OPTIONS,
  DANMAKU_DENSITY_OPTIONS,
  danmakuDuration,
  danmakuMaxFlying,
  danmakuTrackCount,
  danmakuTrackToY,
  estimateDanmakuWidth,
  extractEpisodeNumber,
  filterDanmakuByDensity,
  filterDanmakuSources,
  findSpawnIndex,
  formatDanmakuSourceLabel,
  interpolateVideoTime,
  matchDanmakuEpisode,
  pickDanmakuTrack,
  progressFromTranslateX,
  remainingScrollMs,
  scrollTranslateX,
  shouldRefreshVideoClock,
  shouldSpawnComment,
  type DisplayDanmaku,
} from "../danmaku";

describe("convertDanmakuFormat", () => {
  it("解析时间和颜色，并按时间排序", () => {
    const result = convertDanmakuFormat([
      { p: "12.5,1,25,16711680,0,0,0,1", m: "第二", cid: 1 },
      { p: "1,5,25,16777215,0,0,0,2", m: "第一", cid: 2 },
    ]);
    expect(result[0].text).toBe("第一");
    expect(result[0].time).toBe(1);
    expect(result[0].mode).toBe(1);
    expect(result[1].color).toBe("#ff0000");
  });
});

describe("filterDanmakuSources", () => {
  const animes = [
    { animeId: 1, animeTitle: "权力的游戏", type: "tv", typeDescription: "tv", startDate: "2011-01", source: "bilibili" },
    { animeId: 2, animeTitle: "权力的游戏", type: "tv", typeDescription: "tv", startDate: "2024-01", source: "iqiyi" },
    { animeId: 3, animeTitle: "别的剧", type: "tv", typeDescription: "tv", startDate: "2011-01", source: "youku" },
  ];

  it("优先返回年份和标题都匹配的源", () => {
    const filtered = filterDanmakuSources(animes, "权力的游戏", "2011");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].animeId).toBe(1);
  });
});

describe("matchDanmakuEpisode", () => {
  const episodes = [
    { episodeId: 10, episodeTitle: "第1集" },
    { episodeId: 11, episodeTitle: "第2集" },
    { episodeId: 12, episodeTitle: "第3集" },
  ];

  it("按集数标题数字匹配", () => {
    expect(matchDanmakuEpisode(0, episodes, "第 3 集")?.episodeId).toBe(12);
  });

  it("没有标题时按索引匹配", () => {
    expect(matchDanmakuEpisode(1, episodes)?.episodeId).toBe(11);
  });
});

describe("extractEpisodeNumber", () => {
  it("识别 S01E02 和 第N集", () => {
    expect(extractEpisodeNumber("S01E02")).toBe(2);
    expect(extractEpisodeNumber("第08集")).toBe(8);
  });
});

describe("formatDanmakuSourceLabel", () => {
  it("把弹幕条数写在最后并用括号括起来", () => {
    expect(
      formatDanmakuSourceLabel({
        animeId: 1,
        animeTitle: "权力的游戏",
        type: "tv",
        typeDescription: "tv",
        source: "bilibili",
        episodeCount: 10,
        commentCount: 1888,
      })
    ).toBe("权力的游戏 · bilibili · 10集（1888条）");
  });

  it("没有弹幕条数时仍显示标题、来源和集数", () => {
    expect(
      formatDanmakuSourceLabel({
        animeId: 1,
        animeTitle: "权力的游戏",
        type: "tv",
        typeDescription: "tv",
        source: "bilibili",
        episodeCount: 10,
      })
    ).toBe("权力的游戏 · bilibili · 10集");
  });

  it("没有来源和集数时只在标题后追加弹幕条数", () => {
    expect(
      formatDanmakuSourceLabel({
        animeId: 1,
        animeTitle: "权力的游戏",
        type: "tv",
        typeDescription: "tv",
        source: "",
        commentCount: 8,
      })
    ).toBe("权力的游戏（8条）");
  });
});

describe("interpolateVideoTime", () => {
  it("播放中按墙钟推进，不依赖下一次进度回调", () => {
    const time = interpolateVideoTime(
      { time: 10, wall: 1_000, playing: true, rate: 1 },
      1_500
    );
    expect(time).toBeCloseTo(10.5);
  });

  it("暂停时保持上次视频时间", () => {
    const time = interpolateVideoTime(
      { time: 10, wall: 1_000, playing: false, rate: 1 },
      1_500
    );
    expect(time).toBe(10);
  });

  it("倍速播放时按倍率推进", () => {
    const time = interpolateVideoTime(
      { time: 10, wall: 1_000, playing: true, rate: 2 },
      1_500
    );
    expect(time).toBeCloseTo(11);
  });
});

describe("shouldRefreshVideoClock", () => {
  const base = { videoTime: 10, playing: true, rate: 1 };

  it("播放器进度没变时不刷新快照，避免把插值墙钟重置掉", () => {
    expect(shouldRefreshVideoClock(base, { ...base })).toBe(false);
  });

  it("进度、播放状态或倍率变化时才刷新快照", () => {
    expect(shouldRefreshVideoClock(base, { ...base, videoTime: 10.5 })).toBe(true);
    expect(shouldRefreshVideoClock(base, { ...base, playing: false })).toBe(true);
    expect(shouldRefreshVideoClock(base, { ...base, rate: 1.5 })).toBe(true);
  });
});

describe("scroll layout", () => {
  it("把 0-1 进度映射为从屏幕右侧滚到完全离开左侧", () => {
    expect(scrollTranslateX(1920, 200, 0)).toBe(1920);
    expect(scrollTranslateX(1920, 200, 1)).toBe(-200);
    expect(scrollTranslateX(1920, 200, 0.5)).toBe(860);
  });

  it("能从当前 translateX 反推进度，供暂停后续飞", () => {
    expect(progressFromTranslateX(1920, 1920, 200)).toBeCloseTo(0);
    expect(progressFromTranslateX(-200, 1920, 200)).toBeCloseTo(1);
    expect(progressFromTranslateX(860, 1920, 200)).toBeCloseTo(0.5);
  });

  it("按剩余路程计算剩余滚动毫秒", () => {
    expect(remainingScrollMs(8, 2)).toBe(6000);
    expect(remainingScrollMs(8, 8)).toBe(0);
    expect(remainingScrollMs(8, 10)).toBe(0);
  });
});

describe("danmaku spawn", () => {
  const comments = [
    { time: 1 },
    { time: 5 },
    { time: 5.2 },
    { time: 12 },
  ];

  it("seek 后从当前时间附近开始补弹幕", () => {
    expect(findSpawnIndex(comments, 5)).toBe(1);
    expect(findSpawnIndex(comments, 0)).toBe(0);
  });

  it("错过超过迟到窗口的弹幕不再补出", () => {
    expect(shouldSpawnComment(8.5, 10)).toBe(false);
    expect(shouldSpawnComment(9.2, 10)).toBe(true);
  });

  it("滚动弹幕 8 秒，固定弹幕 4.2 秒", () => {
    expect(danmakuDuration(0)).toBe(8);
    expect(danmakuDuration(1)).toBe(4.2);
    expect(danmakuDuration(2)).toBe(4.2);
  });

  it("按字数估算宽度", () => {
    expect(estimateDanmakuWidth("弹", 16)).toBeGreaterThanOrEqual(24);
    expect(estimateDanmakuWidth("abcdefghij", 20)).toBe(190);
  });
});

describe("pickDanmakuTrack", () => {
  it("顶部和底部弹幕占用固定轨道", () => {
    const tracks = new Array(10).fill(-999);
    expect(pickDanmakuTrack(10, 1, tracks)).toBe(0);
    expect(pickDanmakuTrack(10, 2, tracks)).toBe(9);
  });

  it("滚动弹幕优先占用空闲轨道", () => {
    const tracks = new Array(10).fill(-999);
    expect(pickDanmakuTrack(10, 0, tracks)).toBe(0);
    expect(pickDanmakuTrack(10, 0, tracks)).toBe(1);
  });
});

function comment(partial: Partial<DisplayDanmaku> & { text: string; time: number }): DisplayDanmaku {
  return { color: "#ffffff", mode: 0, ...partial };
}

describe("filterDanmakuByDensity", () => {
  it("无限密度原样返回", () => {
    const comments = [comment({ text: "a", time: 1 }), comment({ text: "b", time: 1.2 })];
    expect(filterDanmakuByDensity(comments, "unlimited")).toBe(comments);
  });

  it("稀疏模式同一秒同一文案只留 1 条", () => {
    const comments = [
      comment({ text: "哈哈", time: 3.0 }),
      comment({ text: "哈哈", time: 3.2 }),
      comment({ text: "哈哈", time: 3.8 }),
    ];
    const kept = filterDanmakuByDensity(comments, "sparse");
    expect(kept).toHaveLength(1);
    expect(kept[0].time).toBe(3.0);
  });

  it("中等模式同一秒同一文案最多 2 条", () => {
    const comments = [
      comment({ text: "草", time: 1.0 }),
      comment({ text: "草", time: 1.1 }),
      comment({ text: "草", time: 1.2 }),
    ];
    expect(filterDanmakuByDensity(comments, "medium")).toHaveLength(2);
  });

  it("稀疏模式每秒最多 4 条，优先保留彩色和长文本", () => {
    const comments = [
      comment({ text: "短", time: 5.0 }),
      comment({ text: "也短", time: 5.1 }),
      comment({ text: "普通普通", time: 5.2 }),
      comment({ text: "这是一条很长的弹幕内容", time: 5.3 }),
      comment({ text: "彩色", time: 5.4, color: "#ff0000" }),
      comment({ text: "顶", time: 5.5, mode: 1 }),
    ];
    const kept = filterDanmakuByDensity(comments, "sparse");
    expect(kept).toHaveLength(4);
    expect(kept.map((item) => item.text)).toEqual(
      expect.arrayContaining(["彩色", "这是一条很长的弹幕内容", "顶"])
    );
    expect(kept.map((item) => item.time)).toEqual([...kept].map((item) => item.time).sort((a, b) => a - b));
  });

  it("跨秒窗口互不影响", () => {
    const comments = [
      comment({ text: "a", time: 1.0 }),
      comment({ text: "b", time: 1.5 }),
      comment({ text: "c", time: 2.0 }),
    ];
    expect(filterDanmakuByDensity(comments, "sparse")).toHaveLength(3);
  });
});

describe("danmaku layout by area", () => {
  it("区域选项和密度选项是固定枚举", () => {
    expect(DANMAKU_AREA_OPTIONS).toEqual([0.25, 0.5, 0.75]);
    expect(DANMAKU_DENSITY_OPTIONS).toEqual(["sparse", "medium", "unlimited"]);
  });

  it("轨道数随区域增大，并有上下限", () => {
    expect(danmakuTrackCount(1080, 16, 0.25)).toBeGreaterThanOrEqual(3);
    expect(danmakuTrackCount(1080, 16, 0.5)).toBeGreaterThan(danmakuTrackCount(1080, 16, 0.25));
    expect(danmakuTrackCount(1080, 16, 0.75)).toBeLessThanOrEqual(24);
    expect(danmakuTrackCount(100, 40, 0.25)).toBe(3);
  });

  it("滚动弹幕 Y 落在显示区域内，末轨接近区域底", () => {
    const height = 1000;
    const fontSize = 16;
    const tracks = danmakuTrackCount(height, fontSize, 0.25);
    const y0 = danmakuTrackToY(0, 0, height, fontSize, tracks, 0.25);
    const yLast = danmakuTrackToY(tracks - 1, 0, height, fontSize, tracks, 0.25);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(yLast).toBeLessThanOrEqual(height * 0.25 + 16);
    expect(yLast).toBeGreaterThan(y0);
  });

  it("底部固定弹幕落在显示区域底部而不是屏幕底部", () => {
    const y = danmakuTrackToY(9, 2, 1000, 16, 10, 0.25);
    expect(y).toBeLessThan(1000 * 0.25);
    expect(y).toBeGreaterThan(1000 * 0.1);
  });

  it("并发上限随密度变化", () => {
    expect(danmakuMaxFlying("sparse")).toBe(16);
    expect(danmakuMaxFlying("medium")).toBe(32);
    expect(danmakuMaxFlying("unlimited")).toBe(64);
  });
});

describe("pickDanmakuTrack overlap", () => {
  it("稀疏禁止重叠时，轨道全忙返回 -1", () => {
    const tracks = [10, 10, 10];
    expect(pickDanmakuTrack(10.5, 0, tracks, 1.1, false)).toBe(-1);
  });

  it("允许重叠时仍挤到最空闲轨道", () => {
    const tracks = [10, 9, 10];
    expect(pickDanmakuTrack(10.5, 0, tracks, 1.1, true)).toBe(1);
  });
});
