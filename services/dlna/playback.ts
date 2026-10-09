import type { DLNAMediaInfo, DLNATransportState } from './types';

export const REMOTE_SEEK_DURATION_MARGIN_MS = 1000;
export const REMOTE_DURATION_TRANSITION_GRACE_MS = 15000;
/** 电视常在标称时长前几秒就结束（最后一个分片偏短，实测 Macast 差 8 秒），结尾这段时间内停止都算播完。 */
export const REMOTE_END_THRESHOLD_MS = 15000;


/**
 * 位置从正数突然回到 0 时，需要区分两种情况：
 * - 用户在投屏端把进度拖回最开头：此时传输状态仍是播放/暂停，应接受这个 0；
 * - 被控端在 EOF/停止时把位置重置为 0：此时传输状态是停止/无媒体，应保留最后进度。
 * 状态未知（查询失败）时按重置处理，宁可短暂显示旧进度，也不要把进度弄丢。
 */
export function shouldApplyRemotePosition(
  previousMillis: number,
  remoteMillis: number,
  transportState: DLNATransportState,
): boolean {
  if (remoteMillis > 0 || previousMillis <= 0) return true;
  return transportState === 'PLAYING' || transportState === 'PAUSED_PLAYBACK';
}

/**
 * Macast/MPV 加载新的 HLS 时，会先把首个分片或局部时长当成总时长。
 * 恢复点超出这个过渡时长时不能立即 Seek，否则会被 MPV 钳到片尾。
 */
export function isRemoteDurationReady(
  durationMillis: number,
  targetPositionMillis: number,
): boolean {
  if (targetPositionMillis <= 0) return true;
  return durationMillis > targetPositionMillis + REMOTE_SEEK_DURATION_MARGIN_MS;
}

/**
 * 确认 GetPositionInfo 返回的是本次新设置的媒体。
 * 部分电视在 SetAVTransportURI 后会短暂返回旧媒体的时长；若此时 Seek，
 * 请求可能落在旧媒体上，导致新媒体最终从 0 开始播放。
 * 设备不提供 TrackURI 时无法校验，继续沿用旧逻辑。
 */
export function isSameRemoteTrackUri(remoteTrackUri: string, expectedTrackUri: string): boolean {
  const remote = remoteTrackUri.trim();
  const expected = expectedTrackUri.trim();
  if (!remote || !expected || remote === expected) return true;

  try {
    return new URL(remote).href === new URL(expected).href;
  } catch {
    return false;
  }
}

export function isRemotePositionAtEnd(
  positionMillis: number,
  durationMillis: number,
): boolean {
  return durationMillis > 0 && positionMillis >= durationMillis - REMOTE_END_THRESHOLD_MS;
}

/**
 * 过滤 GENA 事件中加载初期出现的首片/局部时长，优先保留本机已确认的真实时长。
 * 没有期望时长时，也忽略加载初期明显变短的过渡值。
 */
export function resolveRemoteDuration(
  previousDurationMillis: number,
  remoteDurationMillis: number,
  mediaLoadingElapsedMs: number,
  expectedDurationMillis = 0,
): number {
  if (remoteDurationMillis <= 0) return previousDurationMillis;

  if (
    expectedDurationMillis > 0 &&
    remoteDurationMillis < expectedDurationMillis * 0.95
  ) {
    return previousDurationMillis;
  }

  const looksLikeTransitionalShortDuration =
    previousDurationMillis > 0 &&
    previousDurationMillis - remoteDurationMillis > 60_000 &&
    remoteDurationMillis < previousDurationMillis / 2;

  if (
    looksLikeTransitionalShortDuration &&
    mediaLoadingElapsedMs < REMOTE_DURATION_TRANSITION_GRACE_MS
  ) {
    return previousDurationMillis;
  }

  return remoteDurationMillis;
}

/**
 * 只有本机确认过远端真正播放后，STOPPED / NO_MEDIA_PRESENT 才视为“远端结束或关闭”。
 * 手机主动切换片集/片源时会把 playbackConfirmed 置为 false，此时远端因
 * SetAVTransportURI 产生的停止事件不能触发退出投屏。
 */
export function shouldHandleRemoteTerminalState(
  transportState: DLNATransportState,
  playbackConfirmed: boolean,
  suppressAutoAdvance: boolean,
): boolean {
  if (suppressAutoAdvance || !playbackConfirmed) return false;
  return transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT';
}

/**
 * 播放确认前，STOPPED/NO_MEDIA_PRESENT 可能只是设备刚订阅时补发的旧状态；
 * 此时不能据此停止等待位置推进。
 */
export function shouldIgnoreUnconfirmedTerminalState(
  transportState: DLNATransportState,
  playbackConfirmed: boolean,
): boolean {
  if (playbackConfirmed) return false;
  return transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT';
}

export type RemoteLoadVerdict = 'loaded' | 'failed' | 'pending';

/** 电视已没有可播放的媒体：当前地址为空或曲目数为 0（红米、Kodi 加载失败时实测如此）。 */
export function isRemoteMediaDropped(media: DLNAMediaInfo): boolean {
  return media.currentUri.trim() === '' || media.numberOfTracks === 0;
}

/**
 * 推送新媒体后的加载判定，保守策略（与 Kodi 自带投屏控制端一致）：只认明确失败，无法判断的当作还在播放。
 * - 成功：PLAYING / PAUSED_PLAYBACK，且有播放证据（电视已报出时长或进度）。
 *   Kodi、Macast 加载中就报 PLAYING，此时时长和进度都是 0，不能算成功；
 *   红米播直播时时长和进度恒为 0，会一直观察到观察期结束，不影响播放。
 * - 明确失败：TransportStatus=ERROR_OCCURRED；NO_MEDIA_PRESENT；STOPPED 且电视已丢掉媒体。
 * - 无法判断：STOPPED 但仍持有媒体（Macast 播放中切换片源时，加载期间就报 STOPPED）、TRANSITIONING、未知。
 * 保护期内一律等待：换片时旧媒体会先报一次 STOPPED。
 */
export function judgeRemoteLoad(
  transportState: DLNATransportState,
  transportStatus: string,
  inGracePeriod: boolean,
  mediaDropped: boolean,
  hasPlaybackEvidence: boolean,
): RemoteLoadVerdict {
  if (inGracePeriod) return 'pending';
  if (transportStatus.toUpperCase() === 'ERROR_OCCURRED') return 'failed';
  if (transportState === 'PLAYING' || transportState === 'PAUSED_PLAYBACK') {
    return hasPlaybackEvidence ? 'loaded' : 'pending';
  }
  if (transportState === 'NO_MEDIA_PRESENT') return 'failed';
  if (transportState === 'STOPPED' && mediaDropped) return 'failed';
  return 'pending';
}

/** 标准 TransportState=PLAYING 可作为播放已开始的确认；位置推进作为另一条确认路径。 */
export function shouldConfirmPlaybackFromTransportState(
  transportState: DLNATransportState,
  playbackConfirmed: boolean,
): boolean {
  return !playbackConfirmed && transportState === 'PLAYING';
}

/**
 * 被控端在缓冲阶段就可能上报 PLAYING，只有再次采样到更大的播放位置，
 * 才能确认远端真正开始播放。
 */
export function hasRemotePlaybackStarted(
  anchorMillis: number | null,
  currentMillis: number,
): boolean {
  return anchorMillis !== null && currentMillis > anchorMillis;
}