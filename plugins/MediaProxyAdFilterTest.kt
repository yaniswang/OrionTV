package com.oriontv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 广告过滤的回归测试。
 *
 * 1. 27 个真实源的清单（tests/ad-filter/ad-dataset.tsv，由 ad-dataset.json 生成）
 *    跑判定逻辑：命中 60 段广告、误删 0、漏删 0，并逐个源比对删除下标；
 * 2. 解析/删行/加密/缓存/护栏的边界用例。
 */
class MediaProxyAdFilterTest {

  private val origin = "https://cdn.example.com/movie"

  // ------------------------------------------------------------------ 27 源回归

  private class FixtureBlock(val pts: Double?, val dur: Double, val label: String)
  private class FixtureSource(val name: String, val encrypted: Boolean, val blocks: List<FixtureBlock>)

  private fun loadFixture(): List<FixtureSource> {
    val stream = javaClass.classLoader!!.getResourceAsStream("ad-dataset.tsv")
      ?: error("缺少测试数据 ad-dataset.tsv")
    val sources = ArrayList<FixtureSource>()
    stream.bufferedReader().forEachLine { line ->
      if (line.isBlank() || line.startsWith("#")) return@forEachLine
      val parts = line.split('\t')
      val blocks = parts[2].split(';').map { raw ->
        val fields = raw.split(',')
        FixtureBlock(fields[0].toDoubleOrNull(), fields[1].toDouble(), fields[2])
      }
      sources.add(FixtureSource(parts[0], parts[1] == "1", blocks))
    }
    return sources
  }

  /** 27 源各自的删除下标（实测得出的固定值）。 */
  private val goldenRemoved = listOf(
    "22,73", "27,73", "21,60", "22,61", "28,73", "24,128", "1,3,5", "1,3,5", "1,3,5", "1,3,5",
    "1,3,5", "27,61", "5,24,46,68,72", "1,3,5", "1,3", "", "", "1,3", "1,3", "1,3", "38", "40",
    "46", "10,11,62,63,160,161,232,233", "8,9,60,61", "", "",
  )

  @Test
  fun realSourceRegressionKeepsClearRateAndNoFalsePositive() {
    val sources = loadFixture()
    assertEquals(27, sources.size)

    var removed = 0
    var truth = 0
    var hit = 0
    val falsePositive = ArrayList<String>()
    val falseNegative = ArrayList<String>()
    sources.forEachIndexed { index, source ->
      val result = MediaProxyAdFilter.decide(source.blocks.map { it.pts }, source.blocks.map { it.dur })
      assertEquals("源#$index ${source.name} 删除下标不一致", goldenRemoved[index], result.sorted().joinToString(","))
      removed += result.size
      source.blocks.forEachIndexed { blockIndex, block ->
        // 真值：标注为广告且时长不超过 60 秒（数据集把个别片尾大块误标成广告）
        val isAd = (block.label == "ad_bridged" || block.label == "ad_tail_break") && block.dur <= 60
        if (isAd) {
          truth += 1
          if (result.contains(blockIndex)) hit += 1 else falseNegative.add("${source.name}#$blockIndex")
        } else if (result.contains(blockIndex)) {
          falsePositive.add("${source.name}#$blockIndex(${block.label})")
        }
      }
    }
    assertEquals(60, truth)
    assertEquals(60, removed)
    assertEquals(60, hit)
    assertEquals(emptyList<String>(), falsePositive)
    assertEquals(emptyList<String>(), falseNegative)
  }

  // ------------------------------------------------------------------ 分块解析

  private fun playlist(vararg segments: String): String = listOf(
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-MEDIA-SEQUENCE:0",
    segments.joinToString("\n"),
    "#EXT-X-ENDLIST",
    "",
  ).joinToString("\n")

