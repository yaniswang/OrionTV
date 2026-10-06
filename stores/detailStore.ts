import { create } from "zustand";
import { SearchResult, api } from "@/services/api";
import { getCachedSpeedTest, measureM3U8Speed, pingM3U8, resolveM3U8Segments, urlTag, M3U8ProbeInfo, M3U8Segment } from "@/services/m3u8";
import { FavoriteManager } from "@/services/storage";
import Logger from "@/utils/Logger";

const logger = Logger.withTag('DetailStore');

/**
 * "优秀"阈值：分片时长 / 加载耗时。
 * 实测（3 部片 41 个源，并发下前 2 片，缓存关闭）：
 * p25 = 1.73，中位数 2.29，p75 = 3.85；倍率 < 1 的源连实时都跟不上。
 * 取 2.5 ≈ 上四分位：2 倍以上余量才算"优秀"，同时保留区分度。
 */
export const EXCELLENT_SEGMENT_RATIO = 2.5;

/**
 * 代理回退阈值：配了 m3u8Proxy 时，代理测速低于这个值（或返回非 200）就连直连一起测，谁快用谁。
 * 比"优秀"阈值低——代理只要"够用"就保留，只有明显跟不上才多花一次分片下载去回退直连。
 */
const PROXY_FALLBACK_SEGMENT_RATIO = 1.5;

export type SearchResultWithResolution = SearchResult & {
  resolution?: string | null,
  pingTime: number,
  segmentLoadMs?: number | null,
  segmentDurationMs?: number | null,
  /** 分片时长 / 加载耗时，> 1 表示下载比播放快、可流畅播放 */
  segmentRatio?: number,
  /** 这个源最终走了 m3u8Proxy（代理不达标时会自动改走直连） */
  useProxy?: boolean,
};

interface DetailState {
  q: string | null;
  title: string | null;
  searchResults: SearchResultWithResolution[];
  sources: { source: string; source_name: string; resolution: string | null | undefined }[];
  detail: SearchResultWithResolution | null;
  loading: boolean;
  error: string | null;
  allSourcesLoaded: boolean;
  controller: AbortController | null;
  isFavorited: boolean;
  failedSources: Set<string>; // 记录失败的source列表
  /** 正在完整测速的源（同一时间只有一个，用于列表显示测速中动画） */
  testingSource: string | null;

  init: (q: string | undefined, title: string, year: string, stype: string, preferredSource: string | undefined, id: string | undefined, m3u8Proxy: string) => Promise<void>;
  setDetail: (detail: SearchResultWithResolution) => Promise<void>;
  abort: () => void;
  toggleFavorite: () => Promise<void>;
  markSourceAsFailed: (source: string, reason: string) => void;
  getNextAvailableSource: (currentSource: string, episodeIndex: number) => SearchResultWithResolution | null;
}

