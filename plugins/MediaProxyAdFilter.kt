package com.oriontv

import java.io.File
import java.math.BigInteger
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * M3U8 插播广告识别与清理（纯逻辑 + 可注入 IO，便于 JVM 单测）。
 *
 * 判定流程（27 个真实源实测验证过，清除率 100%、误删 0）：
 * 1. 按 #EXT-X-DISCONTINUITY 把清单切成块；块内时间轴实测连续，所以整块同性质；
 * 2. 每块只探第一个分片的前 8KB，从 PES 头读出该块起始时间码（广告从 0 重新开始）；
 * 3. 逐块比对：接不上"上一个保留块的结尾"就是广告，删整块；
 *    块首接近 0 且时间轴已走出 30 秒（片尾广告）也删；
 *    读不出的块一律保留（fail-open，宁可漏删不误删）。
 *
 * 删块时只删分片行（#EXTINF/URI），其它标签（KEY、DISCONTINUITY、ENDLIST…）原样保留，
 * 这样加密、多码率、初始化段等语义都不会被破坏。
 */
object MediaProxyAdFilter {

  /** 需要过滤广告的路径前缀；不带前缀的旧路径保持原样，不过滤。 */
  const val NOAD_PREFIX = "/_noad"

  /** 分片探针读取的字节数：够读到 PES 头里的 PTS 即可。 */
  const val PROBE_BYTES = 8192

  /** 单个探针请求超时；失败即放弃该块（保留）。 */
  const val PROBE_TIMEOUT_MS = 4000L

  /** 整个清单的探测总预算；超预算还没探到的块按"读不出"处理（保留）。 */
  const val PROBE_BUDGET_MS = 8000L

  /** 探针并发数；实测 322 块的最大清单约 5 秒探完。 */
  const val PROBE_CONCURRENCY = 8

  /** 时间轴允许的偏差。 */
  const val TOLERANCE_SEC = 1.0

  /** 单次最多删除的块数与时长（护栏 B）。 */
  const val MAX_RUN_BLOCKS = 6
  const val MAX_RUN_SEC = 120.0

  /** 块首时间码小于该值才算"从头开始"（广告特征）。 */
  const val HEAD_RESET_SEC = 5.0

  /** 时间轴走出该长度后才可能有插播广告。 */
  const val MIN_TIMELINE_SEC = 30.0

  /** 过滤结果缓存条数上限。 */
  const val CACHE_LIMIT = 500

  /** 上游读取；由本地代理用 okhttp 实现，单测用假实现。rangeBytes<=0 表示整段读取。 */
  interface Io {
    fun read(url: String, headers: Map<String, String>, rangeBytes: Int): ByteArray?
  }

  /** 生效的 #EXT-X-KEY。method=NONE 时解析为 null（未加密）。 */
  class Key(
    val text: String,
    val method: String,
    val uri: String?,
    val iv: String?,
  )

  /** 清单里的一个分片；lineStart/lineEnd 是它在清单文本里的行范围（含 #EXTINF 行）。 */
  class Segment(
    val url: String,
    val duration: Double,
    val lineStart: Int,
    val lineEnd: Int,
    val key: Key?,
    val index: Int,
  )

  /** 由 #EXT-X-DISCONTINUITY 切出来的块，覆盖分片下标区间 [segStart, segEnd)。 */
  class Block(val segStart: Int, val segEnd: Int)

  class Parsed(
    val lines: List<String>,
    val segments: List<Segment>,
    val blocks: List<Block>,
    val mediaSequence: Long,
  )

  /**
   * text: 过滤后的清单（没删块时就是原文）
   * removedBlocks: 本次删掉的块数（按实际分块数，不合并）
   * analyzed: 这次是不是真的做了探测（命中缓存为 false，只用于日志与测试）
   */
  class Result(val text: String, val removedBlocks: Int, val analyzed: Boolean)

  // ------------------------------------------------------------------ 对外入口

