package com.oriontv

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest

/**
 * 本地代理的 HLS 清单改写（与 JS 版行为等价，纯函数，便于单测）。
 */
object MediaProxyPlaylist {
  /**
   * 播放器靠 URL 最后一段的后缀判断类型。编码后的令牌不保证以 .m3u8 结束，
   * 因此清单地址统一追加这个本机路由后缀，解码时只移除它，不改上游地址。
   */
  const val PLAYLIST_SUFFIX = "/_hls.m3u8"

  fun isHlsPlaylist(text: String): Boolean = text.trimStart().startsWith("#EXTM3U")

  fun isLeafPlaylist(text: String): Boolean = text.contains("#EXTINF:")

  /** 只还原当前本机代理的 path 令牌；外部代理前缀和完整参数必须原样保留。 */
  fun unwrapProxyUrl(url: String, localOrigin: String): String {
    val prefix = localOrigin.trimEnd('/') + "/"
    if (!url.startsWith(prefix)) return url

    val token = url.substring(prefix.length)
    val target = decodeProxyTarget(token)
    return if (isHttpTarget(target)) target else url
  }

  /** 把完整上游地址编码成单个 path 令牌，地址里的 /、?、%、& 等都不会影响本机路由。 */
  fun encodeProxyTarget(targetUrl: String): String =
    URLEncoder.encode(targetUrl, Charsets.UTF_8.name()).replace("+", "%20")

  /** 解码 path 令牌；兼容已存在的未编码旧地址，且不重复解码。 */
  fun decodeProxyTarget(token: String): String {
    val encoded = if (token.endsWith(PLAYLIST_SUFFIX)) token.removeSuffix(PLAYLIST_SUFFIX) else token
    if (isHttpTarget(encoded)) return encoded
    return try {
      URLDecoder.decode(encoded, Charsets.UTF_8.name())
    } catch (_: Throwable) {
      encoded
    }
  }

  fun isHttpTarget(value: String): Boolean =
    value.startsWith("http://", ignoreCase = true) || value.startsWith("https://", ignoreCase = true)

  /** 把相对地址按清单地址解析成绝对地址；解析失败返回 null */
  fun resolveUrl(raw: String, base: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    return try {
      URI(base).resolve(trimmed).toString()
    } catch (_: Throwable) {
      null
    }
  }

  /** 生成本地代理地址：用于清单、密钥、初始化段等少量资源。 */
  fun buildProxyUrl(origin: String, targetUrl: String): String {
    val path = "$origin/${encodeProxyTarget(targetUrl)}"
    return if (isPlaylistTarget(targetUrl)) "$path$PLAYLIST_SUFFIX" else path
  }

  private fun isPlaylistTarget(targetUrl: String): Boolean =
    targetUrl.substringBefore('?').substringBefore('#').endsWith(".m3u8", ignoreCase = true)

  /** 清单标识：SHA-256 十六进制指纹，碰撞概率可忽略。 */
  private fun normalizeLineEndings(text: String): String =
    text.replace("\r\n", "\n").replace('\r', '\n')

  fun hashString(input: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
    val hex = charArrayOf('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f')
    return buildString(digest.size * 2) {
      for (value in digest) {
        val byte = value.toInt() and 0xff
        append(hex[byte ushr 4])
        append(hex[byte and 0x0f])
      }
    }
  }

  /** 分片文件名固定为 seg，只保留原始地址的扩展名。 */
  fun segmentFileName(targetUrl: String): String {
    val path = try {
      URI(targetUrl).path ?: ""
    } catch (_: Throwable) {
      targetUrl.substringBefore('?').substringBefore('#')
    }
    val lastSegment = path.substringAfterLast('/')
    val dot = lastSegment.lastIndexOf('.')
    return if (dot >= 0) "seg${lastSegment.substring(dot)}" else "seg"
  }

  /** 生成本地代理分片地址：/<pid>/<sid>/seg.<原始扩展名>。 */
  fun buildSegmentProxyUrl(origin: String, pid: String, sid: Int, targetUrl: String): String =
    "$origin/$pid/$sid/${segmentFileName(targetUrl)}"

  /** 改写行里的 URI="..." 属性（#EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 等） */
  private fun rewriteUriAttributes(line: String, origin: String, sourceUrl: String): String {
    val regex = Regex("URI=\"([^\"]+)\"")
    return regex.replace(line) { match ->
      val uri = match.groupValues[1]
      val absolute = resolveUrl(uri, sourceUrl)
      if (absolute == null) match.value else "URI=\"${buildProxyUrl(origin, absolute)}\""
    }
  }

  private val URI_ATTRIBUTE_LINE = Regex("^#EXT-X-[A-Z0-9-]+:")

  data class LeafRewriteResult(val text: String, val pid: String, val segments: List<String>)

  /** 改写最终分片清单：分片地址走代理并带 pid/sid */
  fun rewriteLeafPlaylist(text: String, origin: String, sourceUrl: String): LeafRewriteResult {
    // 清单以地址和内容的 SHA-256 指纹作为标识：分片请求只带 pid/sid，回源地址查登记表。
    val pid = hashString(sourceUrl + "\u0000" + normalizeLineEndings(text))
    val lines = text.split("\n")
    val out = ArrayList<String>(lines.size + 8)
    val segments = ArrayList<String>()
    var index = 0
    while (index < lines.size) {
      val line = lines[index]
      when {
        line.startsWith("#EXTINF:") -> {
          out.add(line)
          index += 1
          if (index >= lines.size || lines[index].isEmpty()) break
          val target = resolveUrl(lines[index], sourceUrl)
          if (target == null) {
            out.add(lines[index])
          } else {
            out.add(buildSegmentProxyUrl(origin, pid, segments.size, target))
            segments.add(target)
          }
        }
        URI_ATTRIBUTE_LINE.containsMatchIn(line) && line.contains("URI=\"") ->
          out.add(rewriteUriAttributes(line, origin, sourceUrl))
        else -> out.add(line)
      }
      index += 1
    }
    return LeafRewriteResult(out.joinToString("\n"), pid, segments)
  }

  /** 改写子清单（master/中间层）：只把子清单地址指向代理，不加 pid/sid */
  fun rewriteChildPlaylist(text: String, origin: String, sourceUrl: String): String {
    val lines = text.split("\n")
    val out = ArrayList<String>(lines.size + 8)
    var index = 0
    while (index < lines.size) {
      val line = lines[index]
      when {
        line.startsWith("#EXT-X-STREAM-INF:") -> {
          out.add(line)
          index += 1
          if (index >= lines.size || lines[index].isEmpty()) break
          val target = resolveUrl(lines[index], sourceUrl)
          out.add(if (target == null) lines[index] else buildProxyUrl(origin, target))
        }
        URI_ATTRIBUTE_LINE.containsMatchIn(line) && line.contains("URI=\"") ->
          out.add(rewriteUriAttributes(line, origin, sourceUrl))
        else -> out.add(line)
      }
      index += 1
    }
    return out.joinToString("\n")
  }
}
