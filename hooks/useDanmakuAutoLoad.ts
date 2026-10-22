import { useEffect } from "react";
import { useDanmakuStore } from "@/stores/danmakuStore";
import { useSettingsStore } from "@/stores/settingsStore";
import useDetailStore from "@/stores/detailStore";
import usePlayerStore from "@/stores/playerStore";

export const useDanmakuAutoLoad = () => {
  const hydrate = useDanmakuStore((state) => state.hydrate);
  const hydrated = useDanmakuStore((state) => state.hydrated);
  const enabled = useDanmakuStore((state) => state.enabled);
  const loadForEpisode = useDanmakuStore((state) => state.loadForEpisode);
  const apiUrl = useSettingsStore((state) => state.danmakuApiUrl);
  const title = useDetailStore((state) => state.detail?.title || "");
  const year = useDetailStore((state) => state.detail?.year || "");
  const source = useDetailStore((state) => state.detail?.source || "");
  const detailId = useDetailStore((state) => state.detail?.id);
  const episodeIndex = usePlayerStore((state) => state.currentEpisodeIndex);
  const episodeCount = usePlayerStore((state) => state.episodes.length);
  const episodeTitle = usePlayerStore(
    (state) => state.episodes[state.currentEpisodeIndex]?.title || "",
  );

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    // 换源时剧集会被短暂清空，此时不加载，避免按 0 集多发一次匹配请求
    if (!hydrated || !enabled || !apiUrl.trim() || !title || episodeIndex < 0 || episodeCount <= 0) return;
    void loadForEpisode({
      title,
      year,
      source,
      id: detailId?.toString(),
      episodeIndex,
      episodeCount,
      episodeTitle,
    });
  }, [
    hydrated,
    enabled,
    apiUrl,
    title,
    year,
    source,
    detailId,
    episodeIndex,
    episodeCount,
    episodeTitle,
    loadForEpisode,
  ]);
};

export default useDanmakuAutoLoad;