  @Test
  fun parseSplitsBlocksAtDiscontinuityAndKeepsLineRanges() {
    val text = playlist(
      "#EXTINF:4.0,",
      "s0.ts",
      "#EXTINF:4.0,",
      "s1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "#EXTINF:6.0,",
      "s2.ts",
    )

    val parsed = MediaProxyAdFilter.parse(text, "$origin/index.m3u8")

    assertEquals(2, parsed.blocks.size)
    assertEquals(0, parsed.blocks[0].segStart)
    assertEquals(2, parsed.blocks[0].segEnd)
    assertEquals(2, parsed.blocks[1].segStart)
    assertEquals(3, parsed.blocks[1].segEnd)
    assertEquals(3, parsed.segments.size)
    assertEquals(6.0, parsed.segments[2].duration, 0.0001)
    assertEquals("$origin/s2.ts", parsed.segments[2].url)
    assertNull("第一块没有 KEY", parsed.segments[0].key)
    assertNull("第一块没有 KEY", parsed.segments[1].key)
    assertEquals("key.bin", parsed.segments[2].key?.uri?.substringAfterLast('/'))
    assertEquals("AES-128", parsed.segments[2].key?.method)
    // KEY 行在块的第一个分片之前，删除分片行时不会被碰到
    assertTrue(parsed.lines[9].startsWith("#EXT-X-KEY:"))
    assertEquals(10, parsed.segments[2].lineStart)
    assertEquals("行范围含 #EXTINF 与地址行", 12, parsed.segments[2].lineEnd)
  }

  // ------------------------------------------------------------------ 删行

  @Test
  fun applyRemovalsDropsOnlySegmentLines() {
    val text = playlist(
      "#EXTINF:4.0,",
      "s0.ts",
      "#EXTINF:4.0,",
      "s1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "ad0.ts",
      "#EXTINF:4.0,",
      "ad1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "s2.ts",
    )
    val parsed = MediaProxyAdFilter.parse(text, "$origin/index.m3u8")

    val filtered = MediaProxyAdFilter.applyRemovals(parsed, setOf(1))

    assertFalse(filtered.contains("ad0.ts"))
    assertFalse(filtered.contains("ad1.ts"))
    assertTrue(filtered.contains("s0.ts"))
    assertTrue(filtered.contains("s2.ts"))
    assertTrue(filtered.contains("#EXT-X-ENDLIST"))
    // DISCONTINUITY 行原样保留：删块后时间轴仍有跳变，标记反而更准确
    assertEquals(2, filtered.split("\n").count { it == "#EXT-X-DISCONTINUITY" })
    assertEquals(3, filtered.split("\n").count { it.startsWith("#EXTINF:") })
  }

  @Test
  fun applyRemovalsKeepsKeyLineOfRemovedBlock() {
    val text = playlist(
      "#EXT-X-KEY:METHOD=AES-128,URI=\"movie.bin\"",
      "#EXTINF:4.0,",
      "s0.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"ad.bin\"",
      "#EXTINF:4.0,",
      "ad0.ts",
      "#EXTINF:4.0,",
      "ad1.ts",
    )
    val parsed = MediaProxyAdFilter.parse(text, "$origin/index.m3u8")

    val filtered = MediaProxyAdFilter.applyRemovals(parsed, setOf(1))

    // 广告块的 KEY 行保留：后面的分片如果依赖它，解密语义不会被破坏
    assertTrue(filtered.contains("ad.bin"))
    assertFalse(filtered.contains("ad0.ts"))
  }

  @Test
  fun applyRemovalsPinsIvOnlyWhenSequenceShifted() {
    val text = playlist(
      "#EXT-X-KEY:METHOD=AES-128,URI=\"movie.bin\"",
      "#EXTINF:4.0,",
      "s0.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "ad0.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "s1.ts",
    )
    val parsed = MediaProxyAdFilter.parse(text, "$origin/index.m3u8")

    val filtered = MediaProxyAdFilter.applyRemovals(parsed, setOf(1))
    val lines = filtered.split("\n")

    // s0 序号没变，不需要补 IV；s1 从 2 变成 1，必须把原始序号写成显式 IV
    val keyLines = lines.filter { it.startsWith("#EXT-X-KEY:") }
    assertEquals(2, keyLines.size)
    assertEquals(
      "#EXT-X-KEY:METHOD=AES-128,URI=\"movie.bin\",IV=0x" + "0".repeat(31) + "2",
      keyLines[1],
    )
  }

