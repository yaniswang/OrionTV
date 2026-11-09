package com.oriontv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class MediaProxyTimeshiftTest {

  private val template = "https://s/u/608807420?playbackbegin=\${(b)yyyyMMddHHmmss}&playbackend=\${(e)yyyyMMddHHmmss}"

  /** 北京时间 → UTC 毫秒 */
  private fun bj(d: Int, h: Int, mi: Int, s: Int = 0): Long =
    java.util.GregorianCalendar(java.util.TimeZone.getTimeZone("UTC")).apply {
      clear()
      set(2026, 10, d, h - 8, mi, s)
    }.timeInMillis

  @Test
  fun formatTemplateUsesGivenTimezone() {
    assertEquals(
      "https://s/u/608807420?playbackbegin=20261109235100&playbackend=20261110003300",
      MediaProxyTimeshift.formatTemplate(template, bj(9, 23, 51), bj(10, 0, 33), 480),
    )
    assertEquals(
      "https://s/u/608807420?playbackbegin=20261109155100&playbackend=20261109163300",
      MediaProxyTimeshift.formatTemplate(template, bj(9, 23, 51), bj(10, 0, 33), 0),
    )
  }

  @Test
  fun buildAndParsePath() {
    assertEquals("/_ts/abc123/_hls.m3u8", MediaProxyTimeshift.buildPath("abc123"))
    assertEquals("abc123", MediaProxyTimeshift.parsePath("/_ts/abc123/_hls.m3u8"))
    assertNull(MediaProxyTimeshift.parsePath("/_live/abc/x"))
    assertNull(MediaProxyTimeshift.parsePath("/_ts/"))
  }

  @Test
  fun firstVariantResolvesRelativeToFinalUrl() {
    val master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2084544\n01.m3u8?a=1&b=2\n"
    assertEquals("http://cdn/migu/01.m3u8?a=1&b=2", MediaProxyTimeshift.firstVariant(master, "http://cdn/migu/index.m3u8?k=1"))
    assertNull(MediaProxyTimeshift.firstVariant("#EXTM3U\n#EXTINF:6,\na.ts\n", "http://cdn/x.m3u8"))
  }

  @Test
  fun parseMediaKeepsSegmentTagsAndResolvesUris() {
    val text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n" +
      "#EXTINF:6.000,\nseg100.ts?t=1\n#EXT-X-DISCONTINUITY\n#EXTINF:5.5,\nhttp://other/seg101.ts\n#EXT-X-ENDLIST\n"
    val segs = MediaProxyTimeshift.parseMedia(text, "http://cdn/live/index.m3u8?k=1")
    assertEquals(2, segs.size)
    assertEquals("http://cdn/live/seg100.ts?t=1", segs[0].uri)
    assertEquals("http://cdn/live/seg100.ts", segs[0].key)
    assertEquals(6.0, segs[0].duration, 0.001)
    assertEquals(emptyList<String>(), segs[0].tags)
    assertEquals(listOf("#EXT-X-DISCONTINUITY"), segs[1].tags)
    assertEquals(5.5, segs[1].duration, 0.001)
  }

  private fun seg(n: Int, query: String = "") = MediaProxyTimeshift.Segment("http://c/s$n.ts", "http://c/s$n.ts$query", 6.0, emptyList())

  @Test
  fun mergeAppendsOnlySegmentsAfterLastKnown() {
    val existing = listOf(seg(1), seg(2), seg(3))
    // 重叠请求：新列表从 s2 开始，且查询参数变了（同一分片）
    val incoming = listOf(seg(2, "?x=9"), seg(3, "?x=9"), seg(4, "?x=9"), seg(5, "?x=9"))
    val merged = MediaProxyTimeshift.merge(existing, incoming)
    assertEquals(listOf("http://c/s1.ts", "http://c/s2.ts", "http://c/s3.ts", "http://c/s4.ts?x=9", "http://c/s5.ts?x=9"), merged.map { it.uri })
  }

  @Test
  fun mergeFirstFetchTakesAll() {
    assertEquals(3, MediaProxyTimeshift.merge(emptyList(), listOf(seg(1), seg(2), seg(3))).size)
  }

  @Test
  fun mergeWithGapMarksDiscontinuity() {
    val merged = MediaProxyTimeshift.merge(listOf(seg(1), seg(2)), listOf(seg(7), seg(8)))
    assertEquals(4, merged.size)
    assertEquals(listOf("#EXT-X-DISCONTINUITY"), merged[2].tags)
  }

  @Test
  fun mergeWithNothingNewKeepsExisting() {
    val existing = listOf(seg(1), seg(2))
    assertEquals(existing, MediaProxyTimeshift.merge(existing, listOf(seg(1), seg(2))))
  }

  @Test
  fun renderIsGrowingEventPlaylistStartingAtBeginning() {
    val text = MediaProxyTimeshift.render(listOf(seg(1), seg(2).copy(duration = 5.2, tags = listOf("#EXT-X-DISCONTINUITY"))))
    val lines = text.trim().split("\n")
    assertEquals("#EXTM3U", lines[0])
    assertTrue(lines.contains("#EXT-X-PLAYLIST-TYPE:EVENT"))
    assertTrue(lines.contains("#EXT-X-TARGETDURATION:6"))
    assertTrue(lines.contains("#EXT-X-MEDIA-SEQUENCE:0"))
    assertTrue(lines.contains("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"))
    assertFalse(text.contains("#EXT-X-ENDLIST"))
    val tail = lines.takeLast(5)
    assertEquals(listOf("#EXTINF:6.000,", "http://c/s1.ts", "#EXT-X-DISCONTINUITY", "#EXTINF:5.200,", "http://c/s2.ts"), tail)
  }

  @Test
  fun nextRequestBeginOverlapsCoveredRange() {
    val begin = bj(9, 20, 0)
    // 还没拿到内容：从起点请求
    assertEquals(begin, MediaProxyTimeshift.nextRequestBegin(begin, emptyList()))
    // 已拿到 3×6 秒：从末尾往前两个片段重叠请求
    assertEquals(begin + 18_000 - 12_000, MediaProxyTimeshift.nextRequestBegin(begin, listOf(seg(1), seg(2), seg(3))))
  }
}
