import { isSameSourceTitle, stripSourceTitleSuffix } from "@/utils/SourceTitleMatch";

describe("去掉片名后缀", () => {
  it("去掉可确定的后缀，其它保留", () => {
    expect(stripSourceTitleSuffix("神雕侠侣粤语1995", "1995")).toBe("神雕侠侣");
    expect(stripSourceTitleSuffix("天龙八部1997（粤语版）", "1997")).toBe("天龙八部");
    expect(stripSourceTitleSuffix("西游记 86版", "1986")).toBe("西游记");
    expect(stripSourceTitleSuffix("庆余年 第一季", "2019")).toBe("庆余年");
    expect(stripSourceTitleSuffix("天龙八部之乔峰传(国)", "1997")).toBe("天龙八部之乔峰传(国)");
    expect(stripSourceTitleSuffix("射雕英雄传1977", "1983")).toBe("射雕英雄传1977");
    expect(stripSourceTitleSuffix("疯狂动物城2", "2025")).toBe("疯狂动物城2");
  });

  it("整个标题都像后缀时不去", () => {
    expect(stripSourceTitleSuffix("1995", "1995")).toBe("1995");
  });
});

describe("片源标题匹配", () => {
  it("完全相同（忽略空格）", () => {
    expect(isSameSourceTitle("神雕侠侣", "神雕侠侣", "1995")).toBe(true);
    expect(isSameSourceTitle("神雕 侠侣", "神雕侠侣", "1995")).toBe(true);
  });

  it("结尾四位年份必须等于片的年份", () => {
    expect(isSameSourceTitle("神雕侠侣1995", "神雕侠侣", "1995")).toBe(true);
    expect(isSameSourceTitle("射雕英雄传1977", "射雕英雄传", "1983")).toBe(false);
  });

  it("两位年份+版", () => {
    expect(isSameSourceTitle("西游记86版", "西游记", "1986")).toBe(true);
    expect(isSameSourceTitle("西游记87版", "西游记", "1986")).toBe(false);
  });

  it("语言后缀，可带版和括号", () => {
    for (const t of [
      "神雕侠侣国语",
      "神雕侠侣粤语",
      "绿皮书（国语版）",
      "星际穿越(原声版)",
      "千与千寻普通话版",
      "繁花[沪语版]",
      "你的名字。(日语版)",
      "让子弹飞四川话版",
    ]) {
      const base = t.match(/^(神雕侠侣|绿皮书|星际穿越|千与千寻|繁花|你的名字。|让子弹飞)/)![1];
      expect(isSameSourceTitle(t, base, "2000")).toBe(true);
    }
  });

  it("多个后缀组合", () => {
    expect(isSameSourceTitle("神雕侠侣粤语1995", "神雕侠侣", "1995")).toBe(true);
    expect(isSameSourceTitle("射雕英雄传国语1983版", "射雕英雄传", "1983")).toBe(true);
    expect(isSameSourceTitle("天龙八部1997（粤语版）", "天龙八部", "1997")).toBe(true);
  });

  it("第一季", () => {
    expect(isSameSourceTitle("庆余年第一季", "庆余年", "2019")).toBe(true);
    expect(isSameSourceTitle("庆余年第1季", "庆余年", "2019")).toBe(true);
    expect(isSameSourceTitle("庆余年第二季", "庆余年", "2019")).toBe(false);
  });

  it("其它后缀不放行", () => {
    for (const [t, base] of [
      ["庆余年第一季特别版", "庆余年"],
      ["天龙八部之乔峰传(国)", "天龙八部"],
      ["神雕侠侣李若彤版国语", "神雕侠侣"],
      ["凡人修仙传重制版", "凡人修仙传"],
      ["射雕英雄传续集", "射雕英雄传"],
      ["疯狂动物城2[预告片]", "疯狂动物城2"],
      ["星际穿越中的科学", "星际穿越"],
      ["疯狂动物城2", "疯狂动物城"],
    ]) {
      expect(isSameSourceTitle(t, base, "2000")).toBe(false);
    }
  });
});
