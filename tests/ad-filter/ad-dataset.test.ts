/** @jest-environment node */

// 27 个真实源的广告数据：判定逻辑的回归基准（原生侧单测读同源的 ad-dataset.tsv）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dataset = require("./ad-dataset.json") as Array<{
  source: string;
  encrypted: boolean;
  blocks: Array<{ pts: number | null; dur: number; n: number; label: string }>;
}>;

describe("广告过滤测试数据", () => {
  it("27 个源、1454 个块，标注分布稳定", () => {
    expect(dataset).toHaveLength(27);

    const blocks = dataset.flatMap((item) => item.blocks);
    expect(blocks).toHaveLength(1454);

    const labels: Record<string, number> = {};
    blocks.forEach((block) => {
      labels[block.label] = (labels[block.label] || 0) + 1;
    });
    expect(labels).toEqual({
      movie: 1351,
      ad_bridged: 46,
      break_unbridged: 36,
      ad_tail_break: 18,
      unknown: 3,
    });
  });

  it("真广告共 60 段，加密源保留在数据里", () => {
    // 数据集把个别片尾大块也标成广告，所以真值取"标注为广告且时长不超过 60 秒"
    const ads = dataset
      .flatMap((item) => item.blocks)
      .filter((block) => (block.label === "ad_bridged" || block.label === "ad_tail_break") && block.dur <= 60);

    expect(ads).toHaveLength(60);
    // 3 个源站：play.subokk.com、vv.jisuzyv.com、vod1.maowushi.com（2 条清单）
    expect(dataset.filter((item) => item.encrypted)).toHaveLength(4);
  });

  it("每个块都有完整的分块信息", () => {
    for (const item of dataset) {
      expect(item.source.length).toBeGreaterThan(0);
      expect(item.blocks.length).toBeGreaterThan(0);
      for (const block of item.blocks) {
        expect(typeof block.dur).toBe("number");
        expect(block.n).toBeGreaterThan(0);
        expect(typeof block.label).toBe("string");
      }
    }
  });
});