  @Test
  fun applyRemovalsLeavesExplicitIvAlone() {
    val key = "#EXT-X-KEY:METHOD=AES-128,URI=\"movie.bin\",IV=0x00000000000000000000000000000001"
    val text = playlist(
      key,
      "#EXTINF:4.0,",
      "s0.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "ad0.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "s1.ts",
    )
    val filtered = MediaProxyAdFilter.applyRemovals(
      MediaProxyAdFilter.parse(text, "$origin/index.m3u8"),
      setOf(1),
    )

    assertEquals(1, filtered.split("\n").count { it.startsWith("#EXT-X-KEY:") })
    assertTrue(filtered.contains(key))
  }

  // ------------------------------------------------------------------ 判定护栏

  @Test
  fun decideDeletesRunThatBridgesBackToTimeline() {
    // 块 0：[100,104)，块 1 广告从 0 重新开始，块 2 接回 108
    val pts = listOf(100.0, 0.0, 108.0)
    val durations = listOf(8.0, 8.0, 8.0)

    assertEquals(setOf(1), MediaProxyAdFilter.decide(pts, durations))
  }

  @Test
  fun decideKeepsBlocksWithoutResumePoint() {
    // 块 1 接不上，后面也没有块接回基准 → 不删（宁漏不误）
    val pts = listOf(100.0, 0.0, 30.0)
    val durations = listOf(8.0, 8.0, 8.0)

    assertEquals(emptySet<Int>(), MediaProxyAdFilter.decide(pts, durations))
  }

  @Test
  fun decideKeepsRunOverGuardLimits() {
    // 恢复点在 7 块之后，超过单次 6 块上限 → 不删
    val longRun = listOf(100.0) + List(7) { -500.0 } + listOf(104.0)
    assertEquals(
      emptySet<Int>(),
      MediaProxyAdFilter.decide(longRun, List(9) { 4.0 }),
    )
    // 单块 200 秒，超过单次 120 秒上限 → 不删
    assertEquals(
      emptySet<Int>(),
      MediaProxyAdFilter.decide(listOf(100.0, 0.0, 104.0), listOf(4.0, 200.0, 4.0)),
    )
  }

  @Test
  fun decideDeletesTailAdOnlyWhenItLooksLikeAd() {
    // 时间轴已走出 30 秒、块首接近 0 → 片尾广告
    assertEquals(setOf(1), MediaProxyAdFilter.decide(listOf(100.0, 0.0), listOf(40.0, 4.0)))
    // 块首不像广告（接不上但也不是从头开始）→ 保留
    assertEquals(emptySet<Int>(), MediaProxyAdFilter.decide(listOf(100.0, 46.0), listOf(40.0, 4.0)))
    // 时间轴还没走出 30 秒 → 保留
    assertEquals(emptySet<Int>(), MediaProxyAdFilter.decide(listOf(4.0, 3.0), listOf(4.0, 4.0)))
    // 片尾块数超过上限 → 保留
    assertEquals(
      emptySet<Int>(),
      MediaProxyAdFilter.decide(listOf(100.0) + List(7) { 0.0 }, listOf(40.0) + List(7) { 4.0 }),
    )
  }

  @Test
  fun decideReanchorsAfterUnreadableBlock() {
    // 块 1 读不出 → 基准失效；块 2 重建基准，不能被当成广告
    val pts = listOf(100.0, null, 30.0, 34.0)
    val durations = listOf(4.0, 4.0, 4.0, 4.0)

    assertEquals(emptySet<Int>(), MediaProxyAdFilter.decide(pts, durations))
  }

  // ------------------------------------------------------------------ PES 解析

  /** 造一个只带 PTS 的视频 TS 包。 */
  private fun tsPacket(ptsSeconds: Double): ByteArray {
    val packet = ByteArray(188)
    val ticks = Math.round(ptsSeconds * 90000.0)
    packet[0] = 0x47
    packet[1] = 0x40
    packet[2] = 0x00
    packet[3] = 0x10
    packet[4] = 0x00
    packet[5] = 0x00
    packet[6] = 0x01
    packet[7] = 0xE0.toByte()
    packet[8] = 0x00
    packet[9] = 0x00
    packet[10] = 0x80.toByte()
    packet[11] = 0x80.toByte()
    packet[12] = 0x05
    packet[13] = (((ticks shr 29) and 0x0E) or 0x20).toByte()
    packet[14] = ((ticks shr 22) and 0xFF).toByte()
    packet[15] = ((((ticks shr 14) and 0xFE) or 0x01)).toByte()
    packet[16] = ((ticks shr 7) and 0xFF).toByte()
    packet[17] = ((((ticks shl 1) and 0xFE) or 0x01)).toByte()
    return packet
  }

