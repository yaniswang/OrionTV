import Toast from '@/utils/Toast';

export type PlaybackSkipKind = 'intro' | 'outro';

const SKIP_MESSAGES: Record<PlaybackSkipKind, string> = {
  intro: '已跳过片头',
  outro: '已跳过片尾',
};
const NOTICE_DEDUPE_MS = 1000;
let lastNotice: { kind: PlaybackSkipKind; at: number } | null = null;

/** 本地播放与 DLNA 投屏共用同一套跳过提示逻辑。 */
export function notifyPlaybackSkip(kind: PlaybackSkipKind): void {
  const now = Date.now();
  if (lastNotice?.kind === kind && now - lastNotice.at < NOTICE_DEDUPE_MS) return;

  lastNotice = { kind, at: now };
  Toast.show({ type: 'info', text1: SKIP_MESSAGES[kind] });
}