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
      let playRecords = await PlayRecordManager.getAll();
      playRecords = Object.entries(playRecords).map(([key, record]) => {
        return {...record}
      }).sort((a, b) => (b.save_time || 0) - (a.save_time || 0));
      const favoritesArray = [];
      Object.entries(favoritesData).map(([key, value]) => {
        const favoriteObj = { ...value, key }
        const { title, total_episodes, year } = favoriteObj;
        const stype = total_episodes > 1 ? 'tv' : 'movie';
        let playRecord = playRecords.find((item: any) => {
          const itemStype = item.total_episodes > 1 ? 'tv' : 'movie';
          return item.title.replace(' ', '') == title && item.year == year && (stype !== undefined && itemStype === stype || stype === undefined)
        });
        if(playRecord) {
          favoriteObj['episode_index'] = playRecord['index'];
          favoriteObj['progress'] = playRecord.play_time / playRecord.total_time;
          favoriteObj['source'] = playRecord['source'];
          favoriteObj['source_name'] = playRecord['source_name'];
        }
        favoritesArray.push(favoriteObj);
      });
      favoritesArray.sort((a, b) => {
        const isANew = a['total_episodes'] > a['episode_index'] ? 1 : 0;
        const isBNew = b['total_episodes'] > b['episode_index'] ? 1 : 0;
        if (isANew !== isBNew) {
          return isBNew - isANew;
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
