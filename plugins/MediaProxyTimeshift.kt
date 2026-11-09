package com.oriontv

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import kotlin.math.ceil

/**
 * 时移路由（纯函数，便于单测）：把只能返回固定一段（带 ENDLIST）的回看接口，
 * 拼成从固定起点开始、持续增长的 EVENT 清单，播放器当直播刷新，连续播放不用每段重新加载。
 *
 * 路径格式：/_ts/<会话 id>/_hls.m3u8；回看模板、起点、时区等由会话保存。
 * 片段地址保持上游绝对地址（播放器直接拉，不经过代理）。
 */
object MediaProxyTimeshift {
  const val PREFIX = "/_ts/"

  /** key：去掉查询参数的绝对地址，用来在多次请求之间认出同一个分片（查询参数里常带时间戳、签名） */
  data class Segment(val key: String, val uri: String, val duration: Double, val tags: List<String>)

  private val TOKEN = Regex("""\$\{\((b|e)\)([^}]*)\}""")
  private val FORMAT = Regex("yyyy|MM|dd|HH|mm|ss")
  /** 跟随分片保留的标签；清单级标签（版本、时长、序号、类型、结束）由 render 重新生成 */
  private val SEGMENT_TAGS = listOf("#EXT-X-DISCONTINUITY", "#EXT-X-KEY", "#EXT-X-MAP", "#EXT-X-PROGRAM-DATE-TIME")
  /** 重叠请求的片段数：回看接口按分片对齐，起点会偏一个分片 */
  private const val OVERLAP_SEGMENTS = 2

  fun buildPath(id: String): String = "$PREFIX$id${MediaProxyPlaylist.PLAYLIST_SUFFIX}"

  fun parsePath(rawTarget: String): String? {
    if (!rawTarget.startsWith(PREFIX)) return null
    val id = rawTarget.removePrefix(PREFIX).removeSuffix(MediaProxyPlaylist.PLAYLIST_SUFFIX)
    return if (id.isNotEmpty() && Regex("^[a-z0-9]+$").matches(id)) id else null
  }

  /** 与 JS 的 buildCatchupUrl 一致：替换 ${(b)FMT} / ${(e)FMT}，时间按 tzMinutes 时区格式化 */
  fun formatTemplate(template: String, beginMs: Long, endMs: Long, tzMinutes: Int): String =
    TOKEN.replace(template) { match ->
      val ms = if (match.groupValues[1] == "b") beginMs else endMs
      formatTime(ms, match.groupValues[2], tzMinutes)
    }

  private fun formatTime(ms: Long, format: String, tzMinutes: Int): String {
    val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"), Locale.US)
    cal.timeInMillis = ms + tzMinutes * 60_000L
    fun pad(n: Int) = if (n < 10) "0$n" else "$n"
    return FORMAT.replace(format) { token ->
      when (token.value) {
        "yyyy" -> cal.get(Calendar.YEAR).toString()
        "MM" -> pad(cal.get(Calendar.MONTH) + 1)
        "dd" -> pad(cal.get(Calendar.DAY_OF_MONTH))
        "HH" -> pad(cal.get(Calendar.HOUR_OF_DAY))
        "mm" -> pad(cal.get(Calendar.MINUTE))
        else -> pad(cal.get(Calendar.SECOND))
      }
    }
  }

  /** 主列表里第一个子列表的绝对地址；不是主列表返回 null */
  fun firstVariant(text: String, baseUrl: String): String? {
    var afterStreamInf = false
    for (raw in text.split("\n")) {
      val line = raw.trim()
      if (line.startsWith("#EXT-X-STREAM-INF")) afterStreamInf = true
      else if (afterStreamInf && line.isNotEmpty() && !line.startsWith("#")) return MediaProxyPlaylist.resolveUrl(line, baseUrl)
    }
    return null
  }

  fun parseMedia(text: String, baseUrl: String): List<Segment> {
    val result = ArrayList<Segment>()
    val pendingTags = ArrayList<String>()
    var pendingDuration: Double? = null
    for (raw in text.split("\n")) {
      val line = raw.trim()
      when {
        line.isEmpty() -> Unit
        line.startsWith("#EXTINF:") ->
          pendingDuration = line.removePrefix("#EXTINF:").substringBefore(',').trim().toDoubleOrNull() ?: 0.0
        line.startsWith("#") -> if (SEGMENT_TAGS.any { line.startsWith(it) }) pendingTags.add(line)
        else -> {
          val uri = MediaProxyPlaylist.resolveUrl(line, baseUrl)
          if (uri != null && pendingDuration != null) {
            result.add(Segment(uri.substringBefore('?').substringBefore('#'), uri, pendingDuration!!, pendingTags.toList()))
          }
          pendingTags.clear()
          pendingDuration = null
        }
      }
    }
    return result
  }

  /**
   * 把新拿到的片段接到已有片段后面：在新列表里找已有的最后一个分片，只追加它之后的；
   * 找不到（中间断档）就整份追加，并在接缝处标不连续。
   */
  fun merge(existing: List<Segment>, incoming: List<Segment>): List<Segment> {
    if (existing.isEmpty()) return incoming
    if (incoming.isEmpty()) return existing
    val lastKey = existing.last().key
    val index = incoming.indexOfLast { it.key == lastKey }
    if (index >= 0) {
      val fresh = incoming.subList(index + 1, incoming.size)
      return if (fresh.isEmpty()) existing else existing + fresh
    }
    val known = existing.mapTo(HashSet()) { it.key }
    val fresh = incoming.filter { it.key !in known }
    if (fresh.isEmpty()) return existing
    val first = fresh[0]
    val marked = if (first.tags.contains("#EXT-X-DISCONTINUITY")) first else first.copy(tags = listOf("#EXT-X-DISCONTINUITY") + first.tags)
    return existing + marked + fresh.drop(1)
  }

  /** 下一次向上游请求的起点：从已拿到内容的末尾往前重叠几个分片 */
  fun nextRequestBegin(beginMs: Long, segments: List<Segment>): Long {
    if (segments.isEmpty()) return beginMs
    val covered = segments.sumOf { it.duration }
    val overlap = segments.takeLast(OVERLAP_SEGMENTS).sumOf { it.duration }
    return beginMs + ((covered - overlap) * 1000).toLong()
  }

  /** 持续增长的 EVENT 清单：不带 ENDLIST，从开头播放 */
  fun render(segments: List<Segment>): String = buildString {
    val target = ceil(segments.maxOfOrNull { it.duration } ?: 6.0).toInt().coerceAtLeast(1)
    append("#EXTM3U\n")
    append("#EXT-X-VERSION:3\n")
    append("#EXT-X-TARGETDURATION:").append(target).append('\n')
    append("#EXT-X-PLAYLIST-TYPE:EVENT\n")
    append("#EXT-X-MEDIA-SEQUENCE:0\n")
    append("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n")
    for (segment in segments) {
      segment.tags.forEach { append(it).append('\n') }
      append("#EXTINF:").append(String.format(Locale.US, "%.3f", segment.duration)).append(",\n")
      append(segment.uri).append('\n')
    }
  }
}
