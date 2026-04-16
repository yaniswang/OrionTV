import { create } from "zustand";
import { Favorite, FavoriteManager } from "@/services/storage";
import { PlayRecordManager } from "@/services/storage";

interface FavoritesState {
  favorites: (Favorite & { key: string })[];
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
      const favoritesArray = [];
      Object.entries(favoritesData).map(([key, value]) => {
        let isNew = false;
        const favoriteObj = { ...value, key }
        const playRecord = playRecords[key];
        if(playRecord) {
          favoriteObj['episode_index'] = playRecord['index'];
          favoriteObj['progress'] = playRecord.play_time / playRecord.total_time;
          if (favoriteObj['total_episodes'] > playRecord['index']) {
            isNew = true;
          }
        }
        if (isNew) {
          // 有看过并且有更新，显示在最前面
          favoritesArray.unshift(favoriteObj);
        } else {
          favoritesArray.push(favoriteObj);
        }
      });
      //   favoritesArray.sort((a, b) => (b.save_time || 0) - (a.save_time || 0));
      set({ favorites: favoritesArray, loading: false });
    } catch (e) {
      const error = e instanceof Error ? e.message : "获取收藏列表失败";
      set({ error, loading: false });
    }
  },
}));

export default useFavoritesStore;
