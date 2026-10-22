package com.oriontv

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.View
import android.view.animation.AnimationUtils
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * 弹幕原生画布 —— 只负责绘制和移动（Android）。
 *
 * 泳道、碰撞、预铺、SEEK/暂停等调度都在 JS（DanmakuOverlay）；JS 为每条弹幕算好
 * startX/startWall/speed，这里按与 JS 估算完全相同的公式
 * x = startX - speed * (now - startWall) / 1000 自行逐帧计算位置。
 * 时钟同为墙上时间（JS Date.now / System.currentTimeMillis），指令晚到也画在正确位置。
 * 坐标与速度单位均为 dp。
 */
data class DanmakuItem(
  val id: Int,
  val text: String,
  val color: Int,
  val row: Int,
  val secondary: Boolean,
  var startX: Double,
  var startWall: Double,
  var speed: Double,
  var hidden: Boolean,
  /** 实际绘制宽度（dp），首次绘制时测量 */
  var measuredWidth: Double = -1.0,
) {
  /** 预渲染好的文字位图（后台线程写入）；未就绪时直接画字 */
  @Volatile
  var cache: Bitmap? = null
  var cacheRequested = false
}

class DanmakuScene {
  val items = ArrayList<DanmakuItem>()
  private var frozenAt: Double? = null

  val isPaused: Boolean
    get() = frozenAt != null

  fun add(next: List<DanmakuItem>) {
    items.addAll(next)
  }

  /** 以下移除操作均返回被移除的弹幕，供调用方回收位图 */
  fun remove(ids: Collection<Int>): List<DanmakuItem> {
    val set = ids.toHashSet()
    return removeWhere { it.id in set }
  }

  fun clear(): List<DanmakuItem> = removeWhere { true }

  fun update(id: Int, startX: Double, startWall: Double, speed: Double) {
    val item = items.firstOrNull { it.id == id } ?: return
    item.startX = startX
    item.startWall = startWall
    item.speed = speed
  }

  fun revealAll() = items.forEach { it.hidden = false }

  /** 与 JS 一致：重复暂停保留首次暂停时刻 */
  fun pause(pausedAt: Double) {
    if (frozenAt == null) frozenAt = pausedAt
  }

  /** deltaMs 由 JS 计算（恢复时刻 - 暂停时刻 - 额外前进），各条 startWall 整体平移 */
  fun resume(deltaMs: Double) {
    if (frozenAt == null) return
    frozenAt = null
    items.forEach { it.startWall += deltaMs }
  }

  fun positionOf(item: DanmakuItem, now: Double): Double {
    val reference = frozenAt ?: now
    return item.startX - item.speed * (reference - item.startWall).coerceAtLeast(0.0) / 1000.0
  }

  /** 丢弃整条已移出左边缘的弹幕（按实际绘制宽度） */
  fun prune(now: Double, widthOf: (DanmakuItem) -> Double): List<DanmakuItem> =
    removeWhere { positionOf(it, now) + widthOf(it) < 0 }

  private fun removeWhere(predicate: (DanmakuItem) -> Boolean): List<DanmakuItem> {
    val removed = items.filter(predicate)
    if (removed.isNotEmpty()) items.removeAll(removed.toHashSet())
    return removed
  }
}

/**
 * 帧时间平滑：按最近帧间隔的滑动平均推进，个别帧晚到时把跳变分摊到后续几帧，
 * 避免掉帧时弹幕一顿一跳；同时逐帧向真实时间收敛，且不超前、最多滞后 MAX_LAG_MS。
 */
class DanmakuFrameClock {
  private var lastReal: Double? = null
  private var lastRender = 0.0
  private var averageInterval: Double? = null

  fun reset() {
    lastReal = null
    averageInterval = null
  }

  fun next(real: Double): Double {
    val previousReal = lastReal
    lastReal = real
    if (previousReal == null) {
      lastRender = real
      return real
    }
    val interval = real - previousReal
    var render: Double
    if (interval < 0) {
      render = real
    } else {
      val average = averageInterval?.let { it * (1 - SMOOTHING) + interval * SMOOTHING } ?: interval
      averageInterval = average
      render = lastRender + average
      render += (real - render) * CATCH_UP
      if (render > real || abs(real - render) > MAX_LAG_MS) render = real
    }
    if (render < lastRender) render = lastRender
    lastRender = render
    return render
  }

  private companion object {
    const val SMOOTHING = 0.2
    const val CATCH_UP = 0.15
    const val MAX_LAG_MS = 100.0
  }
}

/** 文字位图复用池：按高度相同、宽度够用且不超过所需 1.5 倍挑选，避免频繁分配引起 GC */
class DanmakuBitmapPool {
  private val bitmaps = ArrayList<Bitmap>()

  @Synchronized
  fun acquire(width: Int, height: Int): Bitmap {
    val index = pickIndex(bitmaps.map { it.width to it.height }, width, height)
    if (index < 0) return Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    return bitmaps.removeAt(index).also { it.eraseColor(Color.TRANSPARENT) }
  }

