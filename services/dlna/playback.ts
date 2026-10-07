import type { DLNATransportState } from './types';

export const REMOTE_SEEK_DURATION_MARGIN_MS = 1000;
export const REMOTE_DURATION_TRANSITION_GRACE_MS = 15000;
export const REMOTE_END_THRESHOLD_MS = 3000;


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
 * 被控端在缓冲阶段就可能上报 PLAYING，只有再次采样到更大的播放位置，
 * 才能确认远端真正开始播放。
 */
export function hasRemotePlaybackStarted(
  anchorMillis: number | null,
  currentMillis: number,
): boolean {
  return anchorMillis !== null && currentMillis > anchorMillis;
}