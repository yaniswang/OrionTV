/**
 * XMLTV 节目单解析。节目单约 2MB / 1.3 万条，老电视上不用 DOM 解析，直接正则扫描。
 */

export interface EpgProgram {
  /** UTC 毫秒 */
  start: number;
  /** UTC 毫秒 */
  end: number;
  title: string;
}

export interface EpgData {
  /** 频道 id → 按开始时间排序的节目 */
  programs: Map<string, EpgProgram[]>;
  /** display-name → 频道 id */
  nameToId: Map<string, string>;
  /** 节目单时间带的时区（分钟），生成回看地址时用；没有时区信息为 null */
  tzOffsetMinutes: number | null;
}

const DISPLAY_NAME_RE = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/;
const ATTR_ID_RE = /\bid="([^"]*)"/;
const ATTR_CHANNEL_RE = /\bchannel="([^"]*)"/;
const ATTR_START_RE = /\bstart="([^"]*)"/;
const ATTR_STOP_RE = /\bstop="([^"]*)"/;
const TIME_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(?:([+-])(\d{2})(\d{2}))?$/;
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  if (s.indexOf('&') < 0) return s.trim();
  return s
    .replace(ENTITY_RE, (_, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCharCode(code);
      }
      return ENTITIES[e.toLowerCase()];
    })
    .trim();
}

/** "20261109110100 +0800" → { ms: UTC 毫秒, offset: 分钟 }；没有时区按 UTC 处理 */
function parseTime(s: string): { ms: number; offset: number | null } | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const offset = m[7] ? (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) : null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - (offset ?? 0) * 60000;
  return { ms, offset };
}

/**
 * 依次切出 <tag ...>...</tag> 片段。只用 indexOf 在大字符串上定位，正则只跑在小片段上：
 * Hermes 上对 2MB 字符串反复执行全局正则，实测解析要将近 1 分钟。
 */
function nextElement(xml: string, tag: string, from: number): { attrs: string; body: string; end: number } | null {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let s = xml.indexOf(open, from);
  // 跳过 <channelX 这类前缀相同的标签
  while (s >= 0) {
    const c = xml.charCodeAt(s + open.length);
    if (c === 32 || c === 62 || c === 9 || c === 10 || c === 13) break; // 空格 > \t \n \r
    s = xml.indexOf(open, s + open.length);
  }
  if (s < 0) return null;
  const gt = xml.indexOf('>', s);
  const e = xml.indexOf(close, gt);
  if (gt < 0 || e < 0) return null;
  return { attrs: xml.substring(s + open.length, gt), body: xml.substring(gt + 1, e), end: e + close.length };
}

/** 解析器：step 每次最多处理 sliceMs 毫秒，返回是否已完成；同步和分片两种入口共用 */
function createParser(xml: string) {
  const programs = new Map<string, EpgProgram[]>();
  const nameToId = new Map<string, string>();
  let tzOffsetMinutes: number | null = null;
  let pos = 0;
  let channelsDone = false;

  const parseChannels = () => {
    const displayNameRe = new RegExp(DISPLAY_NAME_RE.source, 'g');
    let at = 0;
    let el: ReturnType<typeof nextElement>;
    while ((el = nextElement(xml, 'channel', at))) {
      at = el.end;
      const idMatch = ATTR_ID_RE.exec(el.attrs);
      if (!idMatch) continue;
      const id = decode(idMatch[1]);
      displayNameRe.lastIndex = 0;
      let dm: RegExpExecArray | null;
      while ((dm = displayNameRe.exec(el.body))) {
        const name = decode(dm[1]);
        if (name && !nameToId.has(name)) nameToId.set(name, id);
      }
    }
  };

  const step = (sliceMs: number): boolean => {
    const t0 = Date.now();
    if (!channelsDone) {
      parseChannels();
      channelsDone = true;
    }
    let count = 0;
    let pm: ReturnType<typeof nextElement>;
    while ((pm = nextElement(xml, 'programme', pos))) {
      pos = pm.end;
      const attrs = pm.attrs;
      const ch = ATTR_CHANNEL_RE.exec(attrs);
      const startAttr = ATTR_START_RE.exec(attrs);
      const stopAttr = ATTR_STOP_RE.exec(attrs);
      if (ch && startAttr && stopAttr) {
        const start = parseTime(startAttr[1]);
        const end = parseTime(stopAttr[1]);
        if (start && end && end.ms > start.ms) {
          if (tzOffsetMinutes === null && start.offset !== null) tzOffsetMinutes = start.offset;
          const titleMatch = TITLE_RE.exec(pm.body);
          const id = decode(ch[1]);
          let list = programs.get(id);
          if (!list) {
            list = [];
            programs.set(id, list);
          }
          list.push({ start: start.ms, end: end.ms, title: titleMatch ? decode(titleMatch[1]) : '' });
        }
      }
      // 每 100 条看一次时间，超出本片预算就让出
      if (++count % 100 === 0 && Date.now() - t0 >= sliceMs) return false;
    }
    programs.forEach((list) => list.sort((a, b) => a.start - b.start));
    return true;
  };

  return { step, result: (): EpgData => ({ programs, nameToId, tzOffsetMinutes }) };
}

export function parseXmltv(xml: string): EpgData {
  const parser = createParser(xml);
  while (!parser.step(Infinity));
  return parser.result();
}

/** 分片解析：每片最多 sliceMs 毫秒，片与片之间让出 JS 线程，不卡按键和界面 */
export async function parseXmltvAsync(xml: string, sliceMs = 8): Promise<EpgData> {
  const parser = createParser(xml);
  while (!parser.step(sliceMs)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return parser.result();
}

/** 按 tvg-id → tvg-name → 频道名 的顺序匹配节目单，名字也会查 display-name */
export function findChannelPrograms(
  epg: EpgData,
  ch: { tvgId?: string; tvgName?: string; name: string },
): EpgProgram[] | undefined {
  for (const key of [ch.tvgId, ch.tvgName, ch.name]) {
    if (!key) continue;
    const list = epg.programs.get(key) ?? epg.programs.get(epg.nameToId.get(key) ?? '');
    if (list) return list;
  }
  return undefined;
}

/** 包含时刻 t 的节目下标（开始含、结束不含），没有返回 -1 */
export function programIndexAt(list: EpgProgram[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && t < list[found].end ? found : -1;
}
