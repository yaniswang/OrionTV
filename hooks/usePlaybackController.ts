import useDlnaStore from '@/stores/dlnaStore';
import useDetailStore, { type SearchResultWithResolution } from '@/stores/detailStore';
import usePlayerStore from '@/stores/playerStore';
import SystemSetting from 'react-native-system-setting';
import { Platform } from 'react-native';
import { gammaToLinear, linearToGamma } from '@/utils/BrightnessUtils';

/** 播放倍速使用软件内置的固定速率，本地与投屏一致。 */
export const LOCAL_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];

export interface PlaybackStatus {
  isLoaded: boolean;
  isPlaying: boolean;
  durationMillis: number;
  positionMillis: number;
  playableDurationMillis: number;
  didJustFinish: boolean;
}

export const usePlaybackController = () => {
  const isCasting = useDlnaStore((state) => state.enabled);
  const dlnaPhase = useDlnaStore((state) => state.phase);
  const dlnaPosition = useDlnaStore((state) => state.positionMillis);
  const dlnaDuration = useDlnaStore((state) => state.durationMillis);
  const dlnaPlaying = useDlnaStore((state) => state.isPlaying);
  const dlnaSeekSupported = useDlnaStore((state) => state.isSeekSupported);
  const dlnaIsSeeking = useDlnaStore((state) => state.isSeeking);
  const dlnaSeekPosition = useDlnaStore((state) => state.seekPosition);
  const dlnaMediaLoading = useDlnaStore((state) => state.mediaLoading);
  const dlnaPlaybackRate = useDlnaStore((state) => state.playbackRate);
  const getCastVolume = useDlnaStore((state) => state.getVolume);
  const setCastVolume = useDlnaStore((state) => state.setVolume);
  const getCastBrightness = useDlnaStore((state) => state.getBrightness);
  const setCastBrightness = useDlnaStore((state) => state.setBrightness);
  const enableCast = useDlnaStore((state) => state.enableCast);
  const disableCast = useDlnaStore((state) => state.disableCast);
  const toggleCastPlayPause = useDlnaStore((state) => state.togglePlayPause);
  const seekCast = useDlnaStore((state) => state.seekBy);
  const previewCastSeek = useDlnaStore((state) => state.previewSeekBy);
  const commitCastSeek = useDlnaStore((state) => state.commitSeek);
  const setCastPlaybackRate = useDlnaStore((state) => state.setPlaybackRate);
  const playCastEpisode = useDlnaStore((state) => state.playEpisode);
  const syncCastMedia = useDlnaStore((state) => state.syncCurrentMedia);

  const localStatus = usePlayerStore((state) => state.status);
  const localProgressPosition = usePlayerStore((state) => state.progressPosition);
  const localBufferedPosition = usePlayerStore((state) => state.bufferedPosition);
  const localIsSeeking = usePlayerStore((state) => state.isSeeking);
  const localSeekPosition = usePlayerStore((state) => state.seekPosition);
  const localPlaybackRate = usePlayerStore((state) => state.playbackRate);
  const localVideoLoading = usePlayerStore((state) => state.isVideoLoading);
  const localDetailLoading = usePlayerStore((state) => state.isDetialLoading);
  const toggleLocalPlayPause = usePlayerStore((state) => state.togglePlayPause);
  const seekLocal = usePlayerStore((state) => state.seek);
  const setLocalPlaybackRate = usePlayerStore((state) => state.setPlaybackRate);
  const playLocalEpisode = usePlayerStore((state) => state.playEpisode);
  const loadLocalVideo = usePlayerStore((state) => state.loadVideo);

  const status: PlaybackStatus = isCasting
    ? {
        isLoaded: dlnaPhase === 'connected',
        isPlaying: dlnaPlaying,
        durationMillis: dlnaDuration,
        positionMillis: dlnaPosition,
        playableDurationMillis: 0,
        didJustFinish: false,
      }
    : localStatus;

  const selectSource = async (item: SearchResultWithResolution) => {
    const detail = useDetailStore.getState().detail;
    if (detail?.source === item.source && detail?.id === item.id) return;

    // 切源前抓取统一续播快照；本地与投屏使用同一份位置和播放状态。
    const casting = isCasting;
    const resumePosition = status.isLoaded ? status.positionMillis : undefined;
    const resumePlaying = status.isPlaying;

    await useDetailStore.getState().setDetail(item);
    const player = usePlayerStore.getState();
    const episodeIndex = Math.min(
      Math.max(0, player.currentEpisodeIndex),
      Math.max(0, item.episodes.length - 1),
    );
    await loadLocalVideo({
      source: item.source,
      id: item.id,
      q: useDetailStore.getState().q ?? undefined,
      title: item.title,
      year: item.year || '',
      stype: item.episodes.length > 1 ? 'tv' : 'movie',
      episodeIndex,
      position: resumePosition,
    });
    if (casting) {
      // 不阻塞 selectSource，保持和本地一致：弹窗关闭后再显示投屏加载提示。
      void syncCastMedia({
        positionMillis: resumePosition ?? 0,
        play: resumePlaying,
      });
    }
  };

  // 切源准备阶段（详情初始化、源测速等）与本地播放共用 isDetialLoading。
  const isLoading = isCasting
    ? dlnaMediaLoading || localDetailLoading
    : localVideoLoading || localDetailLoading;
  // 本地与投屏共用同一套加载提示，切换片集/片源时才出现。
  const loadingText = '加载视频中...';

  const getVolume = async (): Promise<number | null> => {
    if (isCasting) return getCastVolume();
    return Math.max(0, Math.min(1, await SystemSetting.getVolume()));
  };

  const setVolume = async (value: number): Promise<void> => {
    const next = Math.max(0, Math.min(1, value));
    if (isCasting) {
      await setCastVolume(next);
      return;
    }
    await SystemSetting.setVolume(next);
  };

  const getBrightness = async (): Promise<number | null> => {
    // DLNA 亮度使用标准 0..1 值，不做 Android 本地亮度曲线转换。
    if (isCasting) return getCastBrightness();
    const linear = Math.max(0, Math.min(1, await SystemSetting.getAppBrightness()));
    return Platform.OS === 'android' ? linearToGamma(linear) : linear;
  };

  const setBrightness = async (value: number): Promise<void> => {
    const next = Math.max(0, Math.min(1, value));
    // DLNA 亮度直接下发标准值，只由远端设备决定是否支持。
    if (isCasting) {
      await setCastBrightness(next);
      return;
    }
    const linear = Platform.OS === 'android' ? gammaToLinear(next) : next;
    await SystemSetting.setAppBrightness(linear);
  };

  const durationMillis = status.durationMillis || 0;
  const progressPosition = isCasting
    ? durationMillis > 0
      ? status.positionMillis / durationMillis
      : 0
    : localProgressPosition;

  return {
    isCasting,
    isLoading,
    loadingText,
    isSeekSupported: !isCasting || dlnaSeekSupported,
    getVolume,
    setVolume,
    getBrightness,
    setBrightness,
    status,
    progressPosition,
    bufferedPosition: isCasting ? 0 : localBufferedPosition,
    isSeeking: isCasting ? dlnaIsSeeking : localIsSeeking,
    seekPosition: isCasting ? dlnaSeekPosition : localSeekPosition,
    playbackRate: isCasting ? dlnaPlaybackRate : localPlaybackRate,
    availablePlaybackRates: LOCAL_PLAYBACK_RATES,
    setPlaybackRate: isCasting ? setCastPlaybackRate : setLocalPlaybackRate,
    enableCast,
    disableCast,
    togglePlayPause: isCasting ? toggleCastPlayPause : toggleLocalPlayPause,
    seekBy: isCasting ? seekCast : seekLocal,
    previewSeekBy: isCasting ? previewCastSeek : seekLocal,
    commitSeek: isCasting ? commitCastSeek : async () => {},
    playEpisode: isCasting ? playCastEpisode : playLocalEpisode,
    syncCurrentMedia: syncCastMedia,
    selectSource,
  };
};
