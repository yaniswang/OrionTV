package com.oriontv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DanmakuSceneTest {

  private fun item(id: Int, startX: Double = 960.0, startWall: Double = 1000.0, speed: Double = 100.0, hidden: Boolean = false) =
    DanmakuItem(id, "t$id", 0, row = 0, secondary = false, startX = startX, startWall = startWall, speed = speed, hidden = hidden)

  @Test
  fun positionFollowsJsFormula() {
    val scene = DanmakuScene()
    scene.add(listOf(item(1)))
    // x = startX - speed * (now - startWall) / 1000
    assertEquals(860.0, scene.positionOf(scene.items[0], 2000.0), 1e-9)
    assertEquals(960.0, scene.positionOf(scene.items[0], 500.0), 1e-9)
  }

  @Test
  fun pauseFreezesAndResumeShiftsStartWall() {
    val scene = DanmakuScene()
    scene.add(listOf(item(1)))
    scene.pause(2000.0)
    assertEquals(860.0, scene.positionOf(scene.items[0], 9000.0), 1e-9)
    assertTrue(scene.isPaused)
    // JS 恢复时 delta = now - pausedAt - advance，各条 startWall 整体平移
    scene.resume(7000.0)
    assertFalse(scene.isPaused)
    assertEquals(860.0, scene.positionOf(scene.items[0], 9000.0), 1e-9)
    assertEquals(760.0, scene.positionOf(scene.items[0], 10000.0), 1e-9)
  }

  @Test
  fun repeatedPauseKeepsFirstFreezeTime() {
    val scene = DanmakuScene()
    scene.add(listOf(item(1)))
    scene.pause(2000.0)
    scene.pause(5000.0)
    assertEquals(860.0, scene.positionOf(scene.items[0], 9000.0), 1e-9)
  }

  @Test
  fun updateRemoveClearAndReveal() {
    val scene = DanmakuScene()
    scene.add(listOf(item(1), item(2, hidden = true), item(3)))
    scene.update(2, startX = 500.0, startWall = 3000.0, speed = 50.0)
    assertEquals(450.0, scene.positionOf(scene.items[1], 4000.0), 1e-9)
    scene.remove(listOf(1))
    assertEquals(listOf(2, 3), scene.items.map { it.id })
    assertTrue(scene.items[0].hidden)
    scene.revealAll()
    assertFalse(scene.items[0].hidden)
    scene.clear()
    assertTrue(scene.items.isEmpty())
  }

  @Test
  fun frameClockFollowsSteadyFrames() {
    val clock = DanmakuFrameClock()
    var real = 1000.0
    assertEquals(real, clock.next(real), 1e-9)
    repeat(20) {
      real += 16.0
      assertEquals(real, clock.next(real), 1e-6)
    }
  }

  @Test
  fun frameClockSpreadsADroppedFrameAndCatchesUp() {
    val clock = DanmakuFrameClock()
    var real = 0.0
    var render = clock.next(real)
    repeat(10) { real += 16.0; render = clock.next(real) }
    // 掉一帧（间隔 50ms）：本帧只前进一部分，不一下跳过去
    real += 50.0
    val previous = render
    render = clock.next(real)
    assertTrue(render - previous < 50.0)
    assertTrue(render > previous + 16.0)
    // 之后正常出帧，逐步追上真实时间
    repeat(30) { real += 16.0; render = clock.next(real) }
    assertEquals(real, render, 1.0)
  }

  @Test
  fun frameClockSnapsAfterLongStallAndNeverGoesBack() {
    val clock = DanmakuFrameClock()
    clock.next(0.0)
    clock.next(16.0)
    // 卡住超过最大滞后，直接对齐真实时间
    assertEquals(1016.0, clock.next(1016.0), 1e-9)
    // 时钟回拨也不倒退
    assertEquals(1016.0, clock.next(900.0), 1e-9)
    clock.reset()
    assertEquals(5000.0, clock.next(5000.0), 1e-9)
  }

  @Test
  fun bitmapPoolPicksSmallestFittingSameHeight() {
    val sizes = listOf(100 to 40, 300 to 40, 210 to 40, 220 to 50)
    // 同高、宽度够用且不超过需要的 1.5 倍，取最小的
    assertEquals(2, DanmakuBitmapPool.pickIndex(sizes, 200, 40))
    assertEquals(-1, DanmakuBitmapPool.pickIndex(sizes, 400, 40))
    // 100 太窄，210、300 超过 1.5 倍，浪费太多内存，不复用
    assertEquals(-1, DanmakuBitmapPool.pickIndex(sizes, 120, 40))
    assertEquals(3, DanmakuBitmapPool.pickIndex(sizes, 200, 50))
  }

  @Test
  fun pruneDropsOnlyItemsFullyOffScreen() {
    val scene = DanmakuScene()
    // 1 秒后 x = -40：宽 50 时尾部仍在屏幕上，宽 30 时已离场
    scene.add(listOf(item(1, startX = 60.0), item(2, startX = 60.0)))
    scene.prune(2000.0) { if (it.id == 1) 50.0 else 30.0 }
    assertEquals(listOf(1), scene.items.map { it.id })
  }
}