  /**
   * 过滤清单里的插播广告。只对分片清单有效，其它情况原样返回。
   * 删除结果按"清单内容指纹"永久缓存：一个清单只探一次，之后直接用缓存的下标重建结果；
   * 只有探测结果确定（探完并且要么删到了东西、要么全部块都读得出）才写缓存。
   */
  fun filter(
    text: String,
    playlistUrl: String,
    headers: Map<String, String>,
    io: Io,
    cache: RemovalCache? = null,
  ): Result {
    val normalized = normalize(text)
    if (!MediaProxyPlaylist.isHlsPlaylist(normalized) || !MediaProxyPlaylist.isLeafPlaylist(normalized)) {
      return Result(text, 0, false)
    }
    val parsed = parse(normalized, playlistUrl)
    // 只有一块时不存在"接不上"的插播广告，没必要探。
    if (parsed.blocks.size < 2) return Result(text, 0, false)

    val cacheKey = MediaProxyPlaylist.hashString(normalized)
    val cached = cache?.get(cacheKey)
    if (cached != null) {
      if (cached.isEmpty()) return Result(text, 0, false)
      return Result(applyRemovals(parsed, cached), cached.size, false)
    }

    val probes = probeBlocks(parsed, headers, io)
    val removed = decide(probes.pts.toList(), parsed.blocks.map { blockDuration(parsed, it) })
    // 结果不确定时不写缓存，免得把"没探到"当成永久结论：
    // 探测被预算截断，或者"什么都没删但又有块读不出时"，下次重探。
    val confident = !probes.truncated && (removed.isNotEmpty() || probes.pts.none { it == null })
    if (confident) cache?.put(cacheKey, removed)
    if (removed.isEmpty()) return Result(text, 0, true)
    return Result(applyRemovals(parsed, removed), removed.size, true)
  }

  // ------------------------------------------------------------------ 解析

  /** 按 #EXT-X-DISCONTINUITY 把清单切成块，并记录每个分片的行范围与生效密钥。 */
  fun parse(text: String, playlistUrl: String): Parsed {
    val lines = normalize(text).split("\n")
    val segments = ArrayList<Segment>()
    val blocks = ArrayList<Block>()
    var mediaSequence = 0L
    var key: Key? = null
    var pendingDuration: Double? = null
    var pendingStart = -1
    var blockStart = 0
    for (index in lines.indices) {
      val line = lines[index].trim()
      when {
        line.startsWith("#EXT-X-DISCONTINUITY") -> {
          if (segments.size > blockStart) {
            blocks.add(Block(blockStart, segments.size))
            blockStart = segments.size
          }
        }
        line.startsWith("#EXT-X-KEY:") -> key = parseKey(line, playlistUrl)
        line.startsWith("#EXT-X-MEDIA-SEQUENCE:") ->
          mediaSequence = line.substringAfter(':').trim().toLongOrNull() ?: 0L
        line.startsWith("#EXTINF:") -> {
          pendingDuration = line.substringAfter(':').substringBefore(',').trim().toDoubleOrNull()
          pendingStart = index
        }
        line.isNotEmpty() && !line.startsWith("#") -> {
          val url = MediaProxyPlaylist.resolveUrl(line, playlistUrl)
          if (url != null) {
            segments.add(
              Segment(
                url,
                pendingDuration ?: 0.0,
                if (pendingStart >= 0) pendingStart else index,
                index + 1,
                key,
                segments.size,
              ),
            )
          }
          pendingDuration = null
          pendingStart = -1
        }
      }
    }
    if (segments.size > blockStart) blocks.add(Block(blockStart, segments.size))
    return Parsed(lines, segments, blocks, mediaSequence)
  }

  private fun parseKey(line: String, playlistUrl: String): Key? {
    val method = Regex("METHOD=([^,]*)").find(line)?.groupValues?.get(1)?.trim().orEmpty()
    if (method.isEmpty() || method.equals("NONE", ignoreCase = true)) return null
    val uri = Regex("URI=\"([^\"]+)\"").find(line)?.groupValues?.get(1)
      ?.let { MediaProxyPlaylist.resolveUrl(it, playlistUrl) }
    val iv = Regex("IV=([^,]*)").find(line)?.groupValues?.get(1)?.trim()
    return Key(line, method, uri, iv)
  }

  private fun blockDuration(parsed: Parsed, block: Block): Double {
    var sum = 0.0
    for (index in block.segStart until block.segEnd) sum += parsed.segments[index].duration
    return sum
  }

  // ------------------------------------------------------------------ 判定

