import { XMLParser } from 'fast-xml-parser';
import type { DLNADevice } from './types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
});

export function parseXml(xml: string): Record<string, any> {
  return parser.parse(xml) as Record<string, any>;
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return text((value as Record<string, unknown>)['#text']);
  }
  return '';
}

function resolveUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

export function parseDeviceDescription(xml: string, location: string): DLNADevice | null {
  try {
    const root = parseXml(xml)?.root;
    const device = root?.device;
    if (!device) return null;

    const services = asArray(device.serviceList?.service);
    const avTransport = services.find((service: any) =>
      text(service.serviceType).startsWith('urn:schemas-upnp-org:service:AVTransport:'),
    );
    if (!avTransport) return null;

    const renderingControl = services.find((service: any) =>
      text(service.serviceType).startsWith('urn:schemas-upnp-org:service:RenderingControl:'),
    );
    const controlUrl = text(avTransport.controlURL);
    if (!controlUrl) return null;
    const eventSubUrl = text(avTransport.eventSubURL);
    const renderingControlUrl = text(renderingControl?.controlURL);

    const udn = text(device.UDN) || location;
    let address = '';
    try {
      address = new URL(location).host;
    } catch {
      address = location;
    }

    return {
      id: udn,
      udn,
      friendlyName: text(device.friendlyName) || text(device.modelName) || address,
      manufacturer: text(device.manufacturer) || undefined,
      modelName: text(device.modelName) || undefined,
      location,
      controlUrl: resolveUrl(controlUrl, location),
      eventSubUrl: eventSubUrl ? resolveUrl(eventSubUrl, location) : undefined,
      serviceType: text(avTransport.serviceType),
      address,
      renderingControlUrl: renderingControlUrl ? resolveUrl(renderingControlUrl, location) : undefined,
      renderingControlServiceType: text(renderingControl?.serviceType) || undefined,
      hasRenderingControlService: !!renderingControl,
    };
  } catch {
    return null;
  }
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 规范允许设备用 NOT_IMPLEMENTED 表示不实现该时间字段。 */
export function isDurationImplemented(value: unknown): boolean {
  const raw = text(value);
  if (!raw || raw === 'NOT_IMPLEMENTED') return false;
  return /^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.test(raw);
}

export function parseDurationToMillis(value: unknown): number {
  const raw = text(value);
  if (!raw || raw === 'NOT_IMPLEMENTED') return 0;
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(raw);
  if (!match) return 0;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const fraction = (match[4] ?? '').padEnd(3, '0').slice(0, 3);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number.parseInt(fraction || '0', 10);
}

export function formatMillisAsDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}
