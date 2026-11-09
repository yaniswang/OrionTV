/**
 * 回看地址生成。m3u 的 catchup-source 模板形如
 * ?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}
 */

export interface CatchupConfig {
  /** append：拼在直播地址后面；default：模板本身就是完整地址 */
  mode: 'append' | 'default';
  source: string;
  /** catchup-days：可回看天数，没写为空（按默认 7 天） */
  days?: number;
}

const TOKEN_RE = /\$\{\((b|e)\)([^}]*)\}/g;
const FORMAT_RE = /yyyy|MM|dd|HH|mm|ss/g;

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

function formatTime(ms: number, fmt: string, tzOffsetMinutes: number): string {
  const d = new Date(ms + tzOffsetMinutes * 60000);
  return fmt.replace(FORMAT_RE, (token) => {
    switch (token) {
      case 'yyyy': return String(d.getUTCFullYear());
      case 'MM': return pad(d.getUTCMonth() + 1);
      case 'dd': return pad(d.getUTCDate());
      case 'HH': return pad(d.getUTCHours());
      case 'mm': return pad(d.getUTCMinutes());
      default: return pad(d.getUTCSeconds());
    }
  });
}

/** 回看地址模板（时间占位符原样保留）：append 拼在直播地址后，default 本身就是完整地址 */
export function catchupTemplate(liveUrl: string, cfg: CatchupConfig): string {
  if (cfg.mode === 'default') return cfg.source;
  if (cfg.source.startsWith('?') && liveUrl.includes('?')) return `${liveUrl}&${cfg.source.slice(1)}`;
  return liveUrl + cfg.source;
}

/**
 * @param start 回看开始，UTC 毫秒
 * @param end 回看结束，UTC 毫秒
 * @param tzOffsetMinutes 模板时间所用时区（分钟），优先取节目单的时区
 */
export function buildCatchupUrl(liveUrl: string, cfg: CatchupConfig, start: number, end: number, tzOffsetMinutes: number): string {
  return catchupTemplate(liveUrl, cfg).replace(TOKEN_RE, (_, which: string, fmt: string) =>
    formatTime(which === 'b' ? start : end, fmt, tzOffsetMinutes),
  );
}