const useDetailStore = create<DetailState>((set, get) => ({
  q: null,
  title: null,
  searchResults: [],
  sources: [],
  detail: null,
  loading: true,
  error: null,
  allSourcesLoaded: false,
  controller: null,
  isFavorited: false,
  failedSources: new Set(),
  testingSource: null,

  init: async (q, title, year, stype, preferredSource, id, m3u8Proxy) => {
    const perfStart = performance.now();
    logger.info(`[PERF] DetailStore.init START - q: ${q}, title: ${title}, year: ${year}, stype: ${stype}, preferredSource: ${preferredSource}, id: ${id}`);
    
    const { controller: oldController } = get();
    if (oldController) {
      oldController.abort();
    }
    const newController = new AbortController();
    const signal = newController.signal;

    title = title.replace(' ', '');

    set({
      q,
      title,
      loading: true,
      searchResults: [],
      detail: null,
      error: null,
      allSourcesLoaded: false,
      controller: newController,
    });

    const proxyPrefix = m3u8Proxy && /^https?:\/\//.test(m3u8Proxy) ? m3u8Proxy : '';

    type PingedSource = SearchResult & {
      /** ping 结果：完整测速后会被替换成带倍率的结果 */
      probe: M3U8ProbeInfo;
      /** ping 时解析出来的前 2 个分片；跳过 PING 或测完就置 null（测速时自己拉清单） */
      segments: M3U8Segment[] | null;
      /** 原始 m3u8 地址（未拼代理前缀），测速缓存 key 和路由判定都用它 */
      m3u8Url: string;
      /** 播放地址是否走 m3u8Proxy */
      useProxy: boolean;
      /**
       * 在列表里的位置序号 = 插入列表的先后：不 PING 的源是一到就插，PING 的源是 ping 完就插。
       * 列表和测速队列都按它排，测速才会顺着列表往下走、不在列表里跳来跳去。
       * insertAndEnqueue 赋真实值，pingSource 里只是占位。
       */
      insertSeq: number;
    };

    /** 本次搜索所有源的 ping/测速结果，key 是 source */
    const pinged = new Map<string, PingedSource>();

    /** 入表计数器：谁先插进列表谁在前面 */
    let insertSeq = 0;

    /** 待测队列（FIFO）：队首就是下一个要测的源，用来把"测速中"图标交接过去 */
    const testQueue: PingedSource[] = [];
    /** 当前正在测速的源；为 null 表示这一时刻没有源在测，图标该落到刚插进来的源上 */
    let measuringSource: string | null = null;

    /**
     * PING 一个源：只拉清单 + HEAD 首个分片，不下载分片内容。
     * 返回 null 表示这个源拿不到可用清单，直接丢弃。
     */
    const pingSource = async (searchResult: SearchResult): Promise<PingedSource | null> => {
      const m3u8Url = searchResult.episodes?.[0];
      if (!m3u8Url) return null;

      const pingStart = performance.now();
      let probe: M3U8ProbeInfo | null = null;
      let segments: M3U8Segment[] | null = null;
      let useProxy = false;

      try {
        if (proxyPrefix) {
          // 用户配了代理：先 ping 代理路由，源站没返回 200 就没得商量，直接走直连
          const proxied = await pingM3U8(proxyPrefix + m3u8Url, signal, proxyPrefix);
          if (proxied && !proxied.info.blocked) {
            probe = proxied.info;
            segments = proxied.segments;
            useProxy = true;
          } else {
            const direct = await pingM3U8(m3u8Url, signal);
            probe = direct?.info ?? null;
            segments = direct?.segments ?? null;
          }
        } else {
          const direct = await pingM3U8(m3u8Url, signal);
          probe = direct?.info ?? null;
          segments = direct?.segments ?? null;
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          logger.error(`M3U8 ping 失败 ${searchResult.source_name}`, e);
        }
      }

      if (!probe) return null;

      logger.info(
        `[PERF] M3U8 ping ${searchResult.source_name} [${urlTag(m3u8Url)}|${useProxy ? '代理' : '直连'}]: ` +
          `${(performance.now() - pingStart).toFixed(2)}ms (${JSON.stringify(probe)})`,
      );
      // insertSeq 先占位，真正插表时（mergePinged）才赋真实值
      return { ...searchResult, probe, segments, m3u8Url, useProxy, insertSeq: -1 };
    };

    /**
     * 展示顺序：
     * 1. 插表的先后就是列表顺序：有推荐源时不 PING，源一到就插表（推荐源最前）；
     *    没推荐源时 PING 完一个插一个。插表的同一条源也同时进测速队列，
     *    所以测速始终顺着列表往下走，不会在列表里跳。
     * 2. 每测完一个源，只在"已测源"内部按倍率重排（倍率高的靠前），
     *    未测源保持插表顺序原地不动，而且始终排在已测源后面。
     */
    const compareForDisplay = (a: PingedSource, b: PingedSource) => {
      const aMeasured = a.probe.segmentLoadMs != null;
      const bMeasured = b.probe.segmentLoadMs != null;
      if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;
      if (aMeasured) return (b.probe.segmentRatio ?? 0) - (a.probe.segmentRatio ?? 0);
      return a.insertSeq - b.insertSeq;
    };

    /**
     * 把 pinged 写进 store（排序规则见 compareForDisplay）。
     * extra 用来把"测速中图标交接"和这次列表更新并成同一次 set，避免中间闪出没有图标的帧。
     */
    const publishResults = (extra?: { testingSource?: string | null }): SearchResultWithResolution[] => {
      const items = [...pinged.values()].sort(compareForDisplay);
      const results: SearchResultWithResolution[] = items.map((item) => ({
        ...item,
        ...item.probe,
        episodes:
          item.useProxy && proxyPrefix ? item.episodes.map((url) => proxyPrefix + url) : item.episodes,
        useProxy: item.useProxy,
      }));
      set((state) => ({
        searchResults: results,
        sources: results.map((r) => ({ source: r.source, source_name: r.source_name })),
        // 只在还没选中源时自动选第一个：
        // 没有推荐源 -> 第一个 ping 返回就自动选中并开始播放；
        // 有推荐源 -> 它已经选中并在播了，后面其它源的 ping 不会改当前选择
        detail: state.detail ?? results[0] ?? null,
        ...(extra ?? {}),
      }));
      return results;
    };

    /**
     * 把源插进列表（insertSeq 决定它在列表里的位置），插完立刻放开播放。
     * extra 用来和"测速中图标"这类状态并成同一次 set，避免多闪一帧。
     */
    const mergePinged = (list: (PingedSource | null)[], extra?: { testingSource?: string | null }) => {
      let added = false;
      for (const item of list) {
        if (!item || pinged.has(item.source)) continue;
        // 注意必须存同一个对象：测速完成时是直接改 item.probe，换新对象的话改动传不回列表
        // 插表的先后就是列表顺序，也就是测速顺序
        item.insertSeq = insertSeq++;
        pinged.set(item.source, item);
        added = true;
      }
      if (added) {
        publishResults(extra);
        set({ loading: false }); // ping 结束就可以开始播放
      }
    };

    /** 完整测速计数与耗时，仅用于日志 */
    let testedCount = 0;
    const speedTestStart = performance.now();
    /** 测速链：保证"源与源之间严格顺序"，同时不阻塞 WS 搜索 */
    let testChain: Promise<void> = Promise.resolve();

    /**
     * 写结果时"测速中"图标该落在哪个源上：队列里还有就交给队首，
     * 没有就置空（这批测完了）。和倍率写进同一次 set，
     * 分开写会出现"刚测完的源还挂着图标"或者"一个图标都没有"的中间帧。
     */
    const nextTestingSource = () => (testQueue.length > 0 ? testQueue[0].source : null);

    /**
     * 查完整测速缓存：先查这条源当前要走的路由，再查另一条。
     * 上次测出结果的路由和这次的入口路由可能不是同一条（代理清单 403 那种会回退直连），
     * 只查一条就会白白重测一遍；命中哪条路由，播放路由也切成那条，倍率才对得上实际播放。
     */
    const findCachedSpeed = (item: PingedSource): { info: M3U8ProbeInfo; useProxy: boolean } | null => {
      const primary = getCachedSpeedTest(item.m3u8Url, item.useProxy ? proxyPrefix : undefined);
      if (primary) return { info: primary, useProxy: item.useProxy };
      if (!proxyPrefix) return null;
      const otherProxy = !item.useProxy;
      const other = getCachedSpeedTest(item.m3u8Url, otherProxy ? proxyPrefix : undefined);
      return other ? { info: other, useProxy: otherProxy } : null;
    };

    /** 完整测速一个源：测完立刻按倍率重排 */
    const measureOneInner = async (item: PingedSource) => {
      if (signal.aborted) return;

      // 完整测速缓存（按域名，独立于 ping）：命中就不用再下分片
      const cached = findCachedSpeed(item);
      if (cached) {
        item.useProxy = cached.useProxy;
        item.probe = { ...item.probe, ...cached.info };
        logger.info(
          `[PERF] 完整测速 ${item.source_name}: 命中缓存（${cached.useProxy ? '代理' : '直连'}），倍数 ${cached.info.segmentRatio}`,
        );
        publishResults({ testingSource: nextTestingSource() });
        return;
      }

      /**
       * 取某个路由（代理 / 直连）下要下载的分片。
       * ping 过的源直接复用 ping 时解析出来的分片；跳过 PING 的源（有推荐源时）现拉清单。
       * 换路由时也必须重新拉清单——代理清单解析出来的分片地址是代理地址，拿去当直连测就测错了。
       */
      const segmentsForRoute = async (useProxy: boolean): Promise<M3U8Segment[]> => {
        if (item.segments && useProxy === item.useProxy) return item.segments;
        const targetUrl = useProxy && proxyPrefix ? proxyPrefix + item.m3u8Url : item.m3u8Url;
        const resolved = await resolveM3U8Segments(targetUrl, signal);
        return resolved ?? [];
      };

      /** 测一个路由：连清单都拉不到分片（403/404 等）就返回 null，表示这条路不可用 */
      const measureRoute = async (useProxy: boolean): Promise<M3U8ProbeInfo | null> => {
        const segments = await segmentsForRoute(useProxy);
        if (signal.aborted) return null;
        if (segments.length === 0) {
          logger.info(`[PERF] ${item.source_name} ${useProxy ? '代理' : '直连'}拿不到分片清单，判定该路由不可用`);
          return null;
        }
        return await measureM3U8Speed(
          item.m3u8Url,
          segments,
          signal,
          item.probe,
          useProxy ? proxyPrefix : undefined,
        );
      };

      let info = await measureRoute(item.useProxy);
      if (signal.aborted) return;

      if (item.useProxy && (!info || info.blocked || info.segmentRatio < PROXY_FALLBACK_SEGMENT_RATIO)) {
        // 代理不可用（非 200）或太差：再测直连，谁好用谁
        const direct = await measureRoute(false);
        if (signal.aborted) return;
        if (direct && !direct.blocked && direct.segmentRatio > (info?.segmentRatio ?? 0)) {
          logger.info(`[PERF] ${item.source_name} 代理不达标，改用直连`);
          info = direct;
          item.useProxy = false;
        }
      }

      if (!info) {
        logger.info(`[PERF] 完整测速 ${item.source_name}: 代理和直连都不可用，跳过`);
        return;
      }

      item.probe = info;
      item.segments = null;
      testedCount++;
      logger.info(
        `[PERF] 完整测速 ${item.source_name} [${urlTag(item.m3u8Url)}|${item.useProxy ? '代理' : '直连'}]: 倍数 ${info.segmentRatio}` +
          `（${info.segmentLoadMs}ms 加载 ${info.segmentDurationMs}ms 时长）`,
      );
      publishResults({ testingSource: nextTestingSource() });
    };

    /**
     * 测速队列：源一插进列表就进队（有推荐源时是 WS 一到，没推荐源时是 PING 完），
     * 队列里一个测完再测下一个。
     * 用 promise 串起来，源与源之间严格顺序，又不会挡住后面的搜索。
     * 跳过 PING 的源 segments 是 null，测速时会自己拉清单，所以这里不能把它挡掉。
     */
    const enqueueForTest = (item: PingedSource | null) => {
      if (!item || (item.segments !== null && item.segments.length === 0)) return;
      testQueue.push(item);
      testChain = testChain.then(async () => {
        // 队列是 FIFO，队首就是自己：真正开测时出队，"测速中"图标跟着队首走
        if (testQueue[0] === item) testQueue.shift();
        measuringSource = item.source;
        set({ testingSource: item.source });
        try {
          await measureOneInner(item);
        } catch (e) {
          if (!signal.aborted) logger.warn(`[WARN] 完整测速失败 ${item.source_name}: ${String(e)}`);
        } finally {
          measuringSource = null;
          // 队列后面还有源的话，图标已经在写结果时交接过去了；没有才把图标收掉
          if (get().testingSource === item.source) set({ testingSource: null });
        }
      });
    };

    /**
     * 造一条"还没测速"的源（只造对象，不写进列表）。
     * 有推荐源时用它——PING 和测速作用重复（都是为了优选出优秀的源），
     * 所以推荐源和其它源都跳过 PING，直接进测速队列。
     */
    const makeUnmeasuredSource = (searchResult: SearchResult): PingedSource | null => {
      const m3u8Url = searchResult.episodes?.[0];
      if (!m3u8Url || pinged.has(searchResult.source)) return null;
      return {
        ...searchResult,
        // 跳过 PING：ping 耗时和倍率都留 0
        probe: { pingTime: 0, segmentLoadMs: null, segmentDurationMs: null, segmentRatio: 0 },
        segments: null,
        m3u8Url,
        // 还没测速，没法比较代理和直连，配了代理就先按代理播
        useProxy: !!proxyPrefix,
        insertSeq: -1,
      };
    };

    /**
     * 一条源可以用了（有推荐源时不 PING、WS 一到就用；没推荐源时 PING 完就用）：
     * 插进列表 + 立刻进测速队列。两条路径共用这一个入口，逻辑完全一致。
     * 此刻没有源在测的话，"测速中"图标在同一次 set 里就落到它身上，
     * 保证"出现在列表里"和"进测速队列"是同一帧，不会出现列表里有它却干等着不测的空档。
     */
    const insertAndEnqueue = (item: PingedSource | null): PingedSource | null => {
      if (!item || pinged.has(item.source)) return null;
      item.insertSeq = insertSeq++;
      // 没有源在测、队列也是空的：图标立刻落到这条新源上（和它出现在列表里同一次 set）
      const iconIdle = measuringSource === null && testQueue.length === 0;
      mergePinged([item], iconIdle ? { testingSource: item.source } : undefined);
      enqueueForTest(item);
      return item;
    };

    /** 并发 ping 这一批源：谁 ping 完谁就插进列表，插进去的同时进测速队列 */
    const pingAndMerge = async (results: SearchResult[]) => {
      await Promise.all(
        results.map(async (searchResult) => {
          const item = await pingSource(searchResult);
          if (signal.aborted || !item) return;
          insertAndEnqueue(item);
        }),
      );
    };

    /** 是否有推荐源（有的话它已经在播了，其它源可以攒齐再测） */
    let hasPreferredSource = false;

    try {
      // WS 搜索尽早发起：服务端搜完所有源本身要几秒，越早发起结果越早出来
      // （推荐源不 ping 直接播，所以这里发的搜索是给"其它源"用的）
      const searchAllStart = performance.now();
      logger.info(`[PERF] API searchVideos (background) START - query: "${q}", title: "${title}"`);
      const wsMessagesPromise = api.searchVideosWs(q || title, signal);
      wsMessagesPromise.catch(() => {}); // 提前 return 时不要留下 unhandled rejection，真正的错误在下面 await 处处理

      // Optimization for favorite navigation
      if (preferredSource && id) {
        const searchPreferredStart = performance.now();
        logger.info(`[PERF] API searchVideo (preferred) START - source: ${preferredSource}, title: "${title}"`);
        
        let preferredResult: SearchResult[] = [];
        let preferredSearchError: any = null;
        
        try {
          const response = await api.searchVideo(title, preferredSource, signal);
          preferredResult = response.results;
        } catch (error) {
          preferredSearchError = error;
          logger.error(`[ERROR] API searchVideo (preferred) FAILED - source: ${preferredSource}, error:`, error);
        }
        
        const searchPreferredEnd = performance.now();
        logger.info(`[PERF] API searchVideo (preferred) END - took ${(searchPreferredEnd - searchPreferredStart).toFixed(2)}ms, results: ${preferredResult.length}, error: ${!!preferredSearchError}`);
        
        if (signal.aborted) return;
        
        // 检查preferred source结果
        if (preferredResult.length > 0) {
          logger.info(`[SUCCESS] Preferred source "${preferredSource}" found ${preferredResult.length} results for "${q}"`);
          // 推荐源跳过 PING：优先命中 id 的那条，先直接拿来播放
          const preferred = preferredResult.find(item => String(item.id) === String(id)) ?? preferredResult[0];
          // 此刻还没别的源入队，插进去就排在列表/测速队列第一位，不等 WS 返回
          const preferredItem = insertAndEnqueue(makeUnmeasuredSource(preferred));
          hasPreferredSource = !!preferredItem;
          if (preferredItem) {
            logger.info(`[PERF] 推荐源 ${preferred.source_name} 跳过 PING 直接播放，并排到测速队列第一位`);
          }
        } else {
          if (preferredSearchError) {
            logger.warn(`[FALLBACK] Preferred source "${preferredSource}" failed with error, trying all sources immediately`);
          } else {
            logger.warn(`[FALLBACK] Preferred source "${preferredSource}" returned 0 results for "${q}", trying all sources immediately`);
          }
        }
      }

      try {
        const arrMessages = await wsMessagesPromise;
        const collected: SearchResult[] = [];
        const seenIds = new Set<number>();
        let resultComplete = false;

        // 收到的源先攒着，ping 完一批再合并：ping 很轻（清单 + HEAD），不会像下分片那样卡 UI
        const collectMessages = () => {
          while (arrMessages.length > 0) {
            const message = arrMessages.shift();
            if (message.type === 'complete') {
              // 搜索结束
              logger.info(`搜索结束`);
              resultComplete = true;
              continue;
            }
            if (message.type !== 'source_result' || !message.results?.length) continue;
            for (const item of message.results as SearchResult[]) {
              // 二次过滤title,year和stype
              const itemStype = item.episodes.length > 1 ? 'tv' : 'movie';
              const sameTitle = item.title.replace(' ', '') === title;
              const sameYear = String(item.year) === String(year);
              const sameType = stype === undefined || itemStype === stype;
              if (!sameTitle || !sameYear || !sameType) continue;
              if (seenIds.has(item.id)) continue; // 丢充重复的ID
              seenIds.add(item.id);
              collected.push(item);
            }
          }
        };

        /** 取出这一轮还没进过列表的源，顺手清空收集箱 */
        const takeFresh = () => {
          const fresh = collected.filter((item) => !pinged.has(item.source));
          collected.length = 0;
          return fresh;
        };

        while (!resultComplete) {
          if (signal.aborted) return;
          collectMessages();

          // WS 一条返回就 ping：ping 完立刻进测速队列，队列马上按顺序测，
          // 不用等所有源都搜完（第一个 ping 返回时如果没有推荐源就会自动开始播放）；
          // 有推荐源时跳过 PING，直接进列表并排队测速
          const fresh = takeFresh();
          if (fresh.length > 0) {
            if (hasPreferredSource) {
              // 有推荐源：跳过 PING，WS 结果直接显示在列表里，然后按顺序测速
              for (const searchResult of fresh) {
                insertAndEnqueue(makeUnmeasuredSource(searchResult));
              }
            } else {
              await pingAndMerge(fresh);
            }
            if (signal.aborted) return;
          }

          if (!resultComplete) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        const searchAllEnd = performance.now();
        logger.info(`[PERF] API searchVideos (background) END - took ${(searchAllEnd - searchAllStart).toFixed(2)}ms`);

        if (signal.aborted) return;
      } catch (backgroundError) {
        logger.warn(`[WARN] Background search failed`);
      }

      const finalState = get();
      
      // 最终检查：如果所有搜索都完成但仍然没有结果
      if (finalState.searchResults.length === 0 && !finalState.error) {
        logger.error(`[ERROR] All search attempts completed but no results found for "${q||title}"`);
        set({ error: `未找到 "${q||title}" 的播放源，请检查标题拼写或稍后重试` });
      } else if (finalState.searchResults.length > 0) {
        logger.info(`[SUCCESS] DetailStore.init completed successfully with ${finalState.searchResults.length} sources`);
      }

      const favoriteCheckStart = performance.now();
      if (finalState.detail) {
        const { source, id } = finalState.detail;
        logger.info(`[INFO] Checking favorite status for source: ${source}, id: ${id}`);
        try {
          const isFavorited = await FavoriteManager.isFavorited(source, id.toString());
          set({ isFavorited });
          logger.info(`[INFO] Favorite status: ${isFavorited}`);
        } catch (favoriteError) {
          logger.warn(`[WARN] Failed to check favorite status:`, favoriteError);
        }
      } else {
        logger.warn(`[WARN] No detail found after all search attempts for "${q}"`);
      }
      
      const favoriteCheckEnd = performance.now();
      logger.info(`[PERF] Favorite check took ${(favoriteCheckEnd - favoriteCheckStart).toFixed(2)}ms`);

      // 等测速队列把最后一个源也测完（队列是边搜边喂的，这里只是收尾）
      await testChain;
      if (signal.aborted) return;
      set({ allSourcesLoaded: true });
      logger.info(
        `[PERF] 完整测速 END - 共测 ${testedCount} 个源，` +
          `从开始到清空 ${(performance.now() - speedTestStart).toFixed(2)}ms`,
      );

    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        logger.error(`[ERROR] DetailStore.init caught unexpected error:`, e);
        const errorMessage = e instanceof Error ? e.message : "获取数据失败";
        set({ error: `搜索失败：${errorMessage}` });
      } else {
        logger.info(`[INFO] DetailStore.init aborted by user`);
      }
    } finally {
      if (!signal.aborted) {
        set({ loading: false, allSourcesLoaded: true });
        logger.info(`[INFO] DetailStore.init cleanup completed`);
      }
      
      const perfEnd = performance.now();
      logger.info(`[PERF] DetailStore.init COMPLETE - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    }
  },

  setDetail: async (detail) => {
    set({ detail });
    const { source, id } = detail;
    const isFavorited = await FavoriteManager.isFavorited(source, id.toString());
    set({ isFavorited });
  },

  abort: () => {
    get().controller?.abort();
  },

  toggleFavorite: async () => {
    const { detail } = get();
    if (!detail) return;

    const { source, id, title, poster, source_name, episodes, year } = detail;
    const favoriteItem = {
      cover: poster,
      title,
      poster,
      source_name,
      total_episodes: episodes.length,
      search_title: get().q!,
      year: year || "",
    };

    const newIsFavorited = await FavoriteManager.toggle(source, id.toString(), favoriteItem);
    set({ isFavorited: newIsFavorited });
  },

  markSourceAsFailed: (source: string, reason: string) => {
    const { failedSources } = get();
    const newFailedSources = new Set(failedSources);
    newFailedSources.add(source);
    
    logger.warn(`[SOURCE_FAILED] Marking source "${source}" as failed due to: ${reason}`);
    logger.info(`[SOURCE_FAILED] Total failed sources: ${newFailedSources.size}`);
    
    set({ failedSources: newFailedSources });
  },

  getNextAvailableSource: (currentSource: string, episodeIndex: number) => {
    const { searchResults, failedSources } = get();
    
    logger.info(`[SOURCE_SELECTION] Looking for alternative to "${currentSource}" for episode ${episodeIndex + 1}`);
    logger.info(`[SOURCE_SELECTION] Failed sources: [${Array.from(failedSources).join(', ')}]`);
    
    // 过滤掉当前source和已失败的sources
    const availableSources = searchResults.filter(result => 
      result.source !== currentSource && 
      !failedSources.has(result.source) &&
      result.episodes && 
      result.episodes.length > episodeIndex
    );
    
    logger.info(`[SOURCE_SELECTION] Available sources: ${availableSources.length}`);
    availableSources.forEach(source => {
      logger.info(`[SOURCE_SELECTION] - ${source.source} (${source.source_name}): ${source.episodes?.length || 0} episodes`);
    });
    
    if (availableSources.length === 0) {
      logger.error(`[SOURCE_SELECTION] No available sources for episode ${episodeIndex + 1}`);
      return null;
    }
    
    // 优先选择有高分辨率的source
    const sortedSources = availableSources.sort((a, b) => {
      const aResolution = a.resolution || '';
      const bResolution = b.resolution || '';
      
      // 优先级: 1080p > 720p > 其他 > 无分辨率
      const resolutionPriority = (res: string) => {
        if (res.includes('1080')) return 4;
        if (res.includes('720')) return 3;
        if (res.includes('480')) return 2;
        if (res.includes('360')) return 1;
        return 0;
      };
      
      return resolutionPriority(bResolution) - resolutionPriority(aResolution);
    });
    
    const selectedSource = sortedSources[0];
    logger.info(`[SOURCE_SELECTION] Selected fallback source: ${selectedSource.source} (${selectedSource.source_name}) with resolution: ${selectedSource.resolution || 'unknown'}`);
    
    return selectedSource;
  },
}));

export const sourcesSelector = (state: DetailState) => state.sources;
export default useDetailStore;
export const episodesSelectorBySource = (source: string, id: number) => (state: DetailState) =>
  state.searchResults.find((r) => r.source === source && r.id === id)?.episodes || [];
