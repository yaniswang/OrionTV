import { Channel } from '@/services/m3u';
import { Favorite, FavoriteManager } from '@/services/storage';

/**
 * 直播频道收藏：存在服务端收藏列表里，格式与 LunaTV 网页版一致，两边互通。
 * key = live_{直播源 key}+live_{直播源 key}-{网页版频道序号}，只存名称和台标。
 */

const sourceOf = (sourceKey: string) => `live_${sourceKey}`;

export function liveFavoriteRef(sourceKey: string, ch: Channel): { source: string; id: string } {
  // 网页版解析不到的频道没有序号，按名称记（网页版打不开，本机按名称能找到）
  const suffix = ch.webIndex !== undefined ? String(ch.webIndex) : ch.name;
  return { source: sourceOf(sourceKey), id: `live_${sourceKey}-${suffix}` };
}

export function buildLiveFavorite(sourceKey: string, sourceName: string, ch: Channel): Favorite {
  return {
    title: ch.name,
    source_name: sourceName,
    year: '',
    cover: ch.logo ? `/api/proxy/logo?url=${encodeURIComponent(ch.logo)}&source=${sourceKey}` : '',
    total_episodes: 1,
    search_title: '',
    origin: 'live',
    // 影视收藏的必填字段，直播用不到
    episode_index: 0,
    progress: 0,
  };
}

/**
 * 把服务端收藏对应到当前频道列表：先按序号找，名称对不上（m3u 增删换序）再按名称找，都找不到的不显示。
 * 返回 频道 → 服务端存储 key（取消收藏时用），按频道列表原顺序排。
 */
export function matchLiveFavorites(favs: Record<string, Favorite>, sourceKey: string, channels: Channel[]): Map<Channel, string> {
  const prefix = `${sourceOf(sourceKey)}+live_${sourceKey}-`;
  const byWebIndex = new Map<number, Channel>();
  for (const c of channels) if (c.webIndex !== undefined) byWebIndex.set(c.webIndex, c);
  const found = new Map<Channel, string>();
  for (const [key, fav] of Object.entries(favs)) {
    if (fav?.origin !== 'live' || !key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    let c = /^\d+$/.test(suffix) ? byWebIndex.get(Number(suffix)) : undefined;
    if (!c || c.name !== fav.title) c = channels.find((x) => x.name === fav.title);
    if (c && !found.has(c)) found.set(c, key);
  }
  const order = new Map(channels.map((c, i) => [c, i]));
  return new Map([...found].sort((a, b) => order.get(a[0])! - order.get(b[0])!));
}

const splitKey = (key: string) => {
  const i = key.indexOf('+');
  return { source: key.slice(0, i), id: key.slice(i + 1) };
};

export async function loadLiveFavorites(sourceKey: string, channels: Channel[]): Promise<Map<Channel, string>> {
  const favs = (await FavoriteManager.getAll()) ?? {};
  return matchLiveFavorites(favs, sourceKey, channels);
}

/** 收藏，返回存储 key */
export async function addLiveFavorite(sourceKey: string, sourceName: string, ch: Channel): Promise<string> {
  const { source, id } = liveFavoriteRef(sourceKey, ch);
  await FavoriteManager.save(source, id, buildLiveFavorite(sourceKey, sourceName, ch));
  return `${source}+${id}`;
}

export async function removeLiveFavorite(storageKey: string): Promise<void> {
  const { source, id } = splitKey(storageKey);
  await FavoriteManager.remove(source, id);
}
