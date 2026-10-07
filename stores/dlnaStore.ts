import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { DlnaController } from '@/services/dlna/control';
import { startDlnaDiscovery, type DLNADiscoveryHandle } from '@/services/dlna/discovery';
import { subscribeToDlnaEvents, type DLNAEventSubscription } from '@/services/dlna/events';
import type {
  DLNACastPhase,
  DLNAControlCapabilities,
  DLNADevice,
  DLNATransportState,
} from '@/services/dlna/types';
import usePlayerStore, { selectCurrentEpisode } from '@/stores/playerStore';
import useDetailStore from '@/stores/detailStore';
import { cancelProxyDownloads, ensureLocalProxy, isHlsUrl, isLanProxyOrigin, resolvePlayUrl } from '@/services/localProxy';
import { parseDeviceDescription } from '@/services/dlna/xml';
import {
  isRemoteDurationReady,
  hasRemotePlaybackStarted,
  isRemotePositionAtEnd,
  resolveRemoteDuration,
  shouldApplyRemotePosition,
  shouldHandleRemoteTerminalState,
} from '@/services/dlna/playback';
import Logger from '@/utils/Logger';

const logger = Logger.withTag('DLNA');
const LAST_DEVICE_KEY = 'oriontv_dlna_last_device';
const REMOTE_DURATION_READY_TIMEOUT_MS = 15000;
const REMOTE_DURATION_RETRY_INTERVAL_MS = 250;
/** 播放中按标准 GetPositionInfo 同步远端时间，非播放状态不轮询。 */
const POSITION_POLL_INTERVAL_MS = 500;
/** 切换投屏媒体后等待远端确认播放的加载提示最长展示时间。 */
const MEDIA_LOADING_TIMEOUT_MS = 60000;
const REMOTE_POSITION_RANGE_TOLERANCE_MS = 2000;

interface LocalPlaybackSnapshot {
  positionMillis: number;
  durationMillis: number;
  isPlaying: boolean;
}

interface DLNAState {
  enabled: boolean;
  phase: DLNACastPhase;
  devices: DLNADevice[];
  currentDevice: DLNADevice | null;
  connectingDeviceId: string | null;
  connectingDeviceName: string | null;
  mediaLoading: boolean;
  transportState: DLNATransportState;
  positionMillis: number;
  durationMillis: number;
  isPlaying: boolean;
  /** 远端已确认真正播放过；用于“开始投屏”到“正在投屏中”的切换 */
  playbackConfirmed: boolean;
  playbackEstablished: boolean;
  playbackRate: number;
  isSeeking: boolean;
  seekPosition: number;
  isSeekSupported: boolean;
  capabilities: DLNAControlCapabilities | null;
  error: string | null;
  localSnapshot: LocalPlaybackSnapshot | null;
  enableCast: () => Promise<void>;
  disableCast: (options?: { restoreLocal?: boolean; stopRemote?: boolean }) => Promise<void>;
  refreshDevices: (options?: { autoConnectLast?: boolean }) => Promise<void>;
  selectDevice: (device: DLNADevice) => Promise<void>;
  syncCurrentMedia: (options?: { positionMillis?: number; play?: boolean; force?: boolean }) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  seekBy: (deltaMillis: number) => Promise<void>;
  previewSeekBy: (deltaMillis: number) => void;
  commitSeek: () => Promise<void>;
  setPlaybackRate: (rate: number) => Promise<void>;
  getVolume: () => Promise<number | null>;
  setVolume: (volume: number) => Promise<void>;
  getBrightness: () => Promise<number | null>;
  setBrightness: (brightness: number) => Promise<void>;
  playEpisode: (index: number) => Promise<void>;
  clearError: () => void;
}

let controller: DlnaController | null = null;
let discovery: DLNADiscoveryHandle | null = null;
let eventSubscription: DLNAEventSubscription | null = null;
let suppressAutoAdvance = false;
let terminalSyncBusy = false;
let pendingAutoConnectId: string | null = null;
let autoConnectTriggered = false;
let sessionId = 0;
let mediaLoadStartedAt = 0;
let expectedRemoteDurationMillis = 0;
let lastSyncedUri: string | null = null;
let positionPollTimer: NodeJS.Timeout | null = null;
let positionPollBusy = false;
let mediaLoadingTimer: NodeJS.Timeout | null = null;
let mediaLoadingGeneration = 0;
/** 判定远端真正开始播放用的位置采样点。 */
let positionProgressAnchorMillis: number | null = null;
let skipOutroBusy = false;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 与本地一致：没有指定续播位置时，从片头结束位置开始。 */
function resolveIntroPosition(positionMillis: number): number {
  if (positionMillis > 0) return positionMillis;
  const introEndTime = usePlayerStore.getState().introEndTime ?? 0;
  return introEndTime > 0 ? introEndTime : 0;
}

