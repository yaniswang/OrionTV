import {
  asArray,
  escapeXml,
  formatMillisAsDuration,
  isDurationImplemented,
  parseDurationToMillis,
  parseXml,
} from './xml';
import type {
  DLNAControlCapabilities,
  DLNADevice,
  DLNAMediaInfo,
  DLNAPositionInfo,
  DLNATransportInfo,
  DLNATransportState,
} from './types';

const REQUEST_TIMEOUT_MS = 5000;

export type DidlMetadataMode = 'auto' | 'video-mp4' | 'none';

function valueOf(record: Record<string, any> | undefined, key: string): unknown {
  return record?.[key];
}

function responseBody(xml: string): Record<string, any> | null {
  try {
    return parseXml(xml)?.Envelope?.Body ?? null;
  } catch {
    return null;
  }
}

function soapFault(xml: string): string | null {
  const body = responseBody(xml);
  const fault = asArray(body?.Fault)[0];
  return fault ? String(fault.faultstring ?? fault.detail?.UPnPError?.errorDescription ?? 'UPnP 请求失败') : null;
}

function guessMimeType(uri: string): string {
  const clean = uri.split('?')[0].toLowerCase();
  if (clean.endsWith('.m3u8')) return 'video/m3u8';
  if (clean.endsWith('.mp4')) return 'video/mp4';
  if (clean.endsWith('.webm')) return 'video/webm';
  return 'video/*';
}

export function buildDidlMetadata(
  uri: string,
  title = 'OrionTV',
  protocolInfo = `http-get:*:${guessMimeType(uri)}:*`,
  coverUrl?: string,
): string {
  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="-1" restricted="1">',
    `<dc:title>${escapeXml(title)}</dc:title>`,
    '<upnp:class>object.item.videoItem</upnp:class>',
    coverUrl ? `<upnp:albumArtURI>${escapeXml(coverUrl)}</upnp:albumArtURI>` : '',
    `<res protocolInfo="${escapeXml(protocolInfo)}">${escapeXml(uri)}</res>`,
    '</item>',
    '</DIDL-Lite>',
  ].join('');
}

export function buildSoapEnvelope(
  serviceType: string,
  action: string,
  args: Record<string, string | number>,
): string {
  const service = serviceType;
  const argsXml = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="${service}">${argsXml}</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

function parseSoapResponse(xml: string, action: string): Record<string, any> {
  const fault = soapFault(xml);
  if (fault) throw new Error(fault);
  return asArray(responseBody(xml)?.[`${action}Response`])[0] ?? {};
}

function parsePercent(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`电视返回了无效的${label}`);
  return Math.max(0, Math.min(100, Math.round(number)));
}

export class DlnaController {
  constructor(readonly device: DLNADevice) {}

