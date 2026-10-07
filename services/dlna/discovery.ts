import dgram from 'react-native-udp';
import { Buffer } from 'buffer';
import { parseDeviceDescription } from './xml';
import type { DLNADevice } from './types';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const DEFAULT_TIMEOUT_MS = 6000;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
];

export interface DLNADiscoveryOptions {
  timeoutMs?: number;
  onDevice?: (device: DLNADevice) => void;
}

export interface DLNADiscoveryHandle {
  devices: Promise<DLNADevice[]>;
  stop: () => void;
}

export interface SsdpResponse {
  statusCode: number;
  headers: Record<string, string>;
}

export function createSsdpSearchMessage(serviceType: string, mx = 2): string {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${serviceType}`,
    '',
    '',
  ].join('\r\n');
}

export function parseSsdpResponse(message: string): SsdpResponse | null {
  const lines = message.trim().split(/\r?\n/);
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines.shift()?.trim() ?? '');
  if (!statusMatch) return null;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { statusCode: Number.parseInt(statusMatch[1], 10), headers };
}

async function fetchDescription(location: string, signal: AbortSignal): Promise<DLNADevice | null> {
  try {
    const response = await fetch(location, { signal });
    if (!response.ok) return null;
    return parseDeviceDescription(await response.text(), location);
  } catch {
    return null;
  }
}

export function startDlnaDiscovery(options: DLNADiscoveryOptions = {}): DLNADiscoveryHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = dgram.createSocket({ type: 'udp4' });
  const devices = new Map<string, DLNADevice>();
  const locations = new Set<string>();
  const pending = new Set<Promise<void>>();
  const abortController = new AbortController();
  let stopped = false;
  let resolveDevices: (value: DLNADevice[]) => void = () => undefined;

  const devicesPromise = new Promise<DLNADevice[]>((resolve) => {
    resolveDevices = resolve;
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    abortController.abort();
    clearTimeout(timeoutTimer);
    clearTimeout(fallbackTimer);
    try {
      socket.close();
    } catch {}
    resolveDevices([...devices.values()].sort((a, b) => a.friendlyName.localeCompare(b.friendlyName)));
  };

  const handleResponse = (message: string) => {
    if (stopped) return;
    const parsed = parseSsdpResponse(message);
    const location = parsed?.headers.location;
    if (!location || locations.has(location)) return;
    locations.add(location);

    const task = fetchDescription(location, abortController.signal).then((device) => {
      if (!device || stopped) return;
      devices.set(device.id, device);
      options.onDevice?.(device);
    });
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => undefined);
  };

  socket.on('message', (message: Buffer | string) => {
    handleResponse(Buffer.isBuffer(message) ? message.toString('utf8') : String(message));
  });
  socket.on('error', () => stop());
  socket.on('listening', () => {
    for (const target of SEARCH_TARGETS) {
      socket.send(createSsdpSearchMessage(target), undefined, undefined, SSDP_PORT, SSDP_ADDRESS);
    }
  });

  const fallbackTimer = setTimeout(() => {
    if (!stopped) socket.send(createSsdpSearchMessage('ssdp:all', 3), undefined, undefined, SSDP_PORT, SSDP_ADDRESS);
  }, 1800);

  const timeoutTimer = setTimeout(() => {
    Promise.allSettled([...pending]).finally(stop);
  }, timeoutMs);

  try {
    socket.bind(0);
  } catch {
    stop();
  }

  return { devices: devicesPromise, stop };
}
