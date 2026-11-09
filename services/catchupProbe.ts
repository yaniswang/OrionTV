/**
 * 回看能力检测：请求一段特意挑的时长（不是整分钟），看返回的点播列表是不是正好这么长。
 * 服务端把很多频道包了一层 302 或代理，认不出源站，所以只看请求的最终结果；
 * 忽略回看参数的服务器返回的直播、循环视频，时长和请求无关，对不上。
 */

/** 检测请求的时长（秒）：3 分 17 秒，不易碰巧对上 */
export const PROBE_SECONDS = 197;

export type PlaylistKind = 'vod' | 'live' | 'master' | 'invalid';

export function classifyPlaylist(text: string): PlaylistKind {
  const t = text.trimStart();
  if (!t.startsWith('#EXTM3U')) return 'invalid';
  if (t.includes('#EXT-X-STREAM-INF')) return 'master';
  if (t.includes('#EXT-X-ENDLIST') || t.includes('#EXT-X-PLAYLIST-TYPE')) return 'vod';
  if (t.includes('#EXTINF')) return 'live';
  return 'invalid';
}

/** #EXT-X-TARGETDURATION（秒），没有返回 10 */
function targetDurationSec(text: string): number {
  const m = /#EXT-X-TARGETDURATION:\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : 10;
}

/** 按 base 解析相对地址（RN 的 URL 不支持相对路径解析） */
export function resolveUrl(ref: string, base: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  const origin = base.match(/^https?:\/\/[^/]+/i)?.[0] ?? '';
  if (ref.startsWith('/')) return origin + ref;
  const path = base.split(/[?#]/)[0];
  return path.slice(0, path.lastIndexOf('/') + 1) + ref;
}

/** 主列表里第一个子列表的完整地址 */
export function firstVariantUrl(master: string, baseUrl: string): string | null {
  let afterStreamInf = false;
  for (const raw of master.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) afterStreamInf = true;
    else if (afterStreamInf && line && !line.startsWith('#')) return resolveUrl(line, baseUrl);
  }
  return null;
}

/** 列表里所有片段时长之和（秒） */
export function playlistDurationSec(text: string): number {
  let sum = 0;
  const re = /#EXTINF:\s*([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) sum += parseFloat(m[1]) || 0;
  return sum;
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/**
 * @param requestedSec 回看地址里请求的时长；点播列表总时长与它相差不超过一个片段（TARGETDURATION + 1 秒）才算支持。
 *   实测咪咕：请求 197 秒返回 198 / 190 秒（片段 6 / 10 秒）
 * @returns 'ok' 支持回看；'unsupported' 返回的是 m3u8 但时长对不上或是滚动直播（忽略了回看参数）；
 *   null 无法判断（出错、非 m3u8，不缓存）
 */
export async function probeCatchupUrl(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike = fetch,
  requestedSec: number = PROBE_SECONDS,
): Promise<'ok' | 'unsupported' | null> {
  try {
    const r1 = await fetchImpl(url, { headers });
    if (!r1.ok) return null;
    let text = await r1.text();
    let kind = classifyPlaylist(text);
    if (kind === 'master') {
      const variant = firstVariantUrl(text, r1.url || url);
      if (!variant) return null;
      const r2 = await fetchImpl(variant, { headers });
      if (!r2.ok) return null;
      text = await r2.text();
      kind = classifyPlaylist(text);
    }
    if (kind === 'vod') {
      const diff = Math.abs(playlistDurationSec(text) - requestedSec);
      return diff <= targetDurationSec(text) + 1 ? 'ok' : 'unsupported';
    }
    if (kind === 'live') return 'unsupported';
    return null;
  } catch {
    return null;
  }
}