function getCastMetadata(): { title: string; coverUrl?: string } {
  const player = usePlayerStore.getState();
  const detail = useDetailStore.getState().detail;
  const index = player.currentEpisodeIndex;
  const episode = player.episodes[index] ?? selectCurrentEpisode(player);
  const fallbackTitle = episode?.title || detail?.title || 'OrionTV';
  if (!detail) return { title: fallbackTitle };

  const isSeries = detail.episodes.length > 1;
  const episodeNumber = Math.max(1, index + 1);
  return {
    title: isSeries ? `${detail.title} 第${episodeNumber}集` : detail.title,
    coverUrl: detail.poster || undefined,
  };
}

function initialState() {
  return {
    phase: 'idle' as DLNACastPhase,
    devices: [],
    currentDevice: null,
    connectingDeviceId: null,
    connectingDeviceName: null,
    mediaLoading: false,
    transportState: 'UNKNOWN' as DLNATransportState,
    positionMillis: 0,
    durationMillis: 0,
    isPlaying: false,
    playbackConfirmed: false,
    playbackEstablished: false,
    playbackRate: 1,
    isSeeking: false,
    seekPosition: 0,
    isSeekSupported: true,
    capabilities: null,
    error: null,
  };
}

function stopDiscovery() {
  discovery?.stop();
  discovery = null;
}

async function stopEventSubscription() {
  const current = eventSubscription;
  eventSubscription = null;
  if (!current) return;
  try {
    await current.stop();
  } catch {}
}

function sortDevices(devices: DLNADevice[]): DLNADevice[] {
  return [...devices].sort((a, b) => {
    if (pendingAutoConnectId === a.id) return -1;
    if (pendingAutoConnectId === b.id) return 1;
    return a.friendlyName.localeCompare(b.friendlyName, 'zh-CN');
  });
}

interface RememberedDevice {
  id: string;
  device: DLNADevice | null;
}

function isDLNADevice(value: unknown): value is DLNADevice {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<DLNADevice>;
  return (
    typeof device.id === 'string' &&
    typeof device.udn === 'string' &&
    typeof device.friendlyName === 'string' &&
    typeof device.location === 'string' &&
    typeof device.controlUrl === 'string' &&
    typeof device.serviceType === 'string'
  );
}

async function loadRememberedDevice(): Promise<RememberedDevice | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_DEVICE_KEY);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isDLNADevice(parsed)) return { id: parsed.id, device: parsed };
      if (parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'string') {
        return { id: (parsed as { id: string }).id, device: null };
      }
    } catch {
      // 兼容旧版本只保存设备 id 的格式。
    }

    return { id: raw, device: null };
  } catch (error) {
    logger.warn('读取上次投屏设备失败', error);
    return null;
  }
}

async function rememberDevice(device: DLNADevice): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device));
  } catch (error) {
    logger.warn('保存投屏设备失败', error);
  }
}

