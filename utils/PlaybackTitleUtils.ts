export interface PlaybackTitleParts {
  title: string;
  episodeCount: number;
  episodeTitle?: string;
  sourceName?: string;
}

/** 播放页标题文本；只拼接可见文字，不包含投屏、代理等图标。 */
export function buildPlaybackTitle({
  title,
  episodeCount,
  episodeTitle,
  sourceName,
}: PlaybackTitleParts): string {
  const episodePart = episodeCount > 1 && episodeTitle ? ` - ${episodeTitle}` : '';
  const sourcePart = sourceName ? ` (${sourceName})` : '';
  return `${title}${episodePart}${sourcePart}`;
}