  /** 至少两个包才能被扫到（解析逻辑要求能确认包边界）。 */
  private fun tsStream(ptsSeconds: Double): ByteArray = tsPacket(ptsSeconds) + tsPacket(ptsSeconds)

  @Test
  fun parsePtsReadsTimestampFromPesHeader() {
    assertEquals(100.0, MediaProxyAdFilter.parsePts(tsStream(100.0))!!, 0.001)
    assertEquals(0.0, MediaProxyAdFilter.parsePts(tsStream(0.0))!!, 0.001)
    assertEquals(1234.5, MediaProxyAdFilter.parsePts(tsStream(1234.5))!!, 0.001)
    assertNull(MediaProxyAdFilter.parsePts(ByteArray(64)))
  }

  // ------------------------------------------------------------------ 过滤入口

  private class FakeIo(
    private val bodies: Map<String, ByteArray>,
  ) : MediaProxyAdFilter.Io {
    private val counts = ConcurrentHashMap<String, AtomicInteger>()

    override fun read(url: String, headers: Map<String, String>, rangeBytes: Int): ByteArray? {
      counts.computeIfAbsent(url) { AtomicInteger() }.incrementAndGet()
      return bodies[url]
    }

    fun reads(): Map<String, Int> = counts.entries.associate { it.key to it.value.get() }
  }

  private fun segment(name: String): String = "$origin/$name"

  private fun adPlaylist(): String = playlist(
    "#EXTINF:4.0,",
    "movie0.ts",
    "#EXTINF:4.0,",
    "movie1.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:4.0,",
    "ad0.ts",
    "#EXTINF:4.0,",
    "ad1.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:4.0,",
    "movie2.ts",
  )

  private fun adBodies(): MutableMap<String, ByteArray> = linkedMapOf(
    segment("movie0.ts") to tsStream(100.0),
    segment("movie1.ts") to tsStream(104.0),
    segment("ad0.ts") to tsStream(0.0),
    segment("ad1.ts") to tsStream(4.0),
    segment("movie2.ts") to tsStream(108.0),
  )

  @Test
  fun filterProbesOneSegmentPerBlockAndCachesResult() {
    val io = FakeIo(adBodies())
    val cache = MediaProxyAdFilter.RemovalCache(File(createTempDir(), "ad-cache.txt"))

    val first = MediaProxyAdFilter.filter(adPlaylist(), "$origin/index.m3u8", emptyMap(), io, cache)

    assertEquals(1, first.removedBlocks)
    assertTrue(first.analyzed)
    assertFalse(first.text.contains("ad0.ts"))
    assertFalse(first.text.contains("ad1.ts"))
    assertEquals(3, io.reads().size)
    assertEquals("缓存按清单内容记账，一个清单一条", 1, cache.size())
    val firstReads = io.reads()

    val second = MediaProxyAdFilter.filter(adPlaylist(), "$origin/index.m3u8", emptyMap(), io, cache)

    assertEquals(first.text, second.text)
    assertEquals(1, second.removedBlocks)
    assertFalse("命中缓存不应重复探测", second.analyzed)
    assertEquals("命中缓存不应重复探测", firstReads, io.reads())
  }

  @Test
  fun filterFailsOpenWhenProbeFailsAndDoesNotCache() {
    val io = FakeIo(linkedMapOf(segment("movie0.ts") to tsStream(100.0)))
    val cache = MediaProxyAdFilter.RemovalCache(File(createTempDir(), "ad-cache.txt"))
    val text = adPlaylist()

    val result = MediaProxyAdFilter.filter(text, "$origin/index.m3u8", emptyMap(), io, cache)

    assertEquals(0, result.removedBlocks)
    assertEquals(text, result.text)
    assertEquals(0, cache.size())
  }

