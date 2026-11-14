import { create } from "zustand";
import { Favorite, FavoriteManager, PlayRecord } from "@/services/storage";
import { PlayRecordManager } from "@/services/storage";
import { getRecordEpisodeBadge } from "@/utils/EpisodeLabelUtils";

type FavoriteRow = Favorite & {
  key: string;
  /** 卡片角标（见 getRecordEpisodeBadge）；undefined 时按 episode_index/total_episodes 显示 */
  episodeBadge?: string;
};

/**
 * 收藏是否有更新（未看完）：收藏和播放记录都是 App 按片源标题写的，就用真实集号比；
 * 否则按原来的 条数 > 看到第几条。
 */
const hasNewEpisodes = (favorite: Favorite, record?: PlayRecord): boolean => {
  if (favorite.episode_total && record?.episode_title) {
    // 正在看番外（没有集号）时不算未看完
    return !!record.episode_number && favorite.episode_total > record.episode_number;
  }
  return favorite.total_episodes > (record?.index ?? favorite.episode_index);
};

interface FavoritesState {
  favorites: FavoriteRow[];
  loading: boolean;
  error: string | null;
  fetchFavorites: () => Promise<void>;
}

const useFavoritesStore = create<FavoritesState>((set) => ({
  favorites: [],
  loading: false,
  error: null,
  fetchFavorites: async () => {
    set({ loading: true, error: null });
    try {
      const favoritesData = await FavoriteManager.getAll();
      const playRecords = await PlayRecordManager.getAll();
      const favoritesArray: (FavoriteRow & { isNew: boolean })[] = [];
      Object.entries(favoritesData).map(([key, value]) => {
        // 直播频道收藏只在直播页的「收藏」分组里显示
        if (value?.origin === 'live') return;
        const favoriteObj: FavoriteRow & { isNew: boolean } = { ...value, key, isNew: false };
        const playRecord = playRecords[key];
        if(playRecord) {
          favoriteObj['episode_index'] = playRecord['index'];
          favoriteObj['progress'] = playRecord.play_time / playRecord.total_time;
          favoriteObj.episodeBadge = getRecordEpisodeBadge(playRecord);
        }
        favoriteObj.isNew = hasNewEpisodes(value, playRecord);
        favoritesArray.push(favoriteObj);
      });
      favoritesArray.sort((a, b) => {
        if (a.isNew !== b.isNew) {
          return a.isNew ? -1 : 1;
        }
        return (b.save_time || 0) - (a.save_time || 0)
      });
      set({ favorites: favoritesArray, loading: false });
    } catch (e) {
      const error = e instanceof Error ? e.message : "获取收藏列表失败";
      set({ error, loading: false });
    }
  },
}));

export default useFavoritesStore;
