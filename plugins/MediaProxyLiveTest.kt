package com.oriontv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaProxyLiveTest {

  private val origin = "http://192.168.1.5:18923"
  private val key = MediaProxyLive.userAgentKey("okhttp/3.15")

  @Test
  fun buildAndParseRoundTrips() {
    val target = "https://cdn.example.com/live/index.m3u8?token=a&b=1"
    val url = MediaProxyLive.buildUrl(origin, key, target)
    assertEquals(
      "$origin/_live/$key/https%3A%2F%2Fcdn.example.com%2Flive%2Findex.m3u8%3Ftoken%3Da%26b%3D1/_hls.m3u8",
      url,
    )
    assertEquals(key to target, MediaProxyLive.parsePath(url.removePrefix(origin)))

    val segment = "http://cdn.example.com/live/1.ts"
    assertEquals(key to segment, MediaProxyLive.parsePath(MediaProxyLive.buildUrl(origin, key, segment).removePrefix(origin)))
  }

  @Test
  fun parseIgnoresExistingRoutes() {
    assertNull(MediaProxyLive.parsePath("/abc123/0/seg.ts"))
    assertNull(MediaProxyLive.parsePath("/" + MediaProxyPlaylist.encodeProxyTarget("https://a.com/x.m3u8")))
    assertNull(MediaProxyLive.parsePath("/_live/$key"))
  }

  @Test
  fun userAgentKeyIsStable() {
    assertEquals(MediaProxyLive.userAgentKey("UA"), MediaProxyLive.userAgentKey("UA"))
    assertEquals(16, key.length)
  }

  @Test
  fun rewritesOnlyAddresses() {
    val source = "https://cdn.example.com/live/index.m3u8"
    val text = listOf(
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:100",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "#EXTINF:6.0,",
      "100.ts",
      "#EXTINF:6.0,",
      "https://other.example.com/101.ts?x=1",
      "",
    ).joinToString("\n")

    val result = MediaProxyLive.rewritePlaylist(text, origin, key, source).split("\n")
    assertEquals("#EXTM3U", result[0])
    assertEquals("#EXT-X-MEDIA-SEQUENCE:100", result[1])
    assertEquals(
      "#EXT-X-KEY:METHOD=AES-128,URI=\"${MediaProxyLive.buildUrl(origin, key, "https://cdn.example.com/live/key.bin")}\"",
      result[2],
    )
    assertEquals(MediaProxyLive.buildUrl(origin, key, "https://cdn.example.com/live/100.ts"), result[4])
    assertEquals(MediaProxyLive.buildUrl(origin, key, "https://other.example.com/101.ts?x=1"), result[6])
    assertEquals("", result[7])
  }

  @Test
  fun rewritesMasterPlaylistChildren() {
    val text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720/index.m3u8"
    val result = MediaProxyLive.rewritePlaylist(text, origin, key, "https://cdn.example.com/live/master.m3u8")
    assertEquals(
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n" +
        MediaProxyLive.buildUrl(origin, key, "https://cdn.example.com/live/720/index.m3u8"),
      result,
    )
  }
}