  @Test
  fun filterSkipsPlaylistWithoutDiscontinuity() {
    val io = FakeIo(adBodies())
    val text = playlist("#EXTINF:4.0,", "movie0.ts", "#EXTINF:4.0,", "movie1.ts")

    val result = MediaProxyAdFilter.filter(text, "$origin/index.m3u8", emptyMap(), io, null)

    assertEquals(0, result.removedBlocks)
    assertFalse(result.analyzed)
    assertEquals(0, io.reads().size)
  }

  @Test
  fun filterDecryptsAes128SegmentWithImplicitIv() {
    val key = ByteArray(16) { (it + 1).toByte() }
    val playlistText = playlist(
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "#EXTINF:4.0,",
      "movie0.ts",
      "#EXTINF:4.0,",
      "movie1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "ad0.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "movie2.ts",
    )
    // 播放器规则：IV=空时用"分片序号"（大端 16 字节）
    fun ivFor(index: Int): ByteArray {
      val iv = ByteArray(16)
      iv[15] = index.toByte()
      return iv
    }
    fun encrypt(pts: Double, index: Int): ByteArray {
      val cipher = Cipher.getInstance("AES/CBC/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(ivFor(index)))
      val plain = tsStream(pts)
      return cipher.doFinal(plain, 0, plain.size - (plain.size % 16))
    }
    val bodies = linkedMapOf(
      segment("movie0.ts") to encrypt(100.0, 0),
      segment("movie1.ts") to encrypt(104.0, 1),
      segment("ad0.ts") to encrypt(0.0, 2),
      segment("movie2.ts") to encrypt(108.0, 3),
      segment("key.bin") to key,
    )
    val io = FakeIo(bodies)

    val result = MediaProxyAdFilter.filter(playlistText, "$origin/index.m3u8", emptyMap(), io, null)

    assertEquals(1, result.removedBlocks)
    assertFalse(result.text.contains("ad0.ts"))
    assertTrue(result.text.contains("movie2.ts"))
    // 序号从 3 变成 2，必须写显式 IV 保住解密
    assertTrue(result.text.contains("IV=0x" + "0".repeat(31) + "3"))
    // 并发探针可能重复取同一个密钥，但不会多到每块一次
    assertTrue(io.reads()[segment("key.bin")]!! <= 3)
  }

  // ------------------------------------------------------------------ 缓存

  @Test
  fun filteredPlaylistRewritesIntoProxyUrlsWithCompactSegmentIds() {
    val source = "$origin/index.m3u8"
    val proxyBase = "http://192.168.1.5:18923" + MediaProxyAdFilter.NOAD_PREFIX

    val result = MediaProxyAdFilter.filter(adPlaylist(), source, emptyMap(), FakeIo(adBodies()), null)
    val leaf = MediaProxyPlaylist.rewriteLeafPlaylist(result.text, proxyBase, source)

    // 删掉的两个广告分片不再登记，剩下 4 个分片按顺序重新编号
    assertEquals(
      listOf(segment("movie0.ts"), segment("movie1.ts"), segment("movie2.ts")),
      leaf.segments,
    )
    assertTrue(leaf.text.contains("$proxyBase/${leaf.pid}/0/seg.ts"))
    assertTrue(leaf.text.contains("$proxyBase/${leaf.pid}/2/seg.ts"))
    assertFalse(leaf.text.contains("ad0.ts"))
    // pid 由过滤后的清单内容决定，登记表里的分片和地址一一对应
    assertEquals(MediaProxyPlaylist.hashString("$source\u0000${result.text}"), leaf.pid)
  }

  @Test
  fun removalCacheEvictsOldestAndReloadsFromFile() {
    val file = File(createTempDir(), "ad-cache.txt")
    val cache = MediaProxyAdFilter.RemovalCache(file, limit = 2)
    cache.put("a", setOf(1))
    cache.put("b", setOf(2))
    cache.put("c", setOf(3))

    assertEquals(2, cache.size())
    assertNull("最旧的条目被淘汰", cache.get("a"))
    assertEquals(setOf(3), cache.get("c"))

    val reloaded = MediaProxyAdFilter.RemovalCache(file)
    assertEquals(setOf(3), reloaded.get("c"))
  }

  private fun createTempDir(): File =
    Files.createTempDirectory("ad-filter-test").toFile().apply { deleteOnExit() }
}
