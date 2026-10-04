/**
 * 本地预缓存代理 —— playlist 改写逻辑
 *
 * 全部是纯函数，不碰网络和文件，方便单测。
 */

import { Buffer } from 'buffer';

/** 每请求一片，向后预取多少片（当前片拿到之后才并发发起） */
export const PREFETCH_COUNT = 5;

/**
 * 播放器靠 URL 最后一段的后缀判断类型（react-native-video 用
 * `Util.inferContentType(uri.getLastPathSegment())`）。代理地址是 base64 串，
 * 没有后缀就会被当成普通视频文件，所以清单类地址必须带 .m3u8 结尾。
 */
const PLAYLIST_SUFFIX = '.m3u8';

/** djb2：把 playlist 地址映射成稳定的短 pid */
export function hashString(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 是否是 HLS 清单（必须以 #EXTM3U 开头） */
export function isHlsPlaylist(text: string): boolean {
  return text.trimStart().startsWith('#EXTM3U');
}

/** 是否是"最终分片清单"（含 #EXTINF 才是叶子） */
export function isLeafPlaylist(text: string): boolean {
  return text.includes('#EXTINF:');
}

/**
 * 分片/清单地址里可能含 `/ ? & =`，直接拼进 path 会被播放器或 OkHttp 规范化破坏。
 * 用 base64url（只含 A-Za-z0-9-_）最稳，不需要任何百分号编码。
 */
export function encodeTarget(url: string): string {
  return Buffer.from(url, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeTarget(token: string): string {
  const trimmed = token.endsWith(PLAYLIST_SUFFIX)
    ? token.slice(0, -PLAYLIST_SUFFIX.length)
    : token;
  const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** 把相对地址按清单地址解析成绝对地址；解析失败返回 null */
export function resolveUrl(raw: string, base: string): string | null {
  try {
    return new URL(raw.trim(), base).href;
  } catch {
    return null;
  }
}

/**
 * 生成本地代理地址。
 * 带 sid/pid 的是分片地址（用于预取），不带的是清单/key 地址。
 */
export function buildProxyUrl(
  localOrigin: string,
  targetUrl: string,
  sid?: number,
  pid?: string,
): string {
  const base = `${localOrigin}/${encodeTarget(targetUrl)}`;
  // 清单地址带 .m3u8 后缀，播放器才会按 HLS 解析；分片不需要
  if (sid === undefined || pid === undefined) return `${base}${PLAYLIST_SUFFIX}`;
  return `${base}?pid=${encodeURIComponent(pid)}&sid=${sid}`;
}

/**
 * 改写行里的 URI="..." 属性（#EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 等）。
 * 这些地址若保持相对路径，播放器会拿"代理地址"当基准去解析，必然 404。
 */
function rewriteUriAttributes(line: string, localOrigin: string, sourceUrl: string): string {
  return line.replace(/URI="([^"]+)"/g, (match, uri) => {
    const abs = resolveUrl(uri, sourceUrl);
    return abs ? `URI="${buildProxyUrl(localOrigin, abs)}"` : match;
  });
}

export interface LeafRewriteResult {
  text: string;
  pid: string;
  segments: string[];
}

/**
 * 改写"最终分片清单"：
 * - #EXTINF 下一行的分片地址 -> 走本地代理，并带 pid/sid
 * - #EXT-X-KEY 的 URI -> 走本地代理
 * 同时把 pid -> 分片列表 返回给调用方登记。
 */
export function rewriteLeafPlaylist(
  text: string,
  localOrigin: string,
  sourceUrl: string,
): LeafRewriteResult {
  const pid = hashString(sourceUrl);
  const lines = text.split('\n');
  const out: string[] = [];
  const segments: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^#EXTINF:/.test(line)) {
      out.push(line);
      i++;
      if (i >= lines.length || !lines[i]) break;
      const target = resolveUrl(lines[i], sourceUrl);
      if (!target) {
        out.push(lines[i]);
        continue;
      }
      const sid = segments.length;
      segments.push(target);
      out.push(buildProxyUrl(localOrigin, target, sid, pid));
    } else if (/^#EXT-X-[A-Z0-9-]+:/.test(line) && line.includes('URI="')) {
      out.push(rewriteUriAttributes(line, localOrigin, sourceUrl));
    } else {
      out.push(line);
    }
  }

  return { text: out.join('\n'), pid, segments };
}

/**
 * 改写"子清单"（master / 中间层）：只把 #EXT-X-STREAM-INF 指向的子清单地址
 * 和 #EXT-X-KEY 的 URI 指向本地代理，不加 pid/sid、不登记、不预取。
 */
export function rewriteChildPlaylist(text: string, localOrigin: string, sourceUrl: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^#EXT-X-STREAM-INF:/.test(line)) {
      out.push(line);
      i++;
      if (i >= lines.length || !lines[i]) break;
      const target = resolveUrl(lines[i], sourceUrl);
      out.push(target ? buildProxyUrl(localOrigin, target) : lines[i]);
    } else if (/^#EXT-X-[A-Z0-9-]+:/.test(line) && line.includes('URI="')) {
      out.push(rewriteUriAttributes(line, localOrigin, sourceUrl));
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}