  private async request(
    action: string,
    args: Record<string, string | number> = {},
    serviceType = this.device.serviceType,
    controlUrl = this.device.controlUrl,
  ): Promise<Record<string, any>> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    try {
      const request = fetch(controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${serviceType}#${action}"`,
        },
        body: buildSoapEnvelope(serviceType, action, args),
        signal: controller.signal,
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('电视请求超时'));
        }, REQUEST_TIMEOUT_MS);
      });
      const response = await Promise.race([request, timeout]);
      const xml = await response.text();
      if (!response.ok) throw new Error(soapFault(xml) ?? `电视返回 HTTP ${response.status}`);
      return parseSoapResponse(xml, action);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async setAvTransportUri(
    uri: string,
    title = 'OrionTV',
    metadataMode: DidlMetadataMode = 'auto',
    coverUrl?: string,
  ): Promise<void> {
    const protocolInfo =
      metadataMode === 'video-mp4' ? 'http-get:*:video/mp4:*' : `http-get:*:${guessMimeType(uri)}:*`;
    await this.request('SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: uri,
      CurrentURIMetaData: metadataMode === 'none' ? '' : buildDidlMetadata(uri, title, protocolInfo, coverUrl),
    });
  }

  async play(speed = '1'): Promise<void> {
    await this.request('Play', { InstanceID: 0, Speed: speed });
  }

  async pause(): Promise<void> {
    await this.request('Pause', { InstanceID: 0 });
  }

  async stop(): Promise<void> {
    await this.request('Stop', { InstanceID: 0 });
  }

  async seekTo(positionMillis: number): Promise<void> {
    await this.request('Seek', {
      InstanceID: 0,
      Unit: 'REL_TIME',
      Target: formatMillisAsDuration(positionMillis),
    });
  }

  async getTransportInfo(): Promise<DLNATransportInfo> {
    const response = await this.request('GetTransportInfo', { InstanceID: 0 });
    const raw = String(valueOf(response, 'CurrentTransportState') ?? 'UNKNOWN').toUpperCase();
    const allowed: DLNATransportState[] = [
      'PLAYING',
      'PAUSED_PLAYBACK',
      'STOPPED',
      'TRANSITIONING',
      'NO_MEDIA_PRESENT',
      'UNKNOWN',
    ];
    return {
      state: (allowed.includes(raw as DLNATransportState) ? raw : 'UNKNOWN') as DLNATransportState,
      status: String(valueOf(response, 'CurrentTransportStatus') ?? ''),
    };
  }

  async getPositionInfo(): Promise<DLNAPositionInfo> {
    const response = await this.request('GetPositionInfo', { InstanceID: 0 });
    const rawRelTime = valueOf(response, 'RelTime');
    return {
      trackDurationMillis: parseDurationToMillis(valueOf(response, 'TrackDuration')),
      positionMillis: parseDurationToMillis(rawRelTime),
      positionSupported: isDurationImplemented(rawRelTime),
      trackUri: String(valueOf(response, 'TrackURI') ?? ''),
    };
  }

  async getMediaInfo(): Promise<DLNAMediaInfo> {
    const response = await this.request('GetMediaInfo', { InstanceID: 0 });
    const tracks = Number.parseInt(String(valueOf(response, 'NrTracks') ?? ''), 10);
    return {
      currentUri: String(valueOf(response, 'CurrentURI') ?? ''),
      numberOfTracks: Number.isFinite(tracks) ? tracks : null,
    };
  }

  private async requestRendering(
    action: string,
    args: Record<string, string | number>,
  ): Promise<Record<string, any>> {
    const serviceType = this.device.renderingControlServiceType;
    const controlUrl = this.device.renderingControlUrl;
    if (!serviceType || !controlUrl) throw new Error('电视不支持该控制');
    return this.request(action, args, serviceType, controlUrl);
  }

  async getVolume(): Promise<number> {
    const response = await this.requestRendering('GetVolume', {
      InstanceID: 0,
      Channel: 'Master',
    });
    return parsePercent(valueOf(response, 'CurrentVolume'), '音量');
  }

  async setVolume(volume: number): Promise<void> {
    await this.requestRendering('SetVolume', {
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: parsePercent(volume, '音量'),
    });
  }

  async getBrightness(): Promise<number> {
    const response = await this.requestRendering('GetBrightness', {
      InstanceID: 0,
      Channel: 'Master',
    });
    return parsePercent(valueOf(response, 'CurrentBrightness'), '亮度');
  }

  async setBrightness(brightness: number): Promise<void> {
    await this.requestRendering('SetBrightness', {
      InstanceID: 0,
      Channel: 'Master',
      DesiredBrightness: parsePercent(brightness, '亮度'),
    });
  }

  async getCapabilities(): Promise<DLNAControlCapabilities> {
    const actions = await this.getCurrentActions();
    const nonEmpty = actions.length > 0;
    return {
      actions,
      canPlay: !nonEmpty || actions.includes('Play'),
      canPause: !nonEmpty || actions.includes('Pause'),
      canStop: !nonEmpty || actions.includes('Stop'),
      canSeek: !nonEmpty || actions.includes('Seek'),
    };
  }

  private async getCurrentActions(): Promise<string[]> {
    try {
      const response = await this.request('GetCurrentTransportActions', { InstanceID: 0 });
      return String(valueOf(response, 'CurrentTransportActions') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
