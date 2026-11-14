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
  // 用片名而不是源标题：源标题可能带"国语1995"之类后缀，会搜不到弹幕
  const title = useDetailStore((state) => (state.detail ? state.title || state.detail.title : ""));
  const year = useDetailStore((state) => state.detail?.year || "");
  const source = useDetailStore((state) => state.detail?.source || "");
  const detailId = useDetailStore((state) => state.detail?.id);
  const episodeIndex = usePlayerStore((state) => state.currentEpisodeIndex);
  const episodeCount = usePlayerStore((state) => state.episodes.length);
  // 片源原始分集标题：播放器里的 "第 N 集" 是按位置生成的，解析不出真实集号
  const episodeTitle = useDetailStore(
    (state) => state.detail?.episodes_titles?.[episodeIndex] || "",
  );
  // 整个列表：多版本电影等规则要看整列表（引用随 detail 变化，切集不会变）
  const episodeTitles = useDetailStore((state) => state.detail?.episodes_titles);

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
      episodeTitles,
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
    episodeTitles,
    loadForEpisode,
  ]);
};

export default useDanmakuAutoLoad;
