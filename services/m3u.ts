import Logger from '@/utils/Logger';
import { CatchupConfig } from '@/services/catchup';

const logger = Logger.withTag('M3U');

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
  /** 用于匹配节目单 */
  tvgId: string;
  tvgName: string;
  /** 没有回放参数时为空，表示不支持回看 */
  catchup?: CatchupConfig;
  /** LunaTV 网页版里的频道序号（收藏的 key 用它，与网页版互通）；网页版解析不到这个频道时为空 */
  webIndex?: number;
}

/**
 * 按 LunaTV 网页版（src/lib/live.ts parseM3U）的规则列出它能解析到的频道地址，下标即网页版的频道序号。
 * 与本地解析的差别：地址必须紧跟 #EXTINF 行（中间夹 #EXTVLCOPT 等注释行的频道被跳过），没有名称的频道被跳过。
 */
const webChannelUrls = (lines: string[]): string[] => {
  const ls = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  const urls: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (!line.startsWith('#EXTINF:')) continue;
    if (i + 1 < ls.length && !ls[i + 1].startsWith('#')) {
      const title = line.match(/,([^,]*)$/)?.[1].trim() ?? '';
      const tvgName = line.match(/tvg-name="([^"]*)"/)?.[1] ?? '';
      if (title || tvgName) urls.push(ls[i + 1]);
      i++;
    }
  }
  return urls;
};

const attr = (part: string, name: string): string | undefined => {
  const m = part.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? m[1] : undefined;
};

/** 频道行的回放参数优先，其次是 #EXTM3U 头部；只支持 append / default 两种模式 */
const resolveCatchup = (mode: string | undefined, source: string | undefined, days: string | undefined): CatchupConfig | undefined => {
  if (!source) return undefined;
  const m = mode || (/^https?:\/\//i.test(source) ? 'default' : 'append');
  if (m !== 'append' && m !== 'default') return undefined;
  const cfg: CatchupConfig = { mode: m, source };
  const d = Number(days);
  if (Number.isInteger(d) && d > 0) cfg.days = d;
  return cfg;
};

export const parseM3UPlaylist = (m3uText: string): { channels: Channel[] } => {
  const parsedChannels: Channel[] = [];
  const lines = m3uText.split('\n');
  let currentChannelInfo: Partial<Channel> | null = null;
  let headerMode: string | undefined;
  let headerSource: string | undefined;
  let headerDays: string | undefined;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('#EXTM3U')) {
      headerMode = attr(trimmedLine, 'catchup');
      headerSource = attr(trimmedLine, 'catchup-source');
      headerDays = attr(trimmedLine, 'catchup-days');
    } else if (trimmedLine.startsWith('#EXTINF:')) {
      currentChannelInfo = {}; // Start a new channel
      const commaIndex = trimmedLine.lastIndexOf(',');
      if (commaIndex !== -1) {
        currentChannelInfo.name = trimmedLine.substring(commaIndex + 1).trim();
        const attributesPart = trimmedLine.substring(8, commaIndex);
        const logoMatch = attributesPart.match(/tvg-logo="([^"]*)"/i);
        if (logoMatch && logoMatch[1]) {
          currentChannelInfo.logo = logoMatch[1];
        }
        const groupMatch = attributesPart.match(/group-title="([^"]*)"/i);
        if (groupMatch && groupMatch[1]) {
          currentChannelInfo.group = groupMatch[1];
        }
        currentChannelInfo.tvgId = attr(attributesPart, 'tvg-id');
        currentChannelInfo.tvgName = attr(attributesPart, 'tvg-name');
        // 逐项行内优先、没写的继承文件头；行内 catchup="none" 表示该频道不支持回看（服务端用它关掉文件头的全局回看）
        const chMode = attr(attributesPart, 'catchup');
        const chSource = attr(attributesPart, 'catchup-source');
        currentChannelInfo.catchup = chMode === 'none'
          ? undefined
          : resolveCatchup(chMode ?? headerMode, chSource ?? headerSource, attr(attributesPart, 'catchup-days') ?? headerDays);
      } else {
        currentChannelInfo.name = trimmedLine.substring(8).trim();
        currentChannelInfo.catchup = resolveCatchup(headerMode, headerSource, headerDays);
      }
    } else if (currentChannelInfo && trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('://')) {
      currentChannelInfo.url = trimmedLine;
      currentChannelInfo.id = currentChannelInfo.url; // Use URL as ID

      // Ensure all required fields are present, providing defaults if necessary
      const finalChannel: Channel = {
        id: currentChannelInfo.id,
        url: currentChannelInfo.url,
        name: currentChannelInfo.name || 'Unknown',
        logo: currentChannelInfo.logo || '',
        group: currentChannelInfo.group || 'Default',
        tvgId: currentChannelInfo.tvgId || '',
        tvgName: currentChannelInfo.tvgName || '',
      };
      if (currentChannelInfo.catchup) finalChannel.catchup = currentChannelInfo.catchup;

      parsedChannels.push(finalChannel);
      currentChannelInfo = null; // Reset for the next channel
    }
  }

  // 网页版序号：同一地址可能出现多次，按出现顺序一一对应
  const webIndexes = new Map<string, number[]>();
  webChannelUrls(lines).forEach((url, i) => {
    const list = webIndexes.get(url);
    if (list) list.push(i);
    else webIndexes.set(url, [i]);
  });
  for (const ch of parsedChannels) {
    const idx = webIndexes.get(ch.url)?.shift();
    if (idx !== undefined) ch.webIndex = idx;
  }
  return { channels: parsedChannels };
};

export const parseM3U = (m3uText: string): Channel[] => parseM3UPlaylist(m3uText).channels;

export const fetchAndParseM3u = async (m3uUrl: string): Promise<Channel[]> => {
  try {
    const response = await fetch(m3uUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.statusText}`);
    }
    const m3uText = await response.text();
    return parseM3U(m3uText);
  } catch (error) {
    logger.info("Error fetching or parsing M3U:", error);
    return []; // Return empty array on error
  }
};

export const getPlayableUrl = (originalUrl: string | null): string | null => {
  if (!originalUrl) {
    return null;
  }
  // In React Native, we use the proxy for all http streams to avoid potential issues.
  // if (originalUrl.toLowerCase().startsWith('http://')) {
  //   // Use the baseURL from the existing api instance.
  //   if (!api.baseURL) {
  //       console.warn("API base URL is not set. Cannot create proxy URL.")
  //       return originalUrl; // Fallback to original URL
  //   }
  //   return `${api.baseURL}/proxy?url=${encodeURIComponent(originalUrl)}`;
  // }
  // HTTPS streams can be played directly.
  return originalUrl;
};