async function refreshDeviceDescription(device: DLNADevice): Promise<DLNADevice> {
  if (device.hasRenderingControlService !== undefined) return device;

  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  try {
    const request = fetch(device.location, { signal: controller.signal });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('读取设备描述超时'));
      }, 5000);
    });
    const response = await Promise.race([request, timeout]);
    if (!response.ok) return device;
    const parsed = parseDeviceDescription(await response.text(), device.location);
    return parsed ? { ...device, ...parsed, id: device.id, udn: device.udn } : device;
  } catch {
    return device;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveCastUri(uri: string): Promise<string> {
  if (!isHlsUrl(uri)) return uri;
  const origin = await ensureLocalProxy();
  if (!origin || !isLanProxyOrigin(origin)) {
    throw new Error('未获取到局域网 IP，请确认手机与电视连接同一网络');
  }
  return resolvePlayUrl(uri);
}

const useDlnaStore = create<DLNAState>((set, get) => {
  const saveRemoteRecord = async () => {
    const state = get();
    if (!state.currentDevice) return;
    await usePlayerStore.getState().savePlayRecord(
      {},
      {
        immediate: true,
        positionMillis: state.positionMillis,
        durationMillis: state.durationMillis,
      },
    );
  };

  const stopPositionPolling = () => {
    if (positionPollTimer) clearInterval(positionPollTimer);
    positionPollTimer = null;
    positionPollBusy = false;
  };

  /** 显示加载提示，直到远端确认开始播放、超时或出错。返回本次切换的代际号。 */
  const beginMediaLoading = (): number => {
    if (mediaLoadingTimer) clearTimeout(mediaLoadingTimer);
    mediaLoadingGeneration += 1;
    const generation = mediaLoadingGeneration;
    mediaLoadingTimer = setTimeout(() => {
      if (mediaLoadingGeneration !== generation) return;
      mediaLoadingTimer = null;
      set({ mediaLoading: false });
    }, MEDIA_LOADING_TIMEOUT_MS);
    set({ mediaLoading: true });
    return generation;
  };

  /** 不传代际号表示强制结束（远端确认播放、断开投屏）；传了则只结束自己发起的那次切换。 */
  const endMediaLoading = (generation?: number) => {
    if (generation !== undefined && generation !== mediaLoadingGeneration) return;
    if (mediaLoadingTimer) {
      clearTimeout(mediaLoadingTimer);
      mediaLoadingTimer = null;
    }
    set({ mediaLoading: false });
  };

  /** 投屏下的跳过片尾：与本地 handleVideoProgress 一致，到点切下一集。 */
  const maybeSkipOutro = (positionMillis: number, durationMillis: number): boolean => {
    if (skipOutroBusy || suppressAutoAdvance || get().mediaLoading) return false;
    const player = usePlayerStore.getState();
    const outroStartTime = player.outroStartTime ?? 0;
    if (outroStartTime <= 0 || durationMillis <= 0) return false;
    if (player.currentEpisodeIndex < 0) return false;
    if (player.currentEpisodeIndex >= player.episodes.length - 1) return false;
    if (positionMillis < durationMillis - outroStartTime) return false;

    skipOutroBusy = true;
    void get().playEpisode(player.currentEpisodeIndex + 1).finally(() => {
      skipOutroBusy = false;
    });
    return true;
  };

  /** 标准 AVTransport GetPositionInfo；上一请求未结束时不重叠发起。 */
  const pollRemotePosition = async (session: number) => {
    if (positionPollBusy) return;
    const activeController = controller;
    if (!activeController || session !== sessionId || get().phase !== 'connected') return;
    const pollState = get();
    // 等待确认开始播放时不能依赖 isPlaying：远端缓冲会先发 TRANSITIONING，
    // 若此时停掉轮询就永远等不到播放确认。
    const awaitingPlayback = !pollState.playbackConfirmed && pollState.mediaLoading;
    if (!pollState.isPlaying && !awaitingPlayback) return;
    if (pollState.isSeeking) return;
    positionPollBusy = true;
    try {
      let transportState: DLNATransportState = 'UNKNOWN';
      if (!get().playbackConfirmed) {
        try {
          const transport = await activeController.getTransportInfo();
          if (session !== sessionId || controller !== activeController) return;
          transportState = transport.state;
        } catch {}
      }
      const position = await activeController.getPositionInfo();
      if (session !== sessionId || controller !== activeController) return;
      const stillAwaitingPlayback = !get().playbackConfirmed && get().mediaLoading;
      if (!get().isPlaying && !stillAwaitingPlayback) return;

      const nextDurationMillis = Math.max(position.trackDurationMillis, get().durationMillis);
      // 规范要求 RelativeTimePosition 落在 0..CurrentTrackDuration 之间；
      // 超出范围说明设备返回的位置不可信，丢弃本次位置。
      const positionInRange =
        nextDurationMillis <= 0 ||
        position.positionMillis <= nextDurationMillis + REMOTE_POSITION_RANGE_TOLERANCE_MS;
      const positionUsable = position.positionSupported && positionInRange;

      // 被控端缓冲阶段就可能报 PLAYING：
      // 提供可用位置时，等 RelTime 真正推进才算开始播放；
      // 位置不可用（NOT_IMPLEMENTED 或超出时长）时，只能接受 PLAYING。
      if (
        !get().playbackConfirmed &&
        (transportState === 'PLAYING' || transportState === 'UNKNOWN')
      ) {
        if (!positionUsable) {
          set({ playbackConfirmed: true, playbackEstablished: true });
          endMediaLoading();
        } else if (hasRemotePlaybackStarted(positionProgressAnchorMillis, position.positionMillis)) {
          set({ playbackConfirmed: true, playbackEstablished: true });
          endMediaLoading();
        } else {
          positionProgressAnchorMillis = position.positionMillis;
        }
      }

      if (!positionUsable) {
        // 位置非法时保留上一次有效位置，只更新时长。
        if (nextDurationMillis > 0 && nextDurationMillis !== get().durationMillis) {
          set({ durationMillis: nextDurationMillis });
        }
        return;
      }

      const previousMillis = get().positionMillis;
      if (position.positionMillis <= 0 && previousMillis > 0) {
        // 位置由正数掉到 0：可能是用户拖回开头，也可能是被控端在 EOF/停止时重置。
        // 用标准 GetTransportInfo 区分，避免把最后进度覆盖成 0。
        const transportState = await activeController
          .getTransportInfo()
          .then((info) => info.state)
          .catch(() => 'UNKNOWN' as DLNATransportState);
        if (session !== sessionId || controller !== activeController) return;
        if (!shouldApplyRemotePosition(previousMillis, position.positionMillis, transportState)) {
          return;
        }
      }
      set({
        positionMillis: position.positionMillis,
        durationMillis: nextDurationMillis,
      });
      if (maybeSkipOutro(position.positionMillis, nextDurationMillis)) return;
    } catch {
      // 单次位置查询失败不终止后续标准轮询。
    } finally {
      positionPollBusy = false;
    }
  };

  const startPositionPolling = (session: number) => {
    stopPositionPolling();
    void pollRemotePosition(session);
    positionPollTimer = setInterval(() => {
      void pollRemotePosition(session);
    }, POSITION_POLL_INTERVAL_MS);
  };

  const previewCastSeekBy = (deltaMillis: number) => {
    const state = get();
    if (!controller || state.phase !== 'connected' || state.durationMillis <= 0) return;
    if (!state.isSeekSupported || state.capabilities?.canSeek === false) return;
    const basePosition = state.isSeeking
      ? state.seekPosition * state.durationMillis
      : state.positionMillis;
    const target = Math.max(0, Math.min(basePosition + deltaMillis, state.durationMillis));
    set({
      isSeeking: true,
      seekPosition: target / state.durationMillis,
    });
  };

  const commitCastSeek = async () => {
    const activeController = controller;
    const state = get();
    if (!activeController || state.phase !== 'connected' || !state.isSeeking || state.durationMillis <= 0) return;
    const target = state.seekPosition * state.durationMillis;
    try {
      await activeController.seekTo(target);
      if (controller !== activeController) return;
      set({ isSeeking: false, positionMillis: target });
    } catch (error) {
      if (controller !== activeController) return;
      set({ isSeeking: false, isSeekSupported: false });
      Toast.show({ type: 'error', text1: error instanceof Error ? error.message : '快进快退失败' });
    }
  };

  const restoreLocalPlayback = (
    positionMillis: number,
    durationMillis: number,
    autoPlay = get().localSnapshot?.isPlaying ?? true,
  ) => {
    const snapshot = get().localSnapshot;
    const safePosition = Math.max(0, Math.min(positionMillis || snapshot?.positionMillis || 0, durationMillis || Number.MAX_SAFE_INTEGER));
    usePlayerStore.setState((state) => ({
      initialPosition: safePosition,
      autoPlayAfterLoad: autoPlay,
      progressPosition: durationMillis > 0 ? safePosition / durationMillis : 0,
      bufferedPosition: 0,
      status: {
        ...state.status,
        isLoaded: false,
        isPlaying: false,
        durationMillis: durationMillis || state.status.durationMillis,
        positionMillis: safePosition,
        playableDurationMillis: 0,
        didJustFinish: false,
      },
      isVideoLoading: true,
    }));
  };

  const disconnect = async (
    restoreLocal: boolean,
    stopRemote: boolean,
    options: { autoPlay?: boolean } = {},
  ) => {
    sessionId += 1;
    stopPositionPolling();
    endMediaLoading();
    positionProgressAnchorMillis = null;
    skipOutroBusy = false;
    suppressAutoAdvance = true;
    stopDiscovery();
    await stopEventSubscription();
    const state = get();
    const positionMillis = state.positionMillis;
    const durationMillis = state.durationMillis;
    if (restoreLocal && state.currentDevice) {
      await saveRemoteRecord();
    }
    if (stopRemote && controller) {
      try {
        await controller.stop();
      } catch {}
    }
    // 远端已停止，取消 TV 侧和手机侧仍可能挂着的回源请求，避免污染下一次本地播放。
    cancelProxyDownloads();
    controller = null;
    pendingAutoConnectId = null;
    autoConnectTriggered = false;
    mediaLoadStartedAt = 0;
    expectedRemoteDurationMillis = 0;
    lastSyncedUri = null;
    terminalSyncBusy = false;
    set({ enabled: false, ...initialState() });
    if (restoreLocal) {
      restoreLocalPlayback(positionMillis, durationMillis, options.autoPlay);
    }
    set({ localSnapshot: null });
    suppressAutoAdvance = false;
  };

  const syncTerminalRemoteState = async (
    session: number,
    wasPlaying: boolean,
    fallbackPositionMillis: number,
    fallbackDurationMillis: number,
  ) => {
    if (terminalSyncBusy || session !== sessionId || !controller || get().phase !== 'connected') return;
    const activeController = controller;
    terminalSyncBusy = true;
    try {
      let positionMillis = fallbackPositionMillis;
      let durationMillis = fallbackDurationMillis;
      try {
        const position = await activeController.getPositionInfo();
        if (session !== sessionId || controller !== activeController) return;
        positionMillis = position.positionMillis || fallbackPositionMillis;
        durationMillis = Math.max(position.trackDurationMillis, fallbackDurationMillis);
      } catch (error) {
        logger.warn('同步远端终止进度失败', error);
      }
      if (session !== sessionId || controller !== activeController) return;

      stopPositionPolling();
      set({ positionMillis, durationMillis });
      if (suppressAutoAdvance) return;

      suppressAutoAdvance = true;
      if (isRemotePositionAtEnd(positionMillis, durationMillis)) {
        Toast.show({ type: 'info', text1: '远端播放已结束', text2: '已同步进度到手机继续播放' });
        await disconnect(true, false, { autoPlay: true });
        return;
      }

      Toast.show({ type: 'info', text1: '远端已关闭', text2: '已退出投屏' });
      await disconnect(true, false, { autoPlay: wasPlaying });
    } finally {
      terminalSyncBusy = false;
    }
  };

  const startEventSubscription = async (device: DLNADevice, session: number) => {
    await stopEventSubscription();
    try {
      const subscription = await subscribeToDlnaEvents(device, (update) => {
        if (session !== sessionId) return;
        if (!controller) return;

        const previous = get();
        const nextTransportState = update.transportState ?? previous.transportState;

        const durationMillis = update.durationMillis !== undefined
          ? resolveRemoteDuration(
              previous.durationMillis,
              update.durationMillis,
              Date.now() - mediaLoadStartedAt,
              expectedRemoteDurationMillis,
            )
          : previous.durationMillis;
        const nextIsPlaying = update.transportState ? nextTransportState === 'PLAYING' : previous.isPlaying;
        // 设备在缓冲阶段也会报 PLAYING，这里不能据此确认已开始播放；
        // playbackConfirmed 只由位置推进确认，避免加载提示被提前关掉或永久卡住。
        const nextPlaybackConfirmed = previous.playbackConfirmed;
        // 位置只由 GetPositionInfo 轮询更新，事件里不携带位置，避免两个来源互相覆盖。
        const nextPosition = previous.isSeeking && durationMillis > 0
          ? previous.seekPosition * durationMillis
          : previous.positionMillis;

        logger.debug(`收到投屏事件: ${update.transportState ?? 'progress'}`);
        set({
          transportState: nextTransportState,
          isPlaying: nextIsPlaying,
          playbackConfirmed: nextPlaybackConfirmed,
          positionMillis: nextPosition,
          durationMillis,
          error: null,
        });
        if (maybeSkipOutro(nextPosition, durationMillis)) return;

        if (nextIsPlaying) {
          startPositionPolling(session);
        } else if (get().playbackConfirmed) {
          // 已确认播放后的暂停才停止轮询；等待开始播放期间保持轮询。
          stopPositionPolling();
        }

        if (
          shouldHandleRemoteTerminalState(
            nextTransportState,
            previous.playbackConfirmed,
            suppressAutoAdvance,
          )
        ) {
          void syncTerminalRemoteState(
            session,
            previous.isPlaying,
            nextPosition,
            durationMillis,
          );
        }
      });
      if (session !== sessionId || !subscription) {
        await subscription?.stop();
        return;
      }
      eventSubscription = subscription;
    } catch (error) {
      logger.warn('订阅电视状态失败', error);
    }
  };

  const waitForRemoteDuration = async (
    activeController: DlnaController,
    targetPositionMillis: number,
    session: number,
  ): Promise<number> => {
    const deadline = Date.now() + REMOTE_DURATION_READY_TIMEOUT_MS;
    let latestDuration = 0;

    while (
      !isRemoteDurationReady(latestDuration, targetPositionMillis) &&
      Date.now() < deadline
    ) {
      if (session !== sessionId) return latestDuration;
      try {
        latestDuration = (await activeController.getPositionInfo()).trackDurationMillis;
      } catch {}
      if (isRemoteDurationReady(latestDuration, targetPositionMillis)) break;
      await delay(REMOTE_DURATION_RETRY_INTERVAL_MS);
    }

    return latestDuration;
  };

  const connectDevice = async (device: DLNADevice, startPosition: number, shouldPlay: boolean) => {
    const current = get();
    const session = sessionId;
    const snapshotDuration = current.localSnapshot?.durationMillis ?? 0;
    // 首次投屏无论手机当前是否暂停都强制播放；已投屏后切换设备才沿用远端状态。
    const remoteShouldPlay = current.currentDevice ? shouldPlay : true;
    let effectivePosition = startPosition;
    let nextController: DlnaController | null = null;
    if (current.connectingDeviceId) return;
    await stopEventSubscription();
    set({
      phase: 'connecting',
      connectingDeviceId: device.id,
      connectingDeviceName: device.friendlyName,
      // 连接进度由投屏状态卡片显示，不弹加载提示层。
      mediaLoading: false,
      playbackConfirmed: false,
      isSeeking: false,
      seekPosition: 0,
      error: null,
    });
    positionProgressAnchorMillis = null;
    const resolvedDevice = await refreshDeviceDescription(device);
    if (session !== sessionId) return;
    try {
      const episode = selectCurrentEpisode(usePlayerStore.getState());
      if (!episode?.url) throw new Error('当前没有可投屏的播放地址');
      const uri = await resolveCastUri(episode.url);
      const metadata = getCastMetadata();
      logger.info(`投屏地址: ${uri}`);
      if (session !== sessionId) return;

      if (controller && current.currentDevice) {
        try {
          await controller.stop();
        } catch {}
      }

      nextController = new DlnaController(resolvedDevice);
      expectedRemoteDurationMillis = snapshotDuration;
      await nextController.setAvTransportUri(uri, metadata.title, 'auto', metadata.coverUrl);
      lastSyncedUri = uri;
      if (session !== sessionId) {
        try { await nextController.stop(); } catch {}
        return;
      }

      mediaLoadStartedAt = Date.now();
      await nextController.play(String(get().playbackRate));

      effectivePosition = resolveIntroPosition(effectivePosition);
      if (effectivePosition > 0) {
        const remoteDuration = await waitForRemoteDuration(nextController, effectivePosition, session);
        if (session !== sessionId) {
          try { await nextController.stop(); } catch {}
          return;
        }
        if (isRemoteDurationReady(remoteDuration, effectivePosition)) {
          logger.info(`电视端时长就绪: ${remoteDuration}ms，恢复点 ${effectivePosition}ms`);
          try {
            await nextController.seekTo(effectivePosition);
          } catch {
            set({ isSeekSupported: false });
          }
        } else {
          logger.warn(`电视端未在 ${REMOTE_DURATION_READY_TIMEOUT_MS}ms 内返回完整时长（当前 ${remoteDuration}ms，目标 ${effectivePosition}ms），取消恢复点 Seek`);
          effectivePosition = 0;
          Toast.show({ type: 'info', text1: '电视端未返回完整时长', text2: '已从视频开头播放' });
        }
      }

      if (remoteShouldPlay) {
        await nextController.play(String(get().playbackRate));
      } else {
        try {
          await nextController.pause();
        } catch {}
      }
      if (session !== sessionId) {
        try { await nextController.stop(); } catch {}
        return;
      }

      controller = nextController;
      const capabilities = await nextController.getCapabilities();
      await rememberDevice(resolvedDevice);
      set({
        enabled: true,
        phase: 'connected',
        currentDevice: resolvedDevice,
        connectingDeviceId: null,
        connectingDeviceName: null,
        mediaLoading: false,
        transportState: remoteShouldPlay ? 'PLAYING' : 'PAUSED_PLAYBACK',
        positionMillis: effectivePosition,
        durationMillis: snapshotDuration,
        isPlaying: remoteShouldPlay,
        isSeekSupported: capabilities.canSeek && get().isSeekSupported,
        capabilities,
        error: null,
      });
      if (remoteShouldPlay) startPositionPolling(session);
      else stopPositionPolling();
      void startEventSubscription(resolvedDevice, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接电视失败';
      if (nextController) {
        try { await nextController.stop(); } catch {}
      }
      if (controller) {
        try { await controller.stop(); } catch {}
      }
      controller = null;
      set({
        phase: 'selecting',
        currentDevice: null,
        connectingDeviceId: null,
        connectingDeviceName: null,
        mediaLoading: false,
        playbackConfirmed: false,
        isPlaying: false,
        error: message,
      });
      Toast.show({ type: 'error', text1: '投屏连接失败', text2: message });
    }
  };

  const startDiscovery = (autoConnectLast: boolean) => {
    stopDiscovery();
    set((state) => ({ phase: state.currentDevice ? state.phase : 'scanning', error: null }));
    const currentDiscovery = startDlnaDiscovery({
      onDevice: (device) => {
        const state = get();
        const exists = state.devices.some((item) => item.id === device.id);
        const devices = exists
          ? state.devices.map((item) => (item.id === device.id ? device : item))
          : [...state.devices, device];
        set({ devices: sortDevices(devices) });
        if (
          state.enabled &&
          autoConnectLast &&
          !autoConnectTriggered &&
          pendingAutoConnectId === device.id &&
          state.phase !== 'connected' &&
          !state.connectingDeviceId
        ) {
          autoConnectTriggered = true;
          const snapshot = state.localSnapshot;
          void connectDevice(device, snapshot?.positionMillis ?? 0, true);
        }
      },
    });
    discovery = currentDiscovery;
    void currentDiscovery.devices.then((devices) => {
      if (discovery !== currentDiscovery) return;
      set((state) => state.enabled ? {
        devices: sortDevices(devices),
        phase: state.phase === 'connected' || state.connectingDeviceId ? state.phase : 'selecting',
      } : {});
    });
  };

  return {
    enabled: false,
    ...initialState(),
    localSnapshot: null,

    enableCast: async () => {
      if (get().enabled) return;
      const session = ++sessionId;
      const player = usePlayerStore.getState();
      const episode = selectCurrentEpisode(player);
      if (!episode?.url) {
        Toast.show({ type: 'error', text1: '当前没有可投屏的视频' });
        return;
      }
      if (isHlsUrl(episode.url)) {
        const origin = await ensureLocalProxy();
        if (session !== sessionId) return;
        if (!origin || !isLanProxyOrigin(origin)) {
          Toast.show({ type: 'error', text1: '无法开启投屏', text2: '请确认手机已连接 Wi-Fi 或以太网' });
          return;
        }
      }

      try {
        if (player.status.isPlaying) await player.videoRef?.current?.pause();
      } catch {}
      if (session !== sessionId) return;
      // 本地 Video 即将卸载，先取消它遗留的回源请求，避免投屏请求和旧预取一起排队。
      cancelProxyDownloads();
      usePlayerStore.setState({ showLockControls: false });
      set({
        enabled: true,
        phase: 'scanning',
        devices: [],
        currentDevice: null,
        connectingDeviceId: null,
        connectingDeviceName: null,
        playbackConfirmed: false,
        playbackEstablished: false,
        error: null,
        localSnapshot: {
          positionMillis: player.status.positionMillis,
          durationMillis: player.status.durationMillis,
          isPlaying: player.status.isPlaying,
        },
      });
      const remembered = await loadRememberedDevice();
      if (session !== sessionId) return;

      pendingAutoConnectId = remembered?.id ?? null;
      autoConnectTriggered = false;
      if (remembered?.device) {
        // 立即给切换设备弹窗一个可用条目；其余设备在后台继续扫描。
        set({ devices: sortDevices([remembered.device]) });
      }

      if (remembered?.device) {
        autoConnectTriggered = true;
        const snapshot = get().localSnapshot;
        await connectDevice(
          remembered.device,
          snapshot?.positionMillis ?? 0,
          true,
        );
        if (session !== sessionId) return;
        if (get().phase === 'connected' && get().currentDevice?.id === remembered.device.id) {
          startDiscovery(false);
          return;
        }
        autoConnectTriggered = false;
      }

      startDiscovery(!!pendingAutoConnectId);
    },

    disableCast: async (options = {}) => {
      const { restoreLocal = true, stopRemote = true } = options;
      await disconnect(restoreLocal, stopRemote);
    },

    refreshDevices: async (options = {}) => {
      const autoConnectLast = options.autoConnectLast ?? !get().currentDevice;
      if (autoConnectLast) {
        pendingAutoConnectId = (await loadRememberedDevice())?.id ?? null;
        autoConnectTriggered = false;
      }
      startDiscovery(autoConnectLast);
    },

    selectDevice: async (device) => {
      const state = get();
      const startPosition = state.currentDevice ? state.positionMillis : state.localSnapshot?.positionMillis ?? 0;
      const shouldPlay = state.currentDevice ? state.isPlaying : true;
      pendingAutoConnectId = device.id;
      autoConnectTriggered = true;
      await connectDevice(device, startPosition, shouldPlay);
    },

    syncCurrentMedia: async (options = {}) => {
      if (!controller || get().phase !== 'connected') return;
      const requestedPositionMillis = options.positionMillis ?? 0;
      const positionMillis = resolveIntroPosition(requestedPositionMillis);
      const shouldPlay = options.play ?? true;
      const episode = selectCurrentEpisode(usePlayerStore.getState());
      if (!episode?.url) return;
      let loadingGeneration: number | null = null;
      let awaitingPlaybackConfirmation = false;
      try {
        set({ isSeeking: false, seekPosition: 0 });
        const uri = await resolveCastUri(episode.url);
        const metadata = getCastMetadata();
        logger.info(`切换投屏地址: ${uri}`);
        if (!options.force && lastSyncedUri === uri && requestedPositionMillis === 0 && shouldPlay) {
          return;
        }
        loadingGeneration = beginMediaLoading();
        set({ playbackConfirmed: false });
        positionProgressAnchorMillis = null;
        lastSyncedUri = uri;
        suppressAutoAdvance = true;
        expectedRemoteDurationMillis = 0;
        mediaLoadStartedAt = Date.now();
        await controller.setAvTransportUri(uri, metadata.title, 'auto', metadata.coverUrl);
        let effectivePosition = positionMillis;
        if (positionMillis > 0) {
          await controller.play(String(get().playbackRate));
          const remoteDuration = await waitForRemoteDuration(controller, positionMillis, sessionId);
          if (isRemoteDurationReady(remoteDuration, positionMillis)) {
            await controller.seekTo(positionMillis);
          } else {
            effectivePosition = 0;
            Toast.show({ type: 'info', text1: '电视端未返回完整时长', text2: '已从视频开头播放' });
          }
        }
        if (shouldPlay) {
          await controller.play(String(get().playbackRate));
          awaitingPlaybackConfirmation = true;
        } else {
          await controller.pause();
        }
        set({
          transportState: shouldPlay ? 'PLAYING' : 'PAUSED_PLAYBACK',
          positionMillis: effectivePosition,
          durationMillis: 0,
          isPlaying: shouldPlay,
          error: null,
        });
        if (shouldPlay) startPositionPolling(sessionId);
        else stopPositionPolling();
      } catch (error) {
        if (loadingGeneration !== null) endMediaLoading(loadingGeneration);
        const message = error instanceof Error ? error.message : '切换投屏视频失败';
        set({ error: message });
        Toast.show({ type: 'error', text1: message });
      } finally {
        if (loadingGeneration !== null && !awaitingPlaybackConfirmation) {
          endMediaLoading(loadingGeneration);
        }
        suppressAutoAdvance = false;
      }
    },

    togglePlayPause: async () => {
      if (!controller || get().phase !== 'connected') return;
      try {
        const wasPlaying = get().isPlaying;
        if (wasPlaying) await controller.pause();
        else await controller.play(String(get().playbackRate));
        set({
          isPlaying: !wasPlaying,
          transportState: wasPlaying ? 'PAUSED_PLAYBACK' : 'PLAYING',
        });
        if (wasPlaying) {
          stopPositionPolling();
        } else {
          startPositionPolling(sessionId);
        }
      } catch (error) {
        Toast.show({ type: 'error', text1: error instanceof Error ? error.message : '操作失败' });
      }
    },

    setPlaybackRate: async (rate) => {
      const activeController = controller;
      if (!activeController || get().phase !== 'connected') return;
      try {
        const wasPlaying = get().isPlaying;
        // 倍速用软件内置速率直接下发，远端不认由远端决定，这里不做能力校验。
        await activeController.play(String(rate));
        if (controller !== activeController) return;
        // Play 会从暂停恢复播放，按原本状态再暂停，保持播放/暂停不变。
        if (!wasPlaying) await activeController.pause();
        if (controller !== activeController) return;
        set({ playbackRate: rate });
      } catch (error) {
        Toast.show({ type: 'error', text1: error instanceof Error ? error.message : '设置倍速失败' });
      }
    },

    getVolume: async () => {
      const activeController = controller;
      const state = get();
      if (!activeController || state.phase !== 'connected') return null;
      try {
        const volume = await activeController.getVolume();
        if (controller !== activeController) return null;
        return volume / 100;
      } catch {
        return null;
      }
    },

    setVolume: async (volume) => {
      const activeController = controller;
      const state = get();
      if (!activeController || state.phase !== 'connected') return;
      try {
        await activeController.setVolume(Math.round(clampUnit(volume) * 100));
      } catch {}
    },

    getBrightness: async () => {
      const activeController = controller;
      const state = get();
      if (!activeController || state.phase !== 'connected') return null;
      try {
        const brightness = await activeController.getBrightness();
        if (controller !== activeController) return null;
        return brightness / 100;
      } catch {
        return null;
      }
    },

    setBrightness: async (brightness) => {
      const activeController = controller;
      const state = get();
      if (!activeController || state.phase !== 'connected') return;
      try {
        await activeController.setBrightness(Math.round(clampUnit(brightness) * 100));
      } catch {}
    },

    seekBy: async (deltaMillis) => {
      const activeController = controller;
      const state = get();
      if (!activeController || state.phase !== 'connected') return;
      if (!state.isSeekSupported || state.capabilities?.canSeek === false) {
        Toast.show({ type: 'info', text1: '当前电视不支持快进快退' });
        return;
      }

      try {
        if (state.durationMillis <= 0) {
          const position = await activeController.getPositionInfo();
          if (controller !== activeController) return;
          const durationMillis = position.trackDurationMillis || state.durationMillis;
          const currentPosition = position.positionMillis || state.positionMillis;
          if (durationMillis <= 0) return;
          set({ durationMillis, positionMillis: currentPosition });
        }
        previewCastSeekBy(deltaMillis);
        await commitCastSeek();
      } catch (error) {
        set({ isSeeking: false, isSeekSupported: false });
        Toast.show({ type: 'error', text1: error instanceof Error ? error.message : '快进快退失败' });
      }
    },

    previewSeekBy: (deltaMillis) => {
      previewCastSeekBy(deltaMillis);
    },

    commitSeek: async () => {
      await commitCastSeek();
    },

    playEpisode: async (index) => {
      const player = usePlayerStore.getState();
      if (index < 0 || index >= player.episodes.length) return;
      await player.playEpisode(index);
      await get().syncCurrentMedia({ positionMillis: 0, play: true });
    },

    clearError: () => set({ error: null }),
  };
});

export default useDlnaStore;
