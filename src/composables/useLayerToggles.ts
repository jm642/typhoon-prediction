/**
 * 图层开关与加载反馈
 *
 * 雷达（取时间戳后挂 4 块图）与风场（拉全球网格）都有数秒网络耗时，
 * 期间开关置灰显示 ⏳；失败时给出一次性 toast，避免用户以为功能坏了。
 */
import { onUnmounted, ref } from 'vue'

/** 错误提示停留时长 */
const ERROR_TTL = 5000

export function useLayerToggles() {
  const showCloud = ref(false)
  const showRadar = ref(false)
  const showWind = ref(false)
  const radarLoading = ref(false)
  const windLoading = ref(false)
  const layerError = ref<string | null>(null)
  let errorTimer = 0

  function notifyLayerError(message: string) {
    layerError.value = message
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = window.setTimeout(() => {
      layerError.value = null
      errorTimer = 0
    }, ERROR_TTL)
  }

  onUnmounted(() => {
    if (errorTimer) clearTimeout(errorTimer)
  })

  return {
    showCloud,
    showRadar,
    showWind,
    radarLoading,
    windLoading,
    layerError,
    notifyLayerError,
  }
}
