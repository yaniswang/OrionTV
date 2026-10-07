package com.oriontv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生清单改写的回归测试。
 *
 * 固定回归值和边界用例，防止原生清单改写行为被意外改变。
 */
class MediaProxyPlaylistTest {

  private val origin = "http://192.168.1.5:18923"
  private val source = "https://cdn.example.com/live/720/index.m3u8"

  @Test
  fun buildProxyUrlMatchesExpected() {
    assertEquals(
      "$origin/https%3A%2F%2Fcdn.example.com%2Flive%2F720%2Findex.m3u8/_hls.m3u8",
      MediaProxyPlaylist.buildProxyUrl(origin, source),
    )
    assertEquals(
      "$origin/https%3A%2F%2Fcdn.example.com%2Flive%2F720%2Findex.m3u8%3Ftoken%3D1%26x%3D2/_hls.m3u8",
      MediaProxyPlaylist.buildProxyUrl(origin, "https://cdn.example.com/live/720/index.m3u8?token=1&x=2"),
    )
    assertEquals(
      "$origin/abc/0/seg.ts",
      MediaProxyPlaylist.buildSegmentProxyUrl(origin, "abc", 0, "https://cdn.example.com/live/720/seg1.ts?token=1&x=2"),
    )
    assertEquals(
      "$origin/abc/1/seg.m4s",
      MediaProxyPlaylist.buildSegmentProxyUrl(origin, "abc", 1, "https://cdn.example.com/live/720/seg2.m4s?token=1"),
    )
  }

  @Test
  fun proxyTargetEncodingRoundTrips() {
    val target = "https://mp.yaniswang.cn/https://cdn.example.com/a b/%2F.ts?token=a+b&x=%26"
    val encoded = MediaProxyPlaylist.encodeProxyTarget(target)

    assertTrue(!encoded.contains("://"))
    assertTrue(!encoded.contains("?"))
    assertEquals(target, MediaProxyPlaylist.decodeProxyTarget(encoded))
  }

  @Test
  fun unwrapProxyUrlMatchesExpected() {
    assertEquals(source, MediaProxyPlaylist.unwrapProxyUrl(MediaProxyPlaylist.buildProxyUrl(origin, source), origin))
    assertEquals(source, MediaProxyPlaylist.unwrapProxyUrl(source, origin))

    val externalProxy = "https://mp.yaniswang.cn/https://cdn.example.com/live/720/index.m3u8?token=1&x=2"
    val localProxy = MediaProxyPlaylist.buildProxyUrl(origin, externalProxy)
    assertEquals(externalProxy, MediaProxyPlaylist.unwrapProxyUrl(localProxy, origin))
    assertEquals(externalProxy, MediaProxyPlaylist.unwrapProxyUrl(externalProxy, origin))
  }

  @Test
  fun hashIsStableAndCollisionResistant() {
    val first = MediaProxyPlaylist.hashString(source)
    assertEquals(first, MediaProxyPlaylist.hashString(source))
    assertEquals(64, first.length)
    assertTrue(Regex("^[a-f0-9]{64}$").matches(first))
    assertNotEquals(first, MediaProxyPlaylist.hashString(source + "\nother"))
  }

  @Test
  fun rewriteLeafPlaylistMatchesExpected() {
    val leaf = listOf(
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "#EXTINF:6.0,",
      "seg1.ts",
      "#EXTINF:6.0,",
      "../shared/seg2.ts",
      "#EXTINF:6.0,",
      "/abs/seg3.ts",
      "",
    ).joinToString("\n")

    val result = MediaProxyPlaylist.rewriteLeafPlaylist(leaf, origin, source)

    assertEquals(MediaProxyPlaylist.hashString("$source\u0000$leaf"), result.pid)
    assertEquals(
      listOf(
        "https://cdn.example.com/live/720/seg1.ts",
        "https://cdn.example.com/live/shared/seg2.ts",
        "https://cdn.example.com/abs/seg3.ts",
      ),
      result.segments,
    )
    val expected = listOf(
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"${MediaProxyPlaylist.buildProxyUrl(origin, "https://cdn.example.com/live/720/key.bin")}\"",
      "#EXTINF:6.0,",
      "$origin/${result.pid}/0/seg.ts",
      "#EXTINF:6.0,",
      "$origin/${result.pid}/1/seg.ts",
      "#EXTINF:6.0,",
      "$origin/${result.pid}/2/seg.ts",
      "",
    ).joinToString("\n")
    assertEquals(expected, result.text)
  }

  @Test
  fun sameSourceDifferentLeafContentGetsDifferentPid() {
    val first = MediaProxyPlaylist.rewriteLeafPlaylist("#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n", origin, source)
    val second = MediaProxyPlaylist.rewriteLeafPlaylist("#EXTM3U\n#EXTINF:6.0,\nseg2.ts\n", origin, source)
    assertNotEquals(first.pid, second.pid)
  }

  @Test
  fun rewriteChildPlaylistMatchesExpected() {
    val master = listOf(
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000",
      "720/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=400000",
      "https://cdn.example.com/live/360/index.m3u8",
      "",
    ).joinToString("\n")

    val expected = listOf(
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000",
      MediaProxyPlaylist.buildProxyUrl(origin, "https://cdn.example.com/live/720/720/index.m3u8"),
      "#EXT-X-STREAM-INF:BANDWIDTH=400000",
      MediaProxyPlaylist.buildProxyUrl(origin, "https://cdn.example.com/live/360/index.m3u8"),
      "",
    ).joinToString("\n")
    assertEquals(expected, MediaProxyPlaylist.rewriteChildPlaylist(master, origin, source))
  }

  @Test
  fun isLeafAndHlsDetectionMatchesExpected() {
    assertEquals(true, MediaProxyPlaylist.isHlsPlaylist("  \n#EXTM3U\n#EXTINF:6.0,"))
    assertEquals(false, MediaProxyPlaylist.isHlsPlaylist("<html>"))
    assertEquals(true, MediaProxyPlaylist.isLeafPlaylist("#EXTM3U\n#EXTINF:6.0,"))
    assertEquals(false, MediaProxyPlaylist.isLeafPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1"))
  }
}