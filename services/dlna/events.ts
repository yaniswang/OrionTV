import TCPHttpServer from '@/services/tcpHttpServer';
import type { DLNADevice, DLNATransportState } from './types';
import { asArray, parseDurationToMillis, parseXml } from './xml';

const SUBSCRIBE_TIMEOUT_SECONDS = 1800;
const MIN_RENEW_SECONDS = 30;

export interface DLNAEventUpdate {
  transportState?: DLNATransportState;
  durationMillis?: number;
}

export interface DLNAEventSubscription {
  stop: () => Promise<void>;
}

interface SubscribeResult {
  sid: string | null;
  timeoutSeconds: number;
}

function attr(record: Record<string, any> | undefined, key: string): unknown {
  const value = record?.[key];
  if (value && typeof value === 'object' && '@_val' in value) {
    return (value as Record<string, unknown>)['@_val'];
  }
  return value;
}

function normalizeTransportState(value: unknown): DLNATransportState | undefined {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'PAUSED') return 'PAUSED_PLAYBACK';
  if (
    raw === 'PLAYING' ||
    raw === 'PAUSED_PLAYBACK' ||
    raw === 'STOPPED' ||
    raw === 'TRANSITIONING' ||
    raw === 'NO_MEDIA_PRESENT' ||
    raw === 'UNKNOWN'
  ) {
    return raw as DLNATransportState;
  }
  return undefined;
}

/** 兼容旧版已保存设备：没有 eventSubURL 时按常见 action/event 同级路径推导。 */
export function resolveEventSubUrl(device: DLNADevice): string | null {
  if (device.eventSubUrl) return device.eventSubUrl;
  try {
    const url = new URL(device.controlUrl);
    const parts = url.pathname.split('/');
    if (parts.length === 0) return null;
    parts[parts.length - 1] = 'event';
    url.pathname = parts.join('/');
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

export function parseLastChange(body: string): DLNAEventUpdate | null {
  const propertySet = parseXml(body)?.propertyset;
  const properties = asArray(propertySet?.property);
  const lastChange = properties
    .map((property: any) => property?.LastChange)
    .find((value: unknown) => typeof value === 'string' && value.trim());
  if (!lastChange) return null;

  const event = parseXml(lastChange);
  const instance = asArray(event?.Event?.InstanceID)[0];
  if (!instance) return null;

  const update: DLNAEventUpdate = {};
  const transportState = normalizeTransportState(attr(instance, 'TransportState'));
  if (transportState) update.transportState = transportState;

  // RelativeTimePosition 按规范不通过 LastChange 事件传递，位置只以 GetPositionInfo 轮询为准，
  // 避免事件与轮询两个来源交替覆盖导致时间来回跳。
  if (instance.CurrentTrackDuration !== undefined) {
    const durationMillis = parseDurationToMillis(attr(instance, 'CurrentTrackDuration'));
    if (durationMillis > 0) update.durationMillis = durationMillis;
  }
  return update;
}

function parseTimeoutSeconds(header: string | null): number {
  const match = /Second-(\d+)/i.exec(header ?? '');
  const value = match ? Number.parseInt(match[1], 10) : SUBSCRIBE_TIMEOUT_SECONDS;
  return Number.isFinite(value) && value > 0 ? value : SUBSCRIBE_TIMEOUT_SECONDS;
}

async function sendSubscribe(
  eventSubUrl: string,
  callbackUrl: string,
  sid?: string,
): Promise<SubscribeResult> {
  const headers: Record<string, string> = sid
    ? { SID: sid, TIMEOUT: `Second-${SUBSCRIBE_TIMEOUT_SECONDS}` }
    : {
        CALLBACK: `<${callbackUrl}>`,
        NT: 'upnp:event',
        TIMEOUT: `Second-${SUBSCRIBE_TIMEOUT_SECONDS}`,
      };
  const response = await fetch(eventSubUrl, { method: 'SUBSCRIBE', headers });
  if (!response.ok) throw new Error(`订阅电视状态失败: HTTP ${response.status}`);
  return {
    sid: response.headers.get('sid') ?? sid ?? null,
    timeoutSeconds: parseTimeoutSeconds(response.headers.get('timeout')),
  };
}

/**
 * 标准 UPnP/GENA AVTransport 事件订阅。
 * 电视会把 LastChange 主动 NOTIFY 到 callback URL，播放/暂停可即时同步。
 */
export async function subscribeToDlnaEvents(
  device: DLNADevice,
  onUpdate: (update: DLNAEventUpdate) => void,
): Promise<DLNAEventSubscription | null> {
  const eventSubUrl = resolveEventSubUrl(device);
  if (!eventSubUrl) return null;

  const server = new TCPHttpServer();
  server.setRequestHandler((request) => {
    if (request.method === 'NOTIFY') {
      try {
        const update = parseLastChange(request.body);
        if (update) onUpdate(update);
      } catch {
        // 单条事件解析失败不能影响后续 NOTIFY。
      }
    }
    return { statusCode: 200, headers: {}, body: '' };
  });

  let sid: string | null = null;
  let renewTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
    if (sid) {
      try {
        await fetch(eventSubUrl, { method: 'UNSUBSCRIBE', headers: { SID: sid } });
      } catch {}
    }
    server.stop();
  };

  try {
    const baseUrl = await server.start();
    const callbackUrl = `${baseUrl}/dlna/event`;
    const scheduleRenew = (seconds: number) => {
      if (stopped) return;
      const delaySeconds = Math.max(MIN_RENEW_SECONDS, Math.floor(seconds * 0.8));
      renewTimer = setTimeout(() => {
        void (async () => {
          try {
            const renewed = await sendSubscribe(eventSubUrl, callbackUrl, sid ?? undefined);
            sid = renewed.sid;
            scheduleRenew(renewed.timeoutSeconds);
          } catch {
            await stop();
          }
        })();
      }, delaySeconds * 1000);
    };

    const subscribed = await sendSubscribe(eventSubUrl, callbackUrl);
    sid = subscribed.sid;
    scheduleRenew(subscribed.timeoutSeconds);
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