  /**
   * 逐块判定哪些块是广告。pts 为 null 表示该块读不出时间码。
   *
   * 护栏 A：判"接不上"之后先往后找恢复点，找不到不删；
   * 护栏 B：单次删除不超过 6 块 / 120 秒；
   * 护栏 C：片尾广告单独判据（块首<=5s、时间轴>30s、块数<=6、时长<=120s）；
   * 护栏 D：读不出的块让基准失效，由下一个可读块重建，避免陈旧基准连锁误删。
   */
  fun decide(pts: List<Double?>, durations: List<Double>): Set<Int> {
    val removed = LinkedHashSet<Int>()
    val count = pts.size
    if (count < 2 || durations.size != count) return removed

    val cumulative = DoubleArray(count)
    var elapsed = 0.0
    for (index in 0 until count) {
      cumulative[index] = elapsed
      elapsed += durations[index]
    }

    var expected: Double? = pts[0]?.plus(durations[0])
    var index = 1
    while (index < count) {
      val head = pts[index]
      if (head == null) {
        expected = null
        index += 1
        continue
      }
      val current = expected
      if (current == null) {
        expected = head + durations[index]
        index += 1
        continue
      }
      if (Math.abs(head - current) <= TOLERANCE_SEC) {
        expected = head + durations[index]
        index += 1
        continue
      }
      // 接不上：往后找第一块能接回基准的（护栏 A）
      var resume = index + 1
      while (resume < count) {
        val candidate = pts[resume]
        if (candidate != null && Math.abs(candidate - current) <= TOLERANCE_SEC) break
        resume += 1
      }
      if (resume < count) {
        var runSeconds = 0.0
        for (position in index until resume) runSeconds += durations[position]
        if (resume - index <= MAX_RUN_BLOCKS && runSeconds <= MAX_RUN_SEC) {
          for (position in index until resume) removed.add(position)
          expected = pts[resume]!! + durations[resume]
          index = resume + 1
          continue
        }
        // 超过护栏上限：不删，重新锚定继续扫
        expected = head + durations[index]
        index += 1
        continue
      }
      // 后面没有恢复点：只可能是片尾广告（护栏 C），否则不删
      var tailSeconds = 0.0
      for (position in index until count) tailSeconds += durations[position]
      if (head <= HEAD_RESET_SEC && cumulative[index] > MIN_TIMELINE_SEC &&
        count - index <= MAX_RUN_BLOCKS && tailSeconds <= MAX_RUN_SEC
      ) {
        for (position in index until count) removed.add(position)
      } else {
        expected = head + durations[index]
      }
      index = count
    }
    return removed
  }

  // ------------------------------------------------------------------ 生成结果

  /** 只删广告块的分片行；其它行（KEY/DISCONTINUITY/ENDLIST…）原样保留。 */
  fun applyRemovals(parsed: Parsed, removed: Set<Int>): String {
    if (removed.isEmpty()) return parsed.lines.joinToString("\n")
    val drop = BooleanArray(parsed.lines.size)
    for (blockIndex in removed) {
      val block = parsed.blocks.getOrNull(blockIndex) ?: continue
      for (segmentIndex in block.segStart until block.segEnd) {
        val segment = parsed.segments[segmentIndex]
        for (line in segment.lineStart until minOf(segment.lineEnd, drop.size)) drop[line] = true
      }
    }
    val segmentAtLine = HashMap<Int, Segment>(parsed.segments.size)
    for (segment in parsed.segments) segmentAtLine[segment.lineStart] = segment

    val out = ArrayList<String>(parsed.lines.size)
    var kept = 0
    for (line in parsed.lines.indices) {
      if (drop[line]) continue
      val segment = segmentAtLine[line]
      if (segment != null) {
        val key = segment.key
        // 删块会改变分片在清单里的序号，而播放器的默认 IV 就是"分片序号"：
        // 把原始序号显式写成 IV，过滤前后播放器的解密行为完全一致。
        if (key != null && key.iv == null && key.uri != null && needsIvPin(key) && segment.index != kept) {
          out.add(key.text.trimEnd() + ",IV=0x" + ivHex(parsed.mediaSequence + segment.index))
        }
        kept += 1
      }
      out.add(parsed.lines[line])
    }
    return out.joinToString("\n")
  }

  private fun needsIvPin(key: Key): Boolean =
    key.method.equals("AES-128", ignoreCase = true) || key.method.equals("SAMPLE-AES", ignoreCase = true)

