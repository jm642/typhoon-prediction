/**
 * 路径回放：沿实测路径点逐帧前进
 *
 * frameIndex = null 表示实时态（完整路径 + 预报线）；拖到最右端也回到实时态。
 * 切换台风时自动复位（watch id），调用方无需在每个入口手动清理。
 */
import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import type { NormalizedTyphoon } from '../types/typhoon'
import { fmtShort } from '../lib/format'

/** 每帧间隔（ms） */
const FRAME_INTERVAL = 450

export function usePlayback(typhoon: Ref<NormalizedTyphoon | null>) {
  const frameIndex = ref<number | null>(null)
  const playing = ref(false)
  /** 强度曲线 hover 的时次 → 地图高亮对应路径点 */
  const highlightTime = ref<number | null>(null)
  let timer = 0

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = 0
    }
  }

  /** 当前展示的路径点：回放取游标处，实时取最新 */
  const shownPoint = computed(() => {
    const t = typhoon.value
    if (!t || t.path.length === 0) return null
    const i = frameIndex.value
    return i == null ? t.path[t.path.length - 1] : t.path[Math.min(i, t.path.length - 1)]
  })

  const frameLabel = computed(() => (shownPoint.value ? fmtShort(shownPoint.value.time) : ''))

  function reset() {
    stopTimer()
    playing.value = false
    frameIndex.value = null
    highlightTime.value = null
  }

  /** 拖动进度条：手动操作时停止自动播放 */
  function setFrameIndex(v: number | null) {
    stopTimer()
    playing.value = false
    frameIndex.value = v
  }

  function togglePlay() {
    const t = typhoon.value
    if (!t || t.path.length < 2) return
    if (playing.value) {
      stopTimer()
      playing.value = false
      return
    }
    if (frameIndex.value == null) frameIndex.value = 0
    playing.value = true
    timer = window.setInterval(() => {
      const len = typhoon.value?.path.length ?? 0
      const cur = frameIndex.value ?? 0
      // 播到最新时次后回到实时态（恢复预报线）
      if (len === 0 || cur >= len - 1) {
        stopTimer()
        playing.value = false
        frameIndex.value = null
        return
      }
      frameIndex.value = cur + 1
    }, FRAME_INTERVAL)
  }

  // 换台风 / 取消选中 → 复位
  watch(() => typhoon.value?.id, () => reset())
  onUnmounted(stopTimer)

  return { frameIndex, playing, highlightTime, shownPoint, frameLabel, setFrameIndex, togglePlay, reset }
}