  @Synchronized
  fun release(bitmap: Bitmap) {
    if (bitmaps.size < MAX_POOLED) bitmaps.add(bitmap)
  }

  @Synchronized
  fun clear() = bitmaps.clear()

  companion object {
    private const val MAX_POOLED = 24

    fun pickIndex(sizes: List<Pair<Int, Int>>, width: Int, height: Int): Int {
      var best = -1
      sizes.forEachIndexed { index, (candidateWidth, candidateHeight) ->
        if (candidateHeight != height || candidateWidth < width || candidateWidth > width * 1.5) return@forEachIndexed
        if (best < 0 || candidateWidth < sizes[best].first) best = index
      }
      return best
    }
  }
}

class DanmakuCanvasView(context: Context) : View(context) {
  private val scene = DanmakuScene()
  private val clock = DanmakuFrameClock()
  private val pool = DanmakuBitmapPool()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      Typeface.create(Typeface.DEFAULT, 600, false)
    } else {
      Typeface.DEFAULT_BOLD
    }
  }
  // 描边：先画一圈黑色实线边，再画彩色字身。模糊阴影在红、蓝等深色字上会和笔画糊成一片
  private val strokePaint = Paint(paint).apply {
    style = Paint.Style.STROKE
    strokeJoin = Paint.Join.ROUND
    strokeWidth = PixelUtil.toPixelFromDIP(1.5f)
    // 60% 不透明：接近原 RN 模糊阴影的观感，纯黑实线太抢眼
    color = Color.argb(153, 0, 0, 0)
  }
  private var lineHeightDp = 37.5f

  // 位图在后台线程预生成：新弹幕进屏的那一帧不用在主线程上临时排版画字
  private var cacheThread: HandlerThread? = null
  private var cacheHandler: Handler? = null
  /** 字号变化后旧位图作废（后台线程也会读取） */
  @Volatile
  private var cacheGeneration = 0
  /** 刚移出画面的位图：上一帧可能仍在 RenderThread 上绘制，隔两帧再放回复用池 */
  private val retiring = ArrayList<Pair<Long, Bitmap>>()
  private var frameIndex = 0L

  fun setFontSize(sizeDp: Float) {
    // 与 RN Text 一致：字号像素向上取整
    paint.textSize = ceil(PixelUtil.toPixelFromSP(sizeDp).toDouble()).toFloat()
    strokePaint.textSize = paint.textSize
    cacheGeneration += 1
    scene.items.forEach {
      it.measuredWidth = -1.0
      retire(it)
    }
    pool.clear()
    invalidate()
  }

  fun setLineHeight(heightDp: Float) {
    lineHeightDp = heightDp
    invalidate()
  }

  fun runCommand(command: String, args: ReadableArray?) {
    when (command) {
      "add" -> {
        val list = args?.getArray(0) ?: return
        val next = ArrayList<DanmakuItem>(list.size())
        for (index in 0 until list.size()) {
          val map = list.getMap(index) ?: continue
          next.add(
            DanmakuItem(
              id = map.getInt("id"),
              text = map.getString("text") ?: "",
              color = parseColor(map.getString("color")),
              row = map.getInt("row"),
              secondary = map.getBoolean("secondary"),
              startX = map.getDouble("startX"),
              startWall = map.getDouble("startWall"),
              speed = map.getDouble("speed"),
              hidden = map.getBoolean("hidden"),
            ),
          )
        }
        scene.add(next)
        next.forEach(::requestCache)
      }
      "update" -> {
        val list = args?.getArray(0) ?: return
        for (index in 0 until list.size()) {
          val map = list.getMap(index) ?: continue
          scene.update(map.getInt("id"), map.getDouble("startX"), map.getDouble("startWall"), map.getDouble("speed"))
        }
      }
      "remove" -> {
        val list = args?.getArray(0) ?: return
        scene.remove((0 until list.size()).map { list.getInt(it) }).forEach(::retire)
      }
      "clear" -> scene.clear().forEach(::retire)
      "revealAll" -> scene.revealAll()
      "pause" -> scene.pause(args?.getDouble(0) ?: System.currentTimeMillis().toDouble())
      "resume" -> {
        scene.resume(args?.getDouble(0) ?: 0.0)
        clock.reset()
      }
    }
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val thread = HandlerThread("DanmakuCache").also { it.start() }
    cacheThread = thread
    cacheHandler = Handler(thread.looper)
    scene.items.forEach {
      it.cacheRequested = false
      requestCache(it)
    }
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    cacheThread?.quitSafely()
    cacheThread = null
    cacheHandler = null
  }

  private fun parseColor(value: String?): Int =
    try {
      Color.parseColor(value ?: "#ffffff")
    } catch (_: IllegalArgumentException) {
      Color.WHITE
    }

  private fun widthDp(item: DanmakuItem): Double {
    if (item.measuredWidth < 0) {
      item.measuredWidth = PixelUtil.toDIPFromPixel(paint.measureText(item.text)).toDouble()
    }
    return item.measuredWidth
  }

  /** 位图内文字四周留出描边的空间 */
  private fun cachePadding() = ceil(strokePaint.strokeWidth.toDouble()).toInt()

  private fun requestCache(item: DanmakuItem) {
    val handler = cacheHandler ?: return
    if (item.cacheRequested) return
    item.cacheRequested = true
    // Paint 不能跨线程共用，交给后台线程的是副本
    val fill = Paint(paint).apply { color = item.color }
    val stroke = Paint(strokePaint)
    val generation = cacheGeneration
    val padding = cachePadding()
    handler.post {
      if (generation != cacheGeneration || item.cache != null) return@post
      val metrics = fill.fontMetrics
      val width = ceil(fill.measureText(item.text).toDouble()).toInt() + padding * 2
      val height = ceil((metrics.descent - metrics.ascent).toDouble()).toInt() + padding * 2
      if (width <= 0 || height <= 0) return@post
      val bitmap = pool.acquire(width, height)
      val canvas = Canvas(bitmap)
      val baseline = padding - metrics.ascent
      canvas.drawText(item.text, padding.toFloat(), baseline, stroke)
      canvas.drawText(item.text, padding.toFloat(), baseline, fill)
      post {
        // 等待期间已离场或字号已变：位图直接回池
        if (generation == cacheGeneration && scene.items.contains(item)) {
          item.cache = bitmap
          invalidate()
        } else {
          pool.release(bitmap)
        }
      }
    }
  }

  private fun retire(item: DanmakuItem) {
    // 生成中的位图由后台任务按代号自行回池
    item.cacheRequested = false
    val bitmap = item.cache ?: return
    item.cache = null
    retiring.add(frameIndex to bitmap)
  }

  private fun releaseRetired() {
    val iterator = retiring.iterator()
    while (iterator.hasNext()) {
      val (frame, bitmap) = iterator.next()
      if (frameIndex - frame < 2) continue
      pool.release(bitmap)
      iterator.remove()
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    frameIndex += 1
    // 用本帧 vsync 时刻（AnimationUtils，uptime 基准）换算成墙上时间，再做平滑：
    // onDraw 的实际调用时刻随主线程负载抖动，直接取当前时间会让位移忽快忽慢
    val vsyncWall = AnimationUtils.currentAnimationTimeMillis() +
      (System.currentTimeMillis() - SystemClock.uptimeMillis())
    val now = clock.next(vsyncWall.toDouble())
    scene.prune(now, ::widthDp).forEach(::retire)
    releaseRetired()
    if (scene.items.isEmpty()) return

    val metrics = paint.fontMetrics
    val lineHeightPx = PixelUtil.toPixelFromDIP(lineHeightDp)
    // 文字在行内垂直居中
    val baselineOffset = (lineHeightPx - (metrics.descent - metrics.ascent)) / 2f - metrics.ascent
    val padding = cachePadding()
    val viewWidthDp = PixelUtil.toDIPFromPixel(width.toFloat())
    // 次要轨道（重叠模式）先画，主轨道压在上面，与原 zIndex 一致
    for (pass in 0..1) {
      val secondaryPass = pass == 0
      for (item in scene.items) {
        if (item.hidden || item.secondary != secondaryPass) continue
        val x = scene.positionOf(item, now)
        if (x > viewWidthDp) continue
        val top = item.row * lineHeightPx + if (item.secondary) PixelUtil.toPixelFromDIP(1f) else 0f
        // 取整到整像素：小数坐标会让字形插值到相邻像素，移动时发虚
        val drawX = PixelUtil.toPixelFromDIP(x.toFloat()).roundToInt().toFloat()
        val drawY = (top + baselineOffset).roundToInt().toFloat()
        val cache = item.cache
        if (cache != null) {
          // 位图基线在 padding - ascent 处，与直接画字的位置对齐
          canvas.drawBitmap(cache, drawX - padding, (drawY + metrics.ascent - padding).roundToInt().toFloat(), null)
        } else {
          requestCache(item)
          paint.color = item.color
          canvas.drawText(item.text, drawX, drawY, strokePaint)
          canvas.drawText(item.text, drawX, drawY, paint)
        }
      }
    }
    if (!scene.isPaused) postInvalidateOnAnimation()
  }
}

class DanmakuViewManager : SimpleViewManager<DanmakuCanvasView>() {
  override fun getName() = "OrionDanmakuView"

  override fun createViewInstance(context: ThemedReactContext) = DanmakuCanvasView(context)

  @ReactProp(name = "fontSize", defaultFloat = 25f)
  fun setFontSize(view: DanmakuCanvasView, value: Float) = view.setFontSize(value)

  @ReactProp(name = "lineHeight", defaultFloat = 37.5f)
  fun setLineHeight(view: DanmakuCanvasView, value: Float) = view.setLineHeight(value)

  override fun receiveCommand(view: DanmakuCanvasView, commandId: String, args: ReadableArray?) =
    view.runCommand(commandId, args)
}
