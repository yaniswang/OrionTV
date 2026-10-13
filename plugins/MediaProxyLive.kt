package com.oriontv

/**
 * 直播透传路由（纯函数，便于单测）。
 *
 * 只为给电视端的回源请求补上 User-Agent：不缓存、不预取、不编号。
 * 清单里的地址必须改写回本路由，否则电视会直连 CDN，分片请求带不上 UA。
 * 路径格式：/_live/<uaKey>/<编码后的上游地址>[/_hls.m3u8]
 */
object MediaProxyLive {
  private const val PREFIX = "/_live/"

  private val URI_ATTRIBUTE_LINE = Regex("^#EXT-X-[A-Z0-9-]+:")
  private val URI_ATTRIBUTE = Regex("URI=\"([^\"]+)\"")

  /** 同一个 UA 得到固定的 key，地址可重复生成。 */
  fun userAgentKey(userAgent: String): String = MediaProxyPlaylist.hashString(userAgent).take(16)

  fun buildUrl(origin: String, key: String, targetUrl: String): String {
    val path = "$origin$PREFIX$key/${MediaProxyPlaylist.encodeProxyTarget(targetUrl)}"
    return if (isPlaylistTarget(targetUrl)) "$path${MediaProxyPlaylist.PLAYLIST_SUFFIX}" else path
  }

  /** 解析直播路由；不是直播路由时返回 null，交给原有分发逻辑。 */
  fun parsePath(rawTarget: String): Pair<String, String>? {
    if (!rawTarget.startsWith(PREFIX)) return null
    val rest = rawTarget.substring(PREFIX.length)
    val slash = rest.indexOf('/')
    if (slash <= 0) return null
    val key = rest.substring(0, slash)
    val target = MediaProxyPlaylist.decodeProxyTarget(rest.substring(slash + 1))
    return if (MediaProxyPlaylist.isHttpTarget(target)) key to target else null
  }

  /** 只改写地址行和 URI 属性，其余内容原样保留。 */
  fun rewritePlaylist(text: String, origin: String, key: String, sourceUrl: String): String =
    text.split("\n").joinToString("\n") { line ->
      val trimmed = line.trim()
      when {
        trimmed.isEmpty() -> line
        trimmed.startsWith("#") ->
          if (URI_ATTRIBUTE_LINE.containsMatchIn(trimmed) && trimmed.contains("URI=\"")) {
            URI_ATTRIBUTE.replace(line) { match ->
              val absolute = MediaProxyPlaylist.resolveUrl(match.groupValues[1], sourceUrl)
              if (absolute == null) match.value else "URI=\"${buildUrl(origin, key, absolute)}\""
            }
          } else {
            line
          }
        else -> {
          val absolute = MediaProxyPlaylist.resolveUrl(trimmed, sourceUrl)
          if (absolute == null) line else buildUrl(origin, key, absolute)
        }
      }
    }

  private fun isPlaylistTarget(targetUrl: String): Boolean =
    targetUrl.substringBefore('?').substringBefore('#').endsWith(".m3u8", ignoreCase = true)
}
