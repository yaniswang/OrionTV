/**
 * 本地预缓存代理 —— HTTP 协议处理（纯逻辑，无 I/O，方便单测）
 */

import { Buffer } from 'buffer';

export interface ParsedRequest {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  /**
   * 响应体（base64，不含 data URL 前缀）。
   * 全程以 base64 传递，避免在 JS 线程里把每个分片逐个字节地
   * 解码（下载）再编码（下发）——那是界面卡顿的根源。
   */
  base64: string;
  /** base64 解码后的字节数 */
  byteLength: number;
}

export interface ProxyResult {
  status: number;
  statusText: string;
  contentType: string;
  /** 响应体（base64）：交给原生 socket 直接发送，不经过 JS 的逐字节处理 */
  bodyBase64: string;
  /** 解码后的字节数，即 Content-Length */
  bodyLength: number;
  extraHeaders?: Record<string, string>;
  cacheControl?: string;
}

/** 逐跳头，不转发给源站 */
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'range', // Range 在本地切片，不透传
]);

/** 解析请求头文本（不含结尾空行） */
export function parseHead(head: string): ParsedRequest | null {
  const lines = head.split('\r\n');
  if (lines.length === 0) return null;

  const parts = lines[0].split(' ');
  const method = parts[0];
  const target = parts[1];
  if (!method || !target) return null;

  const qIndex = target.indexOf('?');
  const pathname = qIndex === -1 ? target : target.slice(0, qIndex);
  const search = qIndex === -1 ? '' : target.slice(qIndex + 1);

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx <= 0) continue;
    headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }

  return { method, pathname, search, headers };
}

/** 从 query 串里读一个参数（不依赖 URLSearchParams） */
export function readQuery(search: string, key: string): string | null {
  if (!search) return null;
  for (const part of search.split('&')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx) !== key) continue;
    const value = part.slice(idx + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** 过滤出要转发给源站的请求头 */
export function buildForwardHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key in headers) {
    if (SKIP_REQUEST_HEADERS.has(key)) continue;
    out[key] = headers[key];
  }
  return out;
}

/**
 * 处理 Range 请求：在本地对已拿到的完整响应切片。
 * 支持 `bytes=a-b` / `bytes=a-` / `bytes=-n`。
 */
export function applyRange(result: ProxyResult, rangeHeader?: string): ProxyResult {
  if (!rangeHeader || result.status !== 200) return result;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return result;

  const total = result.bodyLength;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return result;

  let start: number;
  let end: number;
  if (hasStart) {
    start = Number.parseInt(match[1], 10);
    end = hasEnd ? Number.parseInt(match[2], 10) : total - 1;
  } else {
    const suffixLength = Number.parseInt(match[2], 10);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  }

  end = Math.min(end, total - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return result;
  if (start > end || start >= total) return result;

  // 整段请求（bytes=0-）：不需要切片，避免为了返回全文而解码一遍
  const whole = start === 0 && end === total - 1;

  return {
    ...result,
    status: 206,
    statusText: 'Partial Content',
    bodyBase64: whole ? result.bodyBase64 : sliceBase64(result.bodyBase64, start, end),
    bodyLength: end - start + 1,
    extraHeaders: { 'Content-Range': `bytes ${start}-${end}/${total}` },
  };
}

/** base64 字符串解码后的字节数（不真正解码） */
export function base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.charCodeAt(len - 1) === 61) padding++;
  if (len > 1 && base64.charCodeAt(len - 2) === 61) padding++;
  return (len / 4) * 3 - padding;
}

/**
 * 取出 base64 里 [start, end] 字节区间的 base64。
 * 只解码/编码这一段，不会为了一次 Range 请求把整个分片过一遍 JS。
 */
export function sliceBase64(base64: string, start: number, end: number): string {
  const groupStart = Math.floor(start / 3);
  const groupEnd = Math.floor(end / 3) + 1;
  const headSkip = start - groupStart * 3;
  const chunk = base64.slice(groupStart * 4, groupEnd * 4);
  const bytes = Buffer.from(chunk, 'base64');
  const sliced = bytes.subarray(headSkip, headSkip + (end - start + 1));
  return Buffer.from(sliced).toString('base64');
}

export function statusText(status: number): string {
  switch (status) {
    case 200:
      return 'OK';
    case 206:
      return 'Partial Content';
    case 301:
      return 'Moved Permanently';
    case 302:
      return 'Found';
    case 304:
      return 'Not Modified';
    case 400:
      return 'Bad Request';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    default:
      return 'OK';
  }
}

/** 按后缀猜分片类型（源站没给 Content-Type 时兜底） */
export function guessSegmentType(url: string): string {
  if (/\.ts(\?|$)/i.test(url)) return 'video/mp2t';
  if (/\.m4s(\?|$)/i.test(url)) return 'video/iso.segment';
  if (/\.mp4(\?|$)/i.test(url)) return 'video/mp4';
  return 'application/octet-stream';
}

export function bytesResult(
  status: number,
  bodyBase64: string,
  contentType: string,
  cacheControl?: string,
): ProxyResult {
  return {
    status,
    statusText: statusText(status),
    bodyBase64,
    bodyLength: base64ByteLength(bodyBase64),
    contentType,
    cacheControl,
  };
}

export function textResult(
  status: number,
  text: string,
  contentType = 'text/plain',
  cacheControl?: string,
): ProxyResult {
  return bytesResult(status, Buffer.from(text, 'utf8').toString('base64'), contentType, cacheControl);
}
