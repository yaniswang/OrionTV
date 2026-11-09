jest.mock('../storage', () => ({ FavoriteManager: {} }));

import { Channel } from '../m3u';
import { liveFavoriteRef, buildLiveFavorite, matchLiveFavorites } from '../liveFavorites';

const ch = (name: string, webIndex: number | undefined, extra: Partial<Channel> = {}): Channel => ({
  id: `https://a/${name}`, url: `https://a/${name}`, name, logo: '', group: 'g', tvgId: '', tvgName: '', webIndex, ...extra,
});

const fav = (title: string, origin?: 'live' | 'vod') => ({
  title, source_name: 's', year: '', cover: '', total_episodes: 1, episode_index: 0, progress: 0, search_title: '', ...(origin ? { origin } : {}),
});

describe('liveFavoriteRef', () => {
  it('与网页版一致：live_{源}+live_{源}-{序号}', () => {
    expect(liveFavoriteRef('src', ch('A', 3))).toEqual({ source: 'live_src', id: 'live_src-3' });
  });
  it('网页版没有的频道（无序号）按名称记', () => {
    expect(liveFavoriteRef('src', ch('B', undefined))).toEqual({ source: 'live_src', id: 'live_src-B' });
  });
});

describe('buildLiveFavorite', () => {
  it('字段与网页版一致，台标走服务器代理', () => {
    const item = buildLiveFavorite('src', '直播源', ch('A', 0, { logo: 'https://l/a.png' }));
    expect(item).toMatchObject({
      title: 'A', source_name: '直播源', year: '', total_episodes: 1, search_title: '', origin: 'live',
      cover: '/api/proxy/logo?url=https%3A%2F%2Fl%2Fa.png&source=src',
    });
  });
});

describe('matchLiveFavorites', () => {
  const channels = [ch('A', 0), ch('B', 1), ch('C', 2), ch('D', undefined)];

  it('按序号找到并核对名称，结果按频道原顺序排', () => {
    const favs = {
      'live_src+live_src-2': fav('C', 'live'),
      'live_src+live_src-0': fav('A', 'live'),
    };
    const m = matchLiveFavorites(favs, 'src', channels);
    expect([...m.keys()].map((c) => c.name)).toEqual(['A', 'C']);
    expect(m.get(channels[0])).toBe('live_src+live_src-0');
  });

  it('序号对应的频道名称不同（m3u 换序）时按名称找', () => {
    const m = matchLiveFavorites({ 'live_src+live_src-0': fav('B', 'live') }, 'src', channels);
    expect([...m.keys()].map((c) => c.name)).toEqual(['B']);
    expect(m.get(channels[1])).toBe('live_src+live_src-0');
  });

  it('按名称记的收藏、名称找不到的、别的源的、影视收藏都不算', () => {
    const favs = {
      'live_src+live_src-D': fav('D', 'live'),
      'live_src+live_src-9': fav('Z', 'live'),
      'live_other+live_other-0': fav('A', 'live'),
      'src+123': fav('A'),
    };
    expect([...matchLiveFavorites(favs, 'src', channels).keys()].map((c) => c.name)).toEqual(['D']);
  });

  it('同一频道收藏了两次只算一个', () => {
    const favs = { 'live_src+live_src-0': fav('A', 'live'), 'live_src+live_src-A': fav('A', 'live') };
    expect(matchLiveFavorites(favs, 'src', channels).size).toBe(1);
  });
});
