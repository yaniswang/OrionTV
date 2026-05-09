import { useCallback, useMemo } from 'react';
import { ResizeMode, OnLoadData, OnPlaybackStateChangedData, ViewType } from 'react-native-video';
import Toast from 'react-native-toast-message';
import usePlayerStore from '@/stores/playerStore';
import Logger from '@/utils/Logger';
const logger = Logger.withTag('useVideoHandlers');

interface UseVideoHandlersProps {
  currentEpisode: { url: string; title: string } | undefined;
  playbackRate: number;
  handleVideoProgress: (status: any) => void;
  handleVideoLoad: (data: OnLoadData) => void;
  handleVideoEnd: () => void;
  handleVideoPlaybackStateChanged: (data: OnPlaybackStateChangedData) => void;
  deviceType: string;
  detail?: { poster?: string };
}

export const useVideoHandlers = ({
  currentEpisode,
  playbackRate,
  handleVideoProgress,
  handleVideoLoad,
  handleVideoEnd,
  handleVideoPlaybackStateChanged,
  deviceType,
  detail,
}: UseVideoHandlersProps) => {

  const onLoadStart = useCallback(() => {
    if (!currentEpisode?.url) return;
    
    logger.info(`[PERF] Video onLoadStart - starting to load video: ${currentEpisode.url.substring(0, 100)}...`);
    usePlayerStore.setState({ isVideoLoading: true });
  }, [currentEpisode?.url]);

  const onError = useCallback((error: any) => {
    if (!currentEpisode?.url) return;
    
    logger.error(`[ERROR] Video playback error:`, JSON.stringify(error));
    
    // 检测SSL证书错误和其他网络错误
    const errorString = (error as any)?.error?.toString() || error?.toString() || '';
    const isSSLError = errorString.includes('SSLHandshakeException') || 
                      errorString.includes('CertPathValidatorException') ||
                      errorString.includes('Trust anchor for certification path not found');
    const isNetworkError = errorString.includes('HttpDataSourceException') ||
                         errorString.includes('IOException') ||
                         errorString.includes('SocketTimeoutException');
    
    if (isSSLError) {
      logger.error(`[SSL_ERROR] SSL certificate validation failed for URL: ${currentEpisode.url}`);
      Toast.show({ 
        type: "error", 
        text1: "SSL证书错误，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('ssl', currentEpisode.url);
    } else if (isNetworkError) {
      logger.error(`[NETWORK_ERROR] Network connection failed for URL: ${currentEpisode.url}`);
      Toast.show({ 
        type: "error", 
        text1: "网络连接失败，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('network', currentEpisode.url);
    } else {
      logger.error(`[VIDEO_ERROR] Other video error for URL: ${currentEpisode.url}`);
      Toast.show({ 
        type: "error", 
        text1: "视频播放失败，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('other', currentEpisode.url);
    }
  }, [currentEpisode?.url]);

  // 优化的Video组件props
  const videoProps = useMemo(() => ({
    source: {
      uri: currentEpisode?.url || '',
      bufferConfig: {
        minBufferMs: 30000, // 最小缓冲
        maxBufferMs: 60000, // 最大缓冲
        bufferForPlaybackMs: 2500, // 首次起播缓冲量
        bufferForPlaybackAfterRebufferMs: 5000, // 卡顿后恢复缓冲量
        backBufferDurationMs: 60000, // 保留已播放的缓存
        cacheSizeMB: 500, // 缓存大小
        initialBitrate: 3000000, 
      }
    },
    poster: detail?.poster ?? "",
    resizeMode: ResizeMode.CONTAIN,
    rate: playbackRate,
    onProgress : handleVideoProgress,
    onLoad: handleVideoLoad,
    onLoadStart,
    onPlaybackStateChanged: handleVideoPlaybackStateChanged,
    onEnd: handleVideoEnd,
    onError,
    disableAudioSessionManagement: false,
    playWhenInactive: false,
    progressUpdateInterval: 1000,
    playInBackground: false,
    viewType: ViewType.SURFACE,
    disableFocus: true,
    reportBandwidth: true,
  }), [
    currentEpisode?.url,
    detail?.poster,
    playbackRate,
    handleVideoProgress,
    handleVideoLoad,
    onLoadStart,
    handleVideoEnd,
    handleVideoPlaybackStateChanged,
    onError,
    deviceType,
  ]);

  return {
    videoProps,
  };
};