  private fun ivHex(sequence: Long): String {
    val hex = sequence.toString(16)
    return "0".repeat(maxOf(0, 32 - hex.length)) + hex
  }

  // ------------------------------------------------------------------ 探针

  private class Probes(val pts: Array<Double?>, val truncated: Boolean)

  /**
   * 逐波探测每个块的第一个分片（每块一次，失败不重试）。
   * 第一波整波都读不出（源不支持 Range 或被拦）就直接放弃；总预算用完也放弃。
   */
  private fun probeBlocks(parsed: Parsed, headers: Map<String, String>, io: Io): Probes {
    val blocks = parsed.blocks
    val pts = arrayOfNulls<Double>(blocks.size)
    if (blocks.isEmpty()) return Probes(pts, false)
    val deadline = System.currentTimeMillis() + PROBE_BUDGET_MS
    val keyCache = ConcurrentHashMap<String, ByteArray>()
    val pool = Executors.newFixedThreadPool(Math.min(PROBE_CONCURRENCY, blocks.size))
    var truncated = false
    try {
      var start = 0
      while (start < blocks.size) {
        val end = minOf(start + PROBE_CONCURRENCY, blocks.size)
        val tasks = ArrayList<Future<*>>(end - start)
        for (position in start until end) {
          val block = blocks[position]
          tasks.add(pool.submit { pts[position] = probeBlock(parsed, block, headers, io, deadline, keyCache) })
        }
        for (task in tasks) {
          try {
            task.get()
          } catch (_: Throwable) {
          }
        }
        if (start == 0 && end < blocks.size && (start until end).none { pts[it] != null }) {
          truncated = true
          break
        }
        start = end
        if (start < blocks.size && System.currentTimeMillis() > deadline) {
          truncated = true
          break
        }
      }
    } catch (_: Throwable) {
      truncated = true
    } finally {
      pool.shutdownNow()
    }
    return Probes(pts, truncated)
  }

  private fun probeBlock(
    parsed: Parsed,
    block: Block,
    headers: Map<String, String>,
    io: Io,
    deadline: Long,
    keyCache: ConcurrentHashMap<String, ByteArray>,
  ): Double? {
    if (System.currentTimeMillis() > deadline) return null
    val segment = parsed.segments.getOrNull(block.segStart) ?: return null
    val head = io.read(segment.url, headers, PROBE_BYTES) ?: return null
    val key = segment.key
    val plain = if (key != null && key.method.equals("AES-128", ignoreCase = true)) {
      decryptAes128(head, segment, parsed.mediaSequence, headers, io, keyCache) ?: return null
    } else {
      // 未加密，或 SAMPLE-AES/DRM：TS 包与 PES 头是明文，直接扫
      head
    }
    return parsePts(plain)
  }

