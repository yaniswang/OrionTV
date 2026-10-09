/** 账号头像可选颜色；fg 为头像上首字的颜色，保证与底色的对比度 */
export const ACCOUNT_COLORS = [
  { bg: "#3d6fd6", fg: "#ffffff" },
  { bg: "#f0a63a", fg: "#2a1800" },
  { bg: "#e47a96", fg: "#2a0812" },
  { bg: "#2fb3b3", fg: "#04201f" },
  { bg: "#8a6be0", fg: "#ffffff" },
  { bg: "#8c8c92", fg: "#111113" },
] as const;

export const getAccountTextColor = (bg: string) =>
  ACCOUNT_COLORS.find((c) => c.bg === bg)?.fg ?? "#ffffff";

/** 取一个还没被使用的颜色，全部用过时按数量轮转 */
export const pickAccountColor = (usedColors: string[]) =>
  ACCOUNT_COLORS.find((c) => !usedColors.includes(c.bg))?.bg ??
  ACCOUNT_COLORS[usedColors.length % ACCOUNT_COLORS.length].bg;
