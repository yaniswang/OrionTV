package com.oriontv

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.EventListener
import okhttp3.Protocol
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Proxy
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * 本地预缓存代理 —— 纯原生实现（Android）。
 *
 * 这里是代理的全部：HTTP 服务、HLS 清单改写、预取缓存、
 * 分片内存缓存、以及"边下边发给播放器"的流式下发。JS 只负责
 * 启动/停止和生成地址，不参与任何数据搬运。
 *
 * 每个分片只有一条上游连接（按 URL 共享）：
 *  - 预取 = 建立共享下载，只往内存缓冲写；
 *  - 播放器请求 = 挂一个消费者上去，先把已缓冲部分立刻写出去，
 *    之后每读到一块就同步写入该消费者；同一个分片不会被重复下载。
 */
@ReactModule(name = MediaProxyModule.NAME)
class MediaProxyModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "MediaProxy"

    private const val DEFAULT_CONNECT_TIMEOUT_MS = 15_000L
    /** 上游空闲读超时 */
    private const val DEFAULT_READ_TIMEOUT_MS = 60_000L
    /** 一次写回播放器的分块大小 */
    private const val BUFFER_BYTES = 64 * 1024
    private const val CRLF = "\r\n"
    private const val PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl"
    /** pid -> 分片列表 最多保留多少份 */
    private const val MAX_PLAYLISTS = 50
    /** pid -> 原始清单映射最多保留多少份；映射独立于清单缓存持久化 */
    private const val MAX_MANIFEST_REFS = 200
    private const val PORT_ATTEMPTS = 5
    /** 调试日志单文件上限，超过后从空文件重新写，避免长期调试无限增长 */
    private const val MAX_DEBUG_LOG_BYTES = 5L * 1024L * 1024L
    /** 在途数低于该值时补预取 */
    private const val PREFETCH_TRIGGER_INFLIGHT = 6
    /** 单次最多新增的预取数 */
    private const val MAX_PREFETCH_PER_TRIGGER = 5
    /** 清单和已完成未消费缓存的超时时间 */
    private const val CACHE_TTL_MS = 5L * 60L * 1000L
    /** 后台清理周期 */
    private const val CACHE_CLEAN_INTERVAL_MS = 60L * 1000L
    /** 预取缓存总大小上限 */
    private const val MAX_CACHE_BYTES = 128L * 1024L * 1024L

    private val FORWARD_HEADER_KEYS = listOf(
      "user-agent", "referer", "origin", "cookie", "authorization", "accept-language",
    )
    private val HOP_BY_HOP_HEADERS = setOf(
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailer", "transfer-encoding", "upgrade", "accept-encoding",
      "host", "content-length",
    )
  }

  // ------------------------------------------------------------------ 状态

  private var serverSocket: ServerSocket? = null
  private var origin: String? = null
  private var accepting = false

  /** pid -> 清单状态（分片列表、活跃时间、在途数和预取缓存字节数） */
  private val playlists = ConcurrentHashMap<String, PlaylistState>()
  /** pid -> 原始清单地址和请求头；清单缓存过期后仍可用于懒加载恢复 */
  private val manifestRefs = ConcurrentHashMap<String, ManifestRef>()
  /** 同一 pid 的清单恢复只允许一个线程执行，其它分片请求等待同一结果 */
  private val manifestLoadTasks = ConcurrentHashMap<String, ManifestLoadTask>()
  /** pid+sid -> 共享下载（数据面唯一的真相来源） */
  private val downloads = ConcurrentHashMap<String, SharedDownload>()
  /** 后台清理定时器 */
  private var cacheCleaner: ScheduledExecutorService? = null

  private class PlaylistState(
    val pid: String,
    val segments: List<String>,
  ) {
    @Volatile var lastActiveAt = System.currentTimeMillis()
    val inFlightCount = AtomicInteger(0)
    val cacheBytes = AtomicLong(0)
  }

  private class ManifestRef(
    val pid: String,
    val manifestUrl: String,
    headers: Map<String, String>,
  ) {
    @Volatile var headers: Map<String, String> = headers
    @Volatile var lastAccessAt = System.currentTimeMillis()
  }

  private class ManifestLoadTask {
    val lock = Object()
    var completed = false
    var playlist: PlaylistState? = null
  }

  /** 本机播放器成功回源时用过的关键请求头，投屏后交给电视复用 */
  private val preferredHeadersByTarget = ConcurrentHashMap<String, Map<String, String>>()
  private val preferredHeadersByOrigin = ConcurrentHashMap<String, Map<String, String>>()

  private val okHttpClient: OkHttpClient by lazy { buildClient() }

  private val debugLogLock = Any()
  private var debugLogWriter: BufferedWriter? = null
  private val debugLogFile: File by lazy { File(reactContext.filesDir, "media-proxy.log") }
  private val manifestRefsFile: File by lazy { File(reactContext.filesDir, "media-proxy-manifests.json") }
  private val manifestStoreLock = Any()
  @Volatile private var manifestRefsLoaded = false
  @Volatile private var manifestRefsDirty = false

  override fun getName(): String = NAME

  // ------------------------------------------------------------------ 调试日志

  /**
   * 调试构建同时写 Logcat 和 files/media-proxy.log。
   * 日志文件按行 flush，方便 adb shell 持续 tail。
   */
  private fun debugLog(message: String, level: String = "DEBUG") {
    if (!BuildConfig.DEBUG) return
    val timestamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
    val line = "[$timestamp][$level] $message"
    Log.d(NAME, line)

    synchronized(debugLogLock) {
      try {
        if (debugLogWriter == null) {
          debugLogFile.parentFile?.mkdirs()
          if (debugLogFile.length() > MAX_DEBUG_LOG_BYTES) {
            debugLogFile.writeText("")
          }
          debugLogWriter = BufferedWriter(FileWriter(debugLogFile, true))
        }
        debugLogWriter?.apply {
          write(line)
          newLine()
          flush()
        }
      } catch (error: Throwable) {
        Log.w(NAME, "写调试文件失败: ${error.message}", error)
        try {
          debugLogWriter?.close()
        } catch (_: Throwable) {
        }
        debugLogWriter = null
      }
    }
  }

  private fun closeDebugLog() {
    synchronized(debugLogLock) {
      try {
        debugLogWriter?.close()
      } catch (_: Throwable) {
      }
      debugLogWriter = null
    }
  }

  private fun shortUrl(url: String): String = if (url.length <= 220) url else url.take(220) + "..."

  // ------------------------------------------------------------------ JS 接口

  /** 启动代理；已启动则直接返回现有地址 */
  @ReactMethod
  fun start(options: ReadableMap, promise: Promise) {
    thread(name = "media-proxy-start") {
      try {
        promise.resolve(Arguments.createMap().apply { putString("origin", ensureStarted(preferredPort(options))) })
      } catch (error: Throwable) {
        promise.reject("E_PROXY_START", error.message, error)
      }
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    thread(name = "media-proxy-stop") {
      try {
        stopServer()
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("E_PROXY_STOP", error.message, error)
      }
    }
  }

  /** 把播放地址包成本地代理地址；非 HLS 或代理不可用时原样返回 */
  @ReactMethod
  fun wrapUrl(target: String, promise: Promise) {
    thread(name = "media-proxy-wrap") {
      promise.resolve(wrap(target))
    }
  }

  /** 批量包装剧集地址；整份列表里没有 HLS 时不会启动代理 */
  @ReactMethod
  fun wrapUrls(targets: ReadableArray, promise: Promise) {
    thread(name = "media-proxy-wrap") {
      val raw = ArrayList<String>(targets.size())
      for (index in 0 until targets.size()) {
        raw.add(targets.getString(index))
      }
      if (raw.none { isHlsUrl(it) }) {
        promise.resolve(Arguments.fromList(raw))
        return@thread
      }
      val base = ensureStartedOrNull()
      if (base == null) {
        promise.resolve(Arguments.fromList(raw))
        return@thread
      }
      val plain = raw.map { MediaProxyPlaylist.unwrapProxyUrl(it, base) }
      promise.resolve(Arguments.fromList(plain.map { if (isHlsUrl(it)) MediaProxyPlaylist.buildProxyUrl(base, it) else it }))
    }
  }

  /** 切换播放出口时取消所有在途下载并清空分片缓存 */
  @ReactMethod
  fun cancelDownloads() {
    releaseAllDownloads(force = true)
  }

  private fun preferredPort(options: ReadableMap): Int =
    if (options.hasKey("preferredPort")) options.getInt("preferredPort") else 18923

  private fun wrap(target: String): String {
    if (!isHlsUrl(target)) return target
    val base = ensureStartedOrNull() ?: return target
    val unwrapped = MediaProxyPlaylist.unwrapProxyUrl(target, base)
    return MediaProxyPlaylist.buildProxyUrl(base, unwrapped)
  }

  private fun ensureStartedOrNull(): String? = try {
    ensureStarted(18923)
  } catch (_: Throwable) {
    null
  }

  private fun isHlsUrl(url: String): Boolean = url.lowercase().contains("m3u8")

  // ------------------------------------------------------------------ 生命周期

  @Synchronized
  private fun ensureStarted(preferredPort: Int): String {
    origin?.let { return it }
    loadManifestRefs()
    val lan = getLanIPv4Address() ?: throw IOException("未获取到局域网 IP")
    val candidates = listOf(0) + (0 until PORT_ATTEMPTS).map { preferredPort + it }
    var lastError: Throwable? = null
    for (port in candidates) {
      try {
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress("0.0.0.0", port))
        serverSocket = socket
        accepting = true
        val resolved = socket.localPort
        val value = "http://$lan:$resolved"
        origin = value
        debugLog("代理启动 origin=$value")
        acceptLoop(socket)
        startCacheCleaner()
        return value
      } catch (error: Throwable) {
        lastError = error
        debugLog("端口启动失败 port=$port error=${error.message}")
      }
    }
    throw IOException("本地代理启动失败: ${lastError?.message}")
  }

  @Synchronized
  private fun stopServer() {
    debugLog("代理停止")
    accepting = false
    try {
      serverSocket?.close()
    } catch (_: Throwable) {
    }
    serverSocket = null
    origin = null
    stopCacheCleaner()
    persistManifestRefsIfDirty()
    playlists.clear()
    preferredHeadersByTarget.clear()
    preferredHeadersByOrigin.clear()
    releaseAllDownloads(force = true)
    closeDebugLog()
  }

  @Synchronized
  private fun startCacheCleaner() {
    if (cacheCleaner != null) return
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "media-proxy-cleaner").apply { isDaemon = true }
    }
    executor.scheduleWithFixedDelay(
      {
        try {
          cleanupExpired()
        } catch (error: Throwable) {
          debugLog("代理清理失败: ${error.message}")
        }
      },
      CACHE_CLEAN_INTERVAL_MS,
      CACHE_CLEAN_INTERVAL_MS,
      TimeUnit.MILLISECONDS,
    )
    cacheCleaner = executor
  }

  @Synchronized
  private fun stopCacheCleaner() {
    cacheCleaner?.shutdownNow()
    cacheCleaner = null
  }

  private fun releaseAllDownloads(force: Boolean = false) {
    downloads.values.toList().forEach { releaseDownload(it.key, it, force) }
  }

  private fun acceptLoop(socket: ServerSocket) {
    thread(name = "media-proxy-accept") {
      while (accepting && !socket.isClosed) {
        val client = try {
          socket.accept()
        } catch (_: Throwable) {
          break
        }
        thread(name = "media-proxy-conn") { handleConnection(client) }
      }
    }
  }


  private fun getLanIPv4Address(): String? {
    return try {
      for (iface in Collections.list(NetworkInterface.getNetworkInterfaces())) {
        if (!iface.isUp || iface.isLoopback) continue
        for (address in Collections.list(iface.inetAddresses)) {
          if (address is java.net.Inet4Address && address.isSiteLocalAddress && !address.isLoopbackAddress) {
            return address.hostAddress
          }
        }
      }
      null
    } catch (_: Throwable) {
      null
    }
  }

  // ------------------------------------------------------------------ 连接处理

  private fun handleConnection(socket: Socket) {
    try {
      socket.soTimeout = 30_000
      socket.tcpNoDelay = true
      val input = BufferedInputStream(socket.getInputStream())
      val output = BufferedOutputStream(socket.getOutputStream())
      while (true) {
        val head = readHead(input) ?: break
        val parsed = parseRequest(head) ?: break
        val keepAlive = !parsed.headers["connection"].orEmpty().contains("close", ignoreCase = true)
        dispatch(parsed, socket, output, keepAlive)
        if (!keepAlive) break
      }
    } catch (_: SocketTimeoutException) {
      // keep-alive 空闲连接超时，属于正常回收，不记录日志。
    } catch (error: Throwable) {
      debugLog("连接处理失败: ${error.message}")
    } finally {
      try {
        socket.close()
      } catch (_: Throwable) {
      }
    }
  }

  private data class ParsedRequest(
    val method: String,
    /** 请求行里的原始 target（含 ?query） */
    val rawTarget: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
  )

  private fun readHead(input: BufferedInputStream): String? {
    val buffer = ByteArrayOutputStream(1024)
    var matched = 0
    while (true) {
      val next = input.read()
      if (next == -1) return null
      buffer.write(next)
      matched = when {
        matched == 0 && next == '\r'.code -> 1
        matched == 1 && next == '\n'.code -> 2
        matched == 2 && next == '\r'.code -> 3
        matched == 3 && next == '\n'.code -> 4
        next == '\r'.code -> 1
        else -> 0
      }
      if (matched == 4) return String(buffer.toByteArray(), Charsets.ISO_8859_1)
    }
  }

  private fun parseRequest(head: String): ParsedRequest? {
    val lines = head.split(CRLF)
    if (lines.isEmpty()) return null
    val requestLine = lines[0].split(" ")
    if (requestLine.size < 3) return null
    val headers = HashMap<String, String>()
    for (index in 1 until lines.size) {
      val line = lines[index]
      val colon = line.indexOf(':')
      if (colon <= 0) continue
      headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
    }
    val target = requestLine[1]
    val question = target.indexOf('?')
    val path = if (question >= 0) target.substring(0, question) else target
    val query = HashMap<String, String>()
    if (question >= 0) {
      target.substring(question + 1).split("&").forEach { pair ->
        val eq = pair.indexOf('=')
        if (eq > 0) query[pair.substring(0, eq)] = pair.substring(eq + 1)
      }
    }
    return ParsedRequest(requestLine[0].uppercase(), target, path, query, headers)
  }

  // ------------------------------------------------------------------ 分发

  private fun dispatch(
    request: ParsedRequest,
    socket: Socket,
    output: BufferedOutputStream,
    keepAlive: Boolean,
  ) {
    val requestToken = request.rawTarget.removePrefix("/")
    val resourceTarget = MediaProxyPlaylist.decodeProxyTarget(requestToken)
    if (MediaProxyPlaylist.isHttpTarget(resourceTarget)) {
      // 清单、密钥、初始化段等资源：path 令牌解码一次，完整保留上游 URL 和 query。
      val forwardHeaders = resolveForwardHeaders(resourceTarget, forwardable(request.headers))
      serveResource(resourceTarget, request, forwardHeaders, output, keepAlive)
      return
    }

    // 分片只带标识：/<pid>/<sid>/seg.<原扩展名>，回源地址从登记表读取。
    val located = parseSegmentPath(request.path)
    if (located == null) {
      writeSimple(output, 404, "text/plain", "not found".toByteArray(), keepAlive)
      return
    }
    val (pid, sid) = located
    val playlist = playlists[pid] ?: ensurePlaylistLoaded(pid)
    playlist?.lastActiveAt = System.currentTimeMillis()
    val target = playlist?.segments?.getOrNull(sid)
    if (target == null) {
      debugLog("分片登记缺失 pid=$pid sid=$sid path=${request.path}")
      writeSimple(output, 404, "text/plain", "segment not found".toByteArray(), keepAlive)
      return
    }
    val forwardHeaders = resolveForwardHeaders(target, forwardable(request.headers))
    serveSegment(pid, sid, target, forwardHeaders, socket, output, keepAlive)
  }

  /** 解析 /\<pid\>/\<sid\>/seg.<原扩展名>；文件名只用于播放器识别类型，回源不依赖它。 */
  private fun parseSegmentPath(path: String): Pair<String, Int>? {
    val parts = path.removePrefix("/").split('/')
    if (parts.size != 3) return null
    val pid = parts[0]
    if (!Regex("^[a-z0-9]+$").matches(pid)) return null
    val sid = parts[1].toIntOrNull() ?: return null
    if (sid < 0 || parts[2].isEmpty()) return null
    return pid to sid
  }

  /** 分片：命中缓存直接写，命中在途先写已缓冲再续流，都没有则新建下载并流式写 */
  private fun serveSegment(
    pid: String,
    sid: Int,
    target: String,
    headers: Map<String, String>,
    socket: Socket,
    output: BufferedOutputStream,
    keepAlive: Boolean,
  ) {
    playlists[pid]?.lastActiveAt = System.currentTimeMillis()

    val key = downloadKey(pid, sid)
    val existing = downloads[key]
    val source = when {
      existing?.completed == true -> "缓存"
      existing != null -> "在途"
      else -> "上游"
    }
    var download: SharedDownload
    var consumer: Consumer
    while (true) {
      val candidate = downloads.computeIfAbsent(key) { SharedDownload(key, target, pid, sid, false, headers) }
      val candidateConsumer = Consumer(candidate, socket, output, keepAlive)
      val accepted = synchronized(candidate.lock) {
        if (downloads[key] !== candidate) {
          false
        } else {
          candidate.released = false
          candidate.consumers.add(candidateConsumer)
          if (candidate.prefetch) candidate.consumed = true
          true
        }
      }
      if (accepted) {
        download = candidate
        consumer = candidateConsumer
        break
      }
    }
    debugLog("读取数据 pid=$pid sid=$sid 来源=$source")
    startDownloadIfNeeded(download, headers)
    consumer.start()
    consumer.join()

    maybePrefetch(pid, sid, headers)
  }

  /** 清单 / key / 其它资源：整段取回后再返回（体量小） */
  private fun serveResource(
    target: String,
    request: ParsedRequest,
    headers: Map<String, String>,
    output: BufferedOutputStream,
    keepAlive: Boolean,
  ) {
    val builder = Request.Builder().url(target).get()
    builder.header("Accept-Encoding", "identity")
    headers.forEach { (key, value) -> builder.header(key, value) }
    request.headers["range"]?.let { builder.header("Range", it) }
    val upstreamRequest = builder.build()
    val startedAt = System.currentTimeMillis()
    val call = okHttpClient.newCall(upstreamRequest)
    val response = try {
      call.execute()
    } catch (error: Throwable) {
      val timeout = error is SocketTimeoutException
      debugLog("资源回源失败 status=${if (timeout) 504 else 502} 用时=${System.currentTimeMillis() - startedAt}ms url=${shortUrl(target)} error=${error.message}")
      writeSimple(output, if (timeout) 504 else 502, "text/plain", "upstream error".toByteArray(), false)
      return
    }

    if (shouldResetConnection(response.code)) {
      val status = response.code
      val contentType = response.header("Content-Type") ?: "text/plain"
      val headOnly = request.method == "HEAD"
      call.cancel()
      closeResponse(response)
      debugLog("资源上游错误，关闭连接 status=$status url=${shortUrl(target)}")
      writeSimple(output, status, contentType, ByteArray(0), keepAlive, headOnly)
      return
    }

    response.use { current ->
      val bytes = current.body?.bytes() ?: ByteArray(0)
      val contentType = current.header("Content-Type") ?: "application/octet-stream"
      val maybePlaylist = contentType.lowercase().contains("mpegurl") || target.lowercase().contains(".m3u8")
      if (!maybePlaylist) {
        writeSimple(output, current.code, contentType, bytes, keepAlive, request.method == "HEAD")
      } else {
        val text = String(bytes, Charsets.UTF_8)
        if (!MediaProxyPlaylist.isHlsPlaylist(text)) {
          writeSimple(output, current.code, contentType, bytes, keepAlive, request.method == "HEAD")
        } else {
          val base = origin ?: ""
          val rewritten = if (MediaProxyPlaylist.isLeafPlaylist(text)) {
            val leaf = MediaProxyPlaylist.rewriteLeafPlaylist(text, base, target)
            rememberManifestRef(leaf.pid, target, headers)
            rememberPlaylist(leaf.pid, leaf.segments)
            debugLog("清单登记 pid=${leaf.pid} 分片数=${leaf.segments.size} url=${shortUrl(target)}")
            leaf.text
          } else {
            MediaProxyPlaylist.rewriteChildPlaylist(text, base, target)
          }
          writeSimple(
            output,
            current.code,
            PLAYLIST_CONTENT_TYPE,
            rewritten.toByteArray(Charsets.UTF_8),
            keepAlive,
            request.method == "HEAD",
          )
        }
      }
    }
  }

  // ------------------------------------------------------------------ 清单映射与恢复

  private fun normalizeManifestHeaders(headers: Map<String, String>): Map<String, String> {
    val normalized = HashMap<String, String>()
    headers.forEach { (key, value) ->
      val lower = key.lowercase(Locale.US)
      if (FORWARD_HEADER_KEYS.contains(lower)) normalized[lower] = value
    }
    return normalized
  }

  /** 记录 pid 对应的原始叶子清单，供清单缓存过期或 APP 重启后恢复。 */
  private fun rememberManifestRef(pid: String, manifestUrl: String, headers: Map<String, String>) {
    val normalizedHeaders = normalizeManifestHeaders(headers)
    val now = System.currentTimeMillis()
    val existing = manifestRefs[pid]
    if (existing != null) {
      existing.lastAccessAt = now
      if (existing.manifestUrl != manifestUrl) {
        debugLog("清单映射冲突 pid=$pid existing=${shortUrl(existing.manifestUrl)} incoming=${shortUrl(manifestUrl)}")
        return
      }
      if (normalizedHeaders.isNotEmpty() && normalizedHeaders != existing.headers) {
        existing.headers = normalizedHeaders
        manifestRefsDirty = true
      }
      persistManifestRefsIfDirty()
      return
    }

    manifestRefs[pid] = ManifestRef(pid, manifestUrl, normalizedHeaders).apply { lastAccessAt = now }
    manifestRefsDirty = true
    trimManifestRefs()
    persistManifestRefsIfDirty()
  }

  private fun touchManifestRef(pid: String) {
    val ref = manifestRefs[pid] ?: return
    ref.lastAccessAt = System.currentTimeMillis()
    manifestRefsDirty = true
  }

  private fun trimManifestRefs() {
    while (manifestRefs.size > MAX_MANIFEST_REFS) {
      val oldest = manifestRefs.values.minByOrNull { it.lastAccessAt } ?: break
      manifestRefs.remove(oldest.pid)
      manifestRefsDirty = true
    }
  }

  /**
   * 分片请求没有清单数据时，用持久化的原始清单地址恢复。
   * 同一 pid 的并发请求共用一个加载任务，不会同时回源多份清单。
   */
  private fun ensurePlaylistLoaded(pid: String): PlaylistState? {
    playlists[pid]?.let {
      touchManifestRef(pid)
      return it
    }

    val task = manifestLoadTasks.computeIfAbsent(pid) { ManifestLoadTask() }
    synchronized(task.lock) {
      var result = task.playlist
      if (!task.completed) {
        result = loadManifestPlaylist(pid)
        task.playlist = result
        task.completed = true
        manifestLoadTasks.remove(pid, task)
      } else if (playlists[pid] != null) {
        result = playlists[pid]
      }
      touchManifestRef(pid)
      return result
    }
  }

  private fun loadManifestPlaylist(pid: String): PlaylistState? {
    val ref = manifestRefs[pid]
    if (ref == null) {
      debugLog("清单映射缺失 pid=$pid")
      return null
    }

    val startedAt = System.currentTimeMillis()
    debugLog("分片触发清单初始化 pid=$pid url=${shortUrl(ref.manifestUrl)}")
    val builder = Request.Builder().url(ref.manifestUrl).get()
    builder.header("Accept-Encoding", "identity")
    ref.headers.forEach { (key, value) -> builder.header(key, value) }

    val call = okHttpClient.newCall(builder.build())
    val response = try {
      call.execute()
    } catch (error: Throwable) {
      debugLog(
        "清单初始化失败 pid=$pid 用时=${System.currentTimeMillis() - startedAt}ms " +
          "url=${shortUrl(ref.manifestUrl)} error=${error.message}",
      )
      return null
    }

    if (shouldResetConnection(response.code)) {
      val status = response.code
      call.cancel()
      closeResponse(response)
      debugLog(
        "清单初始化失败 pid=$pid status=$status 用时=${System.currentTimeMillis() - startedAt}ms " +
          "url=${shortUrl(ref.manifestUrl)}",
      )
      return null
    }

    response.use { current ->

      val bytes = current.body?.bytes() ?: ByteArray(0)
      val text = String(bytes, Charsets.UTF_8)
      if (!MediaProxyPlaylist.isHlsPlaylist(text) || !MediaProxyPlaylist.isLeafPlaylist(text)) {
        debugLog("清单初始化失败 pid=$pid 返回内容不是叶子清单 url=${shortUrl(ref.manifestUrl)}")
        return null
      }

      val base = origin
      if (base.isNullOrEmpty()) {
        debugLog("清单初始化失败 pid=$pid 代理 origin 为空")
        return null
      }
      val leaf = MediaProxyPlaylist.rewriteLeafPlaylist(text, base, ref.manifestUrl)
      if (leaf.pid != pid) {
        debugLog("清单初始化标识不匹配 expected=$pid actual=${leaf.pid} url=${shortUrl(ref.manifestUrl)}")
        return null
      }

      rememberManifestRef(pid, ref.manifestUrl, ref.headers)
      rememberPlaylist(pid, leaf.segments)
      debugLog(
        "清单初始化完成 pid=$pid 分片数=${leaf.segments.size} " +
          "用时=${System.currentTimeMillis() - startedAt}ms url=${shortUrl(ref.manifestUrl)}",
      )
      return playlists[pid]
    }
  }

  private fun loadManifestRefs() {
    if (manifestRefsLoaded) return
    manifestRefsLoaded = true
    val file = manifestRefsFile
    if (!file.isFile) return

    try {
      val root = JSONObject(file.readText(Charsets.UTF_8))
      val entries = root.optJSONArray("entries") ?: JSONArray()
      for (index in 0 until entries.length()) {
        val item = entries.optJSONObject(index) ?: continue
        val pid = item.optString("pid").trim()
        val manifestUrl = item.optString("manifestUrl").trim()
        if (pid.isEmpty() || manifestUrl.isEmpty()) continue

        val headers = HashMap<String, String>()
        val headerObject = item.optJSONObject("headers")
        headerObject?.keys()?.forEach { key ->
          val value = headerObject.optString(key)
          if (value.isNotEmpty()) headers[key] = value
        }
        manifestRefs[pid] = ManifestRef(pid, manifestUrl, headers).apply {
          lastAccessAt = item.optLong("lastAccessAt", System.currentTimeMillis())
        }
      }
      trimManifestRefs()
      persistManifestRefsIfDirty()
      debugLog("清单映射加载完成 count=${manifestRefs.size}")
    } catch (error: Throwable) {
      debugLog("清单映射加载失败 error=${error.message}")
    }
  }

  private fun persistManifestRefsIfDirty() {
    if (!manifestRefsDirty) return
    synchronized(manifestStoreLock) {
      if (!manifestRefsDirty) return
      try {
        val entries = JSONArray()
        manifestRefs.values.sortedBy { it.lastAccessAt }.forEach { ref ->
          val headerObject = JSONObject()
          ref.headers.forEach { (key, value) -> headerObject.put(key, value) }
          entries.put(
            JSONObject()
              .put("pid", ref.pid)
              .put("manifestUrl", ref.manifestUrl)
              .put("headers", headerObject)
              .put("lastAccessAt", ref.lastAccessAt),
          )
        }
        val root = JSONObject()
          .put("version", 1)
          .put("entries", entries)
        val tempFile = File(manifestRefsFile.parentFile, manifestRefsFile.name + ".tmp")
        tempFile.writeText(root.toString(), Charsets.UTF_8)
        if (!tempFile.renameTo(manifestRefsFile)) {
          manifestRefsFile.writeText(tempFile.readText(Charsets.UTF_8), Charsets.UTF_8)
          tempFile.delete()
        }
        manifestRefsDirty = false
      } catch (error: Throwable) {
        debugLog("清单映射保存失败 error=${error.message}")
      }
    }
  }

  // ------------------------------------------------------------------ 通用响应

  private fun writeSimple(
    output: BufferedOutputStream,
    status: Int,
    contentType: String,
    body: ByteArray,
    keepAlive: Boolean,
    headOnly: Boolean = false,
  ) {
    val noStore = contentType.lowercase(Locale.US).contains("mpegurl")
    val head = buildString {
      append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append(CRLF)
      append("Content-Type: ").append(contentType).append(CRLF)
      append("Content-Length: ").append(body.size).append(CRLF)
      append("Accept-Ranges: bytes").append(CRLF)
      if (noStore) {
        append("Cache-Control: no-store, no-cache, must-revalidate").append(CRLF)
        append("Pragma: no-cache").append(CRLF)
        append("Expires: 0").append(CRLF)
      }
      append("Connection: ").append(if (keepAlive) "keep-alive" else "close").append(CRLF)
      append("Access-Control-Allow-Origin: *").append(CRLF)
      append(CRLF)
    }
    output.write(head.toByteArray(Charsets.ISO_8859_1))
    if (!headOnly && body.isNotEmpty()) output.write(body)
    output.flush()
  }

  /** 4xx/5xx 后关闭当前请求连接，避免下一次请求复用异常上游连接。 */
  private fun shouldResetConnection(status: Int): Boolean = status in 400..599

  /** 4xx/5xx 收到后立即关闭响应，避免连接带着错误响应回到连接池。 */
  private fun closeResponse(response: Response) {
    try {
      response.close()
    } catch (_: Throwable) {
    }
  }

  private fun statusText(status: Int): String = when (status) {
    200 -> "OK"
    206 -> "Partial Content"
    301 -> "Moved Permanently"
    302 -> "Found"
    304 -> "Not Modified"
    400 -> "Bad Request"
    403 -> "Forbidden"
    404 -> "Not Found"
    416 -> "Range Not Satisfiable"
    500 -> "Internal Server Error"
    502 -> "Bad Gateway"
    504 -> "Gateway Timeout"
    else -> "Proxy"
  }

  // ------------------------------------------------------------------ 共享下载

  private fun downloadKey(pid: String, sid: Int): String = "$pid/$sid"

  private inner class SharedDownload(
    val key: String,
    val url: String,
    val pid: String,
    val sid: Int,
    val prefetch: Boolean,
    headers: Map<String, String>,
  ) {
    val requestHeaders: Map<String, String> = HashMap(headers)
    val lock = Object()
    val chunks = ArrayList<ByteArray>()
    val consumers = ArrayList<Consumer>()
    var status = 0
    var contentType: String? = null
    var contentLength = -1L
    var contentRange: String? = null
    var lastModified: String? = null
    var etag: String? = null
    @Volatile var completed = false
    @Volatile var failure: String? = null
    @Volatile var call: Call? = null
    @Volatile var debugStartedAt = 0L
    @Volatile var completedAt = 0L
    @Volatile var released = false
    /** 预取缓存被消费者读取过后，等所有消费者退出再释放 */
    @Volatile var consumed = false
    /** 只统计预取缓存的字节数 */
    @Volatile var cachedBytes = 0L
    /** 是否已经计入清单在途数，保证只加减一次 */
    var inFlightCounted = false
  }

  private inner class Consumer(
    private val download: SharedDownload,
    private val socket: Socket,
    private val output: OutputStream,
    private val keepAlive: Boolean,
  ) : Thread("media-proxy-consumer") {
    private var chunkIndex = 0
    private var headWritten = false
    private var chunked = false

    override fun run() {
      try {
        while (true) {
          val ready: List<ByteArray>
          val done: Boolean
          val error: String?
          var headToWrite: ByteArray? = null
          synchronized(download.lock) {
            while (download.chunks.size <= chunkIndex && !download.completed && download.failure == null) {
              download.lock.wait()
            }
            if (!headWritten) {
              if (download.status == 0 && download.failure != null) throw IOException(download.failure)
              chunked = download.contentLength < 0
              headToWrite = buildHead(download, chunked, keepAlive).toByteArray(Charsets.ISO_8859_1)
              headWritten = true
            }
            ready = if (download.chunks.size > chunkIndex) {
              ArrayList(download.chunks.subList(chunkIndex, download.chunks.size))
            } else {
              emptyList()
            }
            done = download.completed
            error = download.failure
          }
          // 网络写和 flush 不放 download.lock，避免慢客户端拖住共享下载。
          if (headToWrite != null) {
            output.write(headToWrite)
            output.flush()
          }
          for (chunk in ready) {
            if (chunked) {
              output.write("${Integer.toHexString(chunk.size)}$CRLF".toByteArray(Charsets.ISO_8859_1))
              output.write(chunk)
              output.write(CRLF.toByteArray(Charsets.ISO_8859_1))
            } else {
              output.write(chunk)
            }
            chunkIndex += 1
          }
          output.flush()
          if (error != null) throw IOException(error)
          if (done && synchronized(download.lock) { chunkIndex >= download.chunks.size }) break
        }
        if (chunked) {
          output.write("0$CRLF$CRLF".toByteArray(Charsets.ISO_8859_1))
          output.flush()
        }
      } catch (_: Throwable) {
        try {
          socket.close()
        } catch (_: Throwable) {
        }
      } finally {
        detach()
      }
    }

    private fun detach() {
      var callToCancel: Call? = null
      synchronized(download.lock) {
        download.consumers.remove(this)
        if (download.consumers.isEmpty() && shouldReleaseAfterConsumers(download)) {
          downloads.remove(download.key, download)
          releaseResourcesLocked(download)
          callToCancel = download.call
        }
      }
      callToCancel?.cancel()
    }
  }

  private fun inFlightSidsOf(pid: String): List<Int> {
    return downloads.values
      .filter { it.pid == pid && !it.completed }
      .map { it.sid }
      .sorted()
  }

  private fun logPrefetchEnd(download: SharedDownload) {
    if (!download.prefetch) return
    val elapsed = if (download.debugStartedAt > 0) {
      System.currentTimeMillis() - download.debugStartedAt
    } else {
      0L
    }
    val playlist = playlists[download.pid]
    debugLog(
      "预取结束 pid=${download.pid} sid=${download.sid} 在途=${playlist?.inFlightCount?.get() ?: 0} " +
        "缓存字节=${playlist?.cacheBytes?.get() ?: 0} 用时=${elapsed}ms",
    )
  }

  /** 必须在持有 download.lock 时调用。 */
  private fun markDownloadFailureLocked(download: SharedDownload, status: Int, contentType: String?, message: String) {
    download.call = null
    download.status = status
    download.contentType = contentType
    download.contentLength = 0
    download.contentRange = null
    download.lastModified = null
    download.etag = null
    download.failure = message
    download.completed = true
    download.completedAt = System.currentTimeMillis()
    markDownloadFinishedLocked(download)
    download.lock.notifyAll()
  }

  private fun startDownloadIfNeeded(download: SharedDownload, headers: Map<String, String>): Boolean {
    // 快速路径：已经启动或已结束的分片不需要再构建请求。
    if (download.call != null || download.completed) return false

    // 构建请求和初始化 OkHttp 都放在锁外，锁内只做状态判定和 call 赋值。
    val client = okHttpClient
    val builder = Request.Builder().url(download.url).get()
    builder.header("Accept-Encoding", "identity")
    headers.forEach { (key, value) ->
      if (!HOP_BY_HOP_HEADERS.contains(key.lowercase())) builder.header(key, value)
    }
    val request = builder.build()

    val call = synchronized(download.lock) {
      if (download.call != null || download.completed) return false
      // 已被清理标记且没有消费者时不能复活；有消费者时允许继续启动。
      if (download.released && download.consumers.isEmpty()) return false
      download.released = false
      val newCall = client.newCall(request)
      download.call = newCall
      download.debugStartedAt = System.currentTimeMillis()
      markDownloadStartedLocked(download)
      newCall
    }
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        val elapsed = if (download.debugStartedAt > 0) System.currentTimeMillis() - download.debugStartedAt else 0L
        debugLog("分片回源失败 pid=${download.pid} sid=${download.sid} 用时=${elapsed}ms error=${e.message} url=${shortUrl(download.url)}")
        synchronized(download.lock) {
          if (download.completed) return
          download.call = null
          download.failure = e.message ?: "upstream failed"
          download.completed = true
          download.completedAt = System.currentTimeMillis()
          markDownloadFinishedLocked(download)
          download.lock.notifyAll()
        }
        logPrefetchEnd(download)
      }

      override fun onResponse(call: Call, response: Response) {
        val startedAt = if (download.debugStartedAt > 0) download.debugStartedAt else System.currentTimeMillis()
        val statusCode = response.code
        val resetConnection = shouldResetConnection(statusCode)
        var receivedBytes = 0L

        if (resetConnection) {
          val contentType = response.header("Content-Type") ?: "text/plain"
          call.cancel()
          closeResponse(response)
          synchronized(download.lock) {
            markDownloadFailureLocked(download, statusCode, contentType, "upstream HTTP $statusCode")
          }
          debugLog(
            "分片上游错误，关闭连接 pid=${download.pid} sid=${download.sid} " +
              "status=$statusCode url=${shortUrl(download.url)}",
          )
          releaseDownload(download.key, download)
          logPrefetchEnd(download)
          return
        }

        synchronized(download.lock) {
          if (download.completed) return
          download.status = statusCode
          download.contentType = response.header("Content-Type")
          download.contentLength = response.body?.contentLength() ?: -1L
          download.contentRange = response.header("Content-Range")
          download.lastModified = response.header("Last-Modified")
          download.etag = response.header("ETag")
          download.lock.notifyAll()
        }

        try {
          val body = response.body
          if (body != null) {
            val source = body.source()
            val buffer = ByteArray(BUFFER_BYTES)
            while (true) {
              val read = source.read(buffer)
              if (read == -1) break
              if (read == 0) continue
              val chunk = ByteArray(read)
              receivedBytes += read
              System.arraycopy(buffer, 0, chunk, 0, read)
              synchronized(download.lock) {
                download.chunks.add(chunk)
                if (download.prefetch) {
                  download.cachedBytes += read.toLong()
                  playlists[download.pid]?.cacheBytes?.addAndGet(read.toLong())
                }
                download.lock.notifyAll()
              }
            }
          }
          synchronized(download.lock) {
            download.completed = true
            download.completedAt = System.currentTimeMillis()
            markDownloadFinishedLocked(download)
            download.lock.notifyAll()
          }
          logPrefetchEnd(download)
        } catch (error: Throwable) {
          debugLog("分片回源读取失败 pid=${download.pid} sid=${download.sid} error=${error.message} bytes=$receivedBytes 用时=${System.currentTimeMillis() - startedAt}ms")
          synchronized(download.lock) {
            download.failure = error.message ?: "read failed"
            download.completed = true
            download.completedAt = System.currentTimeMillis()
            markDownloadFinishedLocked(download)
            download.lock.notifyAll()
          }
          logPrefetchEnd(download)
        } finally {
          closeResponse(response)
        }
      }
    })
    return true
  }

  private fun buildHead(download: SharedDownload, chunked: Boolean, keepAlive: Boolean): String {
    val head = StringBuilder(256)
    val code = if (download.status == 0) 502 else download.status
    head.append("HTTP/1.1 ").append(code).append(' ').append(statusText(code)).append(CRLF)
    head.append("Content-Type: ").append(download.contentType ?: "application/octet-stream").append(CRLF)
    if (chunked) {
      head.append("Transfer-Encoding: chunked").append(CRLF)
    } else {
      head.append("Content-Length: ").append(download.contentLength).append(CRLF)
    }
    download.contentRange?.let { head.append("Content-Range: ").append(it).append(CRLF) }
    download.lastModified?.let { head.append("Last-Modified: ").append(it).append(CRLF) }
    download.etag?.let { head.append("ETag: ").append(it).append(CRLF) }
    head.append("Accept-Ranges: bytes").append(CRLF)
    head.append("Access-Control-Allow-Origin: *").append(CRLF)
    head.append("Connection: ").append(if (keepAlive) "keep-alive" else "close").append(CRLF)
    head.append(CRLF)
    return head.toString()
  }

  // ------------------------------------------------------------------ 预取与缓存

  private fun rememberPlaylist(pid: String, segments: List<String>) {
    val existing = playlists[pid]
    if (existing != null) {
      if (existing.segments != segments) {
        debugLog("清单标识冲突 pid=$pid")
        return
      }
      existing.lastActiveAt = System.currentTimeMillis()
      return
    }
    playlists.putIfAbsent(pid, PlaylistState(pid, segments))
    while (playlists.size > MAX_PLAYLISTS) {
      val oldest = playlists.values.minByOrNull { it.lastActiveAt } ?: break
      if (oldest.pid == pid) break
      releasePlaylist(oldest.pid)
    }
  }

  /** 所有清单的预取缓存总和，单位字节。 */
  private fun totalPrefetchCacheBytes(): Long =
    downloads.values.sumOf { if (it.prefetch) it.cachedBytes else 0L }

  /** 每次分片请求结束后，根据当前在途数补预取。 */
  private fun maybePrefetch(pid: String, currentSid: Int, headers: Map<String, String>) {
    val playlist = playlists[pid] ?: return
    if (totalPrefetchCacheBytes() >= MAX_CACHE_BYTES) return
    val inFlight = playlist.inFlightCount.get()
    if (inFlight >= PREFETCH_TRIGGER_INFLIGHT) return
    val toStart = minOf(MAX_PREFETCH_PER_TRIGGER, PREFETCH_TRIGGER_INFLIGHT - inFlight)
    if (toStart <= 0) return

    var sid = currentSid + 1
    var started = 0
    while (sid < playlist.segments.size && started < toStart) {
      val key = downloadKey(pid, sid)
      val existing = downloads[key]
      if (existing != null) {
        sid += 1
        continue
      }
      val download = downloads.computeIfAbsent(key) {
        SharedDownload(key, playlist.segments[sid], pid, sid, true, headers)
      }
      if (downloads[key] === download && startDownloadIfNeeded(download, headers)) {
        started += 1
      }
      sid += 1
    }
    if (started > 0) {
      debugLog(
        "预取发起 pid=$pid current=$currentSid 新增=$started " +
          "在途=${playlist.inFlightCount.get()} 缓存字节=${playlist.cacheBytes.get()}",
      )
    }
  }

  /** 定时清理过期清单和超过5分钟未消费的预取缓存。 */
  private fun cleanupExpired() {
    val now = System.currentTimeMillis()
    playlists.values.toList().forEach { playlist ->
      if (now - playlist.lastActiveAt > CACHE_TTL_MS) {
        releasePlaylist(playlist.pid)
      }
    }
    downloads.values.toList().forEach { download ->
      if (!download.prefetch || !download.completed) return@forEach
      if (now - download.completedAt < CACHE_TTL_MS) return@forEach
      releaseDownload(download.key, download, onlyIfIdle = true)
    }
    persistManifestRefsIfDirty()
    logStats()
  }

  /** 每分钟输出一次全局缓存统计，便于分析缓存随时间的变化。 */
  private fun logStats() {
    val playlistCount = playlists.size
    val cachedSegments = downloads.values.count { it.prefetch && it.cachedBytes > 0 }
    val cacheBytes = totalPrefetchCacheBytes()
    val inFlight = playlists.values.sumOf { it.inFlightCount.get() }
    debugLog(
      "[统计] 清单数=$playlistCount 清单映射=${manifestRefs.size} 缓存分片=$cachedSegments " +
        "缓存MB=${String.format(Locale.US, "%.1f", cacheBytes / 1024.0 / 1024.0)} " +
        "在途=$inFlight",
    )
  }

  private fun releasePlaylist(pid: String) {
    val playlist = playlists.remove(pid) ?: return
    downloads.values.toList().forEach { download ->
      if (download.pid == pid) releaseDownload(download.key, download)
    }
    debugLog("清单过期释放 pid=$pid 缓存字节=${playlist.cacheBytes.get()}")
  }

  /**
   * 销毁下载。默认保留仍有消费者的下载，等最后一个消费者退出；
   * force=true 用于代理停止，立即取消所有消费者和上游连接。
   */
  private fun releaseDownload(
    key: String,
    expected: SharedDownload? = null,
    force: Boolean = false,
    onlyIfIdle: Boolean = false,
  ) {
    val download = expected ?: downloads[key] ?: return
    val callToCancel: Call?
    synchronized(download.lock) {
      if (onlyIfIdle && download.consumers.isNotEmpty()) return
      if (!force && download.consumers.isNotEmpty()) {
        download.released = true
        return
      }
      downloads.remove(key, download)
      if (download.failure == null) download.failure = "released"
      releaseResourcesLocked(download)
      callToCancel = download.call
    }
    callToCancel?.cancel()
  }

  /** 必须在持有 download.lock 时调用。 */
  private fun releaseResourcesLocked(download: SharedDownload) {
    markDownloadFinishedLocked(download)
    if (download.prefetch && download.cachedBytes > 0) {
      playlists[download.pid]?.cacheBytes?.addAndGet(-download.cachedBytes)
      download.cachedBytes = 0
    }
    download.released = true
    download.completed = true
    download.chunks.clear()
    download.lock.notifyAll()
  }

  /** 必须在持有 download.lock 时调用。 */
  private fun markDownloadStartedLocked(download: SharedDownload) {
    if (download.inFlightCounted) return
    download.inFlightCounted = true
    playlists[download.pid]?.inFlightCount?.incrementAndGet()
  }

  /** 必须在持有 download.lock 时调用。 */
  private fun markDownloadFinishedLocked(download: SharedDownload) {
    if (!download.inFlightCounted) return
    download.inFlightCounted = false
    playlists[download.pid]?.inFlightCount?.decrementAndGet()
  }

  /** 消费者全部退出后，判断是否需要销毁这个下载。 */
  private fun shouldReleaseAfterConsumers(download: SharedDownload): Boolean {
    if (download.released) return true
    if (!download.prefetch) return true
    return download.completed && download.consumed
  }

  // ------------------------------------------------------------------ 请求头

  private fun forwardable(headers: Map<String, String>): Map<String, String> =
    headers.filterKeys { FORWARD_HEADER_KEYS.contains(it) }

  private fun resolveForwardHeaders(target: String, current: Map<String, String>): Map<String, String> {
    val originKey = try {
      val parsed = java.net.URI(target)
      "${parsed.scheme}://${parsed.host}${if (parsed.port > 0) ":${parsed.port}" else ""}"
    } catch (_: Throwable) {
      target
    }
    val byTarget = preferredHeadersByTarget[target]
    val byOrigin = preferredHeadersByOrigin[originKey]
    val preferred = HashMap<String, String>()
    byOrigin?.let { preferred.putAll(it) }
    byTarget?.let { preferred.putAll(it) }
    if (preferred.isNotEmpty()) {
      val merged = HashMap(current)
      merged.putAll(preferred)
      return merged
    }
    val picked = forwardable(current)
    if (picked.isNotEmpty()) {
      preferredHeadersByTarget[target] = picked
      preferredHeadersByOrigin[originKey] = picked
    }
    return current
  }

  private fun buildClient(): OkHttpClient {
    val base = OkHttpClientProvider.getOkHttpClient()
    val dispatcher = Dispatcher().apply {
      maxRequests = 64
      maxRequestsPerHost = 16
    }
    val eventListener = if (BuildConfig.DEBUG) {
      object : EventListener() {
        private val startedAt = ConcurrentHashMap<Call, Long>()
        private val connectionTags = ConcurrentHashMap<Call, String>()

        override fun callStart(call: Call) {
          startedAt[call] = System.currentTimeMillis()
        }

        override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
          debugLog(
            "[OKHTTP] 新建连接 url=${shortUrl(call.request().url.toString())} " +
              "remote=$inetSocketAddress proxy=$proxy",
          )
        }

        override fun connectEnd(
          call: Call,
          inetSocketAddress: InetSocketAddress,
          proxy: Proxy,
          protocol: Protocol?,
        ) {
          debugLog(
            "[OKHTTP] 连接建立 url=${shortUrl(call.request().url.toString())} " +
              "remote=$inetSocketAddress protocol=$protocol",
          )
        }

        override fun connectionAcquired(call: Call, connection: Connection) {
          val tag = "${System.identityHashCode(connection)}/${connection.protocol()}/${connection.route().socketAddress}"
          connectionTags[call] = tag
          debugLog("[OKHTTP] 获取连接 url=${shortUrl(call.request().url.toString())} conn=$tag")
        }

        override fun callEnd(call: Call) {
          val elapsed = startedAt.remove(call)?.let { System.currentTimeMillis() - it } ?: 0L
          val conn = connectionTags.remove(call) ?: "-"
          debugLog(
            "[OKHTTP] 请求结束 url=${shortUrl(call.request().url.toString())} " +
              "conn=$conn 用时=${elapsed}ms",
          )
        }

        override fun callFailed(call: Call, e: IOException) {
          val elapsed = startedAt.remove(call)?.let { System.currentTimeMillis() - it } ?: 0L
          val conn = connectionTags.remove(call) ?: "-"
          debugLog(
            "[OKHTTP] 请求失败 url=${shortUrl(call.request().url.toString())} " +
              "conn=$conn 用时=${elapsed}ms error=${e.message}",
          )
        }
      }
    } else null

    return base.newBuilder()
      .dispatcher(dispatcher)
      // 使用独立连接池，避免和 React Native 默认客户端的请求互相影响。
      .connectionPool(ConnectionPool(16, 5, TimeUnit.MINUTES))
      // 同一域名强制使用 HTTP/1.1 多连接，避免 HTTP/2 单连接多路复用被服务端流控拖慢。
      .protocols(listOf(Protocol.HTTP_1_1))
      .eventListener(eventListener ?: EventListener.NONE)
      .connectTimeout(DEFAULT_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .readTimeout(DEFAULT_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .writeTimeout(DEFAULT_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .callTimeout(0L, TimeUnit.MILLISECONDS)
      .build()
  }
}

class MediaProxyPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(MediaProxyModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
