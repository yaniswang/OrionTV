/**
 * 片源标题常在片名后带后缀（"神雕侠侣粤语1995""绿皮书（国语版）""西游记86版"），
 * 只认能确定是片名后缀的内容（可多个、可加括号）：
 * 四位年份（须等于片的年份，可带"版"）、两位年份+版（如 86版）、语言（国语/粤语/原声…，可带"版"）、第一季。
 */
const LANGUAGE = "国语|粤语|普通话|沪语|闽南语|四川话|台语|日语|英语|韩语|原声|国配|粤配|中配";

const norm = (s: string) => String(s ?? "").replace(/\s+/g, "");

/** 去掉标题结尾所有可确定的片名后缀，同时去掉空格 */
export function stripSourceTitleSuffix(title: string, year: string): string {
  const y = String(year ?? "");
  const tokens = [`(?:${LANGUAGE})版?`, "第[一1]季"];
  if (/^\d{4}$/.test(y)) tokens.push(`${y}版?`, `${y.slice(2)}版`);
  const token = `(?:${tokens.join("|")})`;
  const suffix = new RegExp(`(?:${token}|[(（]${token}[)）]|[\\[【]${token}[\\]】])$`);

  let rest = norm(title);
  for (;;) {
    const m = rest.match(suffix);
    // 整个标题都是"后缀"时不再去，留下片名
    if (!m || m.index === 0) return rest;
    rest = rest.slice(0, m.index);
  }
}

/** 片源标题是否就是这部片：完全相同（忽略空格），或片名后只跟可确定的后缀 */
export function isSameSourceTitle(itemTitle: string, title: string, year: string): boolean {
  const target = norm(title);
  const item = norm(itemTitle);
  return item === target || stripSourceTitleSuffix(item, year) === target;
}