  private fun decryptAes128(
    head: ByteArray,
    segment: Segment,
    mediaSequence: Long,
    headers: Map<String, String>,
    io: Io,
    keyCache: ConcurrentHashMap<String, ByteArray>,
  ): ByteArray? {
    val uri = segment.key?.uri ?: return null
    var keyBytes = keyCache[uri]
    if (keyBytes == null) {
      keyBytes = io.read(uri, headers, 0) ?: return null
      if (keyBytes.size != 16) return null
      keyCache[uri] = keyBytes
    }
    val iv = segment.key?.iv?.let { hexToBytes(it) } ?: sequenceIv(mediaSequence + segment.index)
    return try {
      val cipher = Cipher.getInstance("AES/CBC/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), IvParameterSpec(iv))
      val length = head.size - (head.size % 16)
      if (length <= 0) null else cipher.doFinal(head, 0, length)
    } catch (_: Throwable) {
      null
    }
  }

  /** 与播放器一致：IV 属性为空时用分片媒体序号（128 位大端）。 */
  private fun sequenceIv(sequence: Long): ByteArray {
    val iv = ByteArray(16)
    var value = sequence
    for (index in 15 downTo 8) {
      iv[index] = (value and 0xff).toByte()
      value = value shr 8
    }
    return iv
  }

  private fun hexToBytes(iv: String): ByteArray? = try {
    val hex = iv.removePrefix("0x").removePrefix("0X").trim()
    val raw = BigInteger(hex, 16).toByteArray()
    val out = ByteArray(16)
    if (raw.size >= 16) {
      System.arraycopy(raw, raw.size - 16, out, 0, 16)
    } else {
      System.arraycopy(raw, 0, out, 16 - raw.size, raw.size)
    }
    out
  } catch (_: Throwable) {
    null
  }

  /** 从 TS 流里读出最小的 PTS（秒）；读不到返回 null。 */
  fun parsePts(data: ByteArray): Double? {
    var min: Double? = null
    var index = 0
    while (index + 188 < data.size) {
      if (data[index] == 0x47.toByte() && data[index + 188] == 0x47.toByte()) {
        val payloadStart = (data[index + 1].toInt() and 0x40) != 0
        val adaptation = (data[index + 3].toInt() shr 4) and 0x03
        val offset = 4 + if (adaptation == 2 || adaptation == 3) 1 + (data[index + 4].toInt() and 0xff) else 0
        if (payloadStart && offset + 14 <= 188 &&
          data[index + offset] == 0.toByte() &&
          data[index + offset + 1] == 0.toByte() &&
          data[index + offset + 2] == 1.toByte()
        ) {
          val streamId = data[index + offset + 3].toInt() and 0xff
          if (streamId in 0xe0..0xef && (data[index + offset + 7].toInt() and 0x80) != 0) {
            val base = index + offset + 9
            val pts = (((data[base].toInt() and 0x0e).toDouble() * 536870912.0) +
              ((data[base + 1].toInt() and 0xff) shl 22) +
              ((data[base + 2].toInt() and 0xfe) shl 14) +
              ((data[base + 3].toInt() and 0xff) shl 7) +
              ((data[base + 4].toInt() and 0xff) shr 1)) / 90000.0
            val current = min
            if (current == null || pts < current) min = pts
          }
        }
        index += 188
      } else {
        index += 1
      }
    }
    return min
  }

  private fun normalize(text: String): String = text.replace("\r\n", "\n").replace('\r', '\n')

  // ------------------------------------------------------------------ 缓存

  /**
   * 删除块下标的永久缓存（key = 清单内容指纹）。
   *
   * 只存"哪些块是广告"，命中时用本次拉到的清单重新生成结果，
   * 所以分片地址永远来自当前清单，不会出现陈旧地址。纯文本格式，便于 JVM 单测。
   */
  class RemovalCache(private val file: File, private val limit: Int = CACHE_LIMIT) {
    private class Entry(var at: Long, val blocks: Set<Int>)

    private val lock = Any()
    private val entries = HashMap<String, Entry>()
    private var loaded = false

    fun get(key: String): Set<Int>? = synchronized(lock) {
      loadLocked()
      val entry = entries[key]
      if (entry == null) {
        null
      } else {
        entry.at = System.currentTimeMillis()
        entry.blocks
      }
    }

    fun put(key: String, blocks: Set<Int>) {
      synchronized(lock) {
        loadLocked()
        entries[key] = Entry(System.currentTimeMillis(), blocks)
        evictLocked()
        persistLocked()
      }
    }

    fun size(): Int = synchronized(lock) {
      loadLocked()
      entries.size
    }

    private fun loadLocked() {
      if (loaded) return
      loaded = true
      try {
        if (!file.isFile) return
        file.readLines().forEach { line ->
          val parts = line.trim().split(' ')
          if (parts.size != 3) return@forEach
          val at = parts[0].toLongOrNull() ?: return@forEach
          val blocks = parts[2].split(',').mapNotNull { it.toIntOrNull() }.toSet()
          entries[parts[1]] = Entry(at, blocks)
        }
        evictLocked()
      } catch (_: Throwable) {
        entries.clear()
      }
    }

    private fun evictLocked() {
      if (entries.size <= limit) return
      entries.entries.sortedBy { it.value.at }
        .take(entries.size - limit)
        .forEach { entries.remove(it.key) }
    }

    private fun persistLocked() {
      try {
        file.parentFile?.mkdirs()
        val text = buildString {
          entries.forEach { (key, entry) ->
            append(entry.at).append(' ').append(key).append(' ')
            append(entry.blocks.sorted().joinToString(",")).append('\n')
          }
        }
        file.writeText(text)
      } catch (_: Throwable) {
      }
    }
  }
}
