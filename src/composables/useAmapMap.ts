/**
 * 高德地图实例生命周期（spec §6）
 * 用 @amap/amap-jsapi-loader 加载 JS API 2.0，在 onUnmounted 时销毁。
 * Key / securityJsCode 走 Vite .env。
 */
import { onMounted, onUnmounted, ref, shallowRef, type Ref } from 'vue'
import AMapLoader from '@amap/amap-jsapi-loader'

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY as string | undefined
const AMAP_SECURITY_JSCODE = import.meta.env.VITE_AMAP_SECURITY_JSCODE as string | undefined

export function useAmapMap(containerRef: Ref<HTMLElement | null>) {
  const amap = shallowRef<any>(null) // AMap 命名空间（用于 new 各类）
  const map = shallowRef<any>(null) // AMap.Map 实例
  const ready = ref(false)
  const error = ref<string | null>(null)

  onMounted(async () => {
    if (!AMAP_KEY) {
      error.value = '未配置 VITE_AMAP_KEY（.env）'
      return
    }
    try {
      if (AMAP_SECURITY_JSCODE) {
        ;(window as any)._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_JSCODE }
      }
      const loaded = await AMapLoader.load({
        key: AMAP_KEY,
        version: '2.0',
        plugins: ['AMap.ImageLayer', 'AMap.TileLayer'],
      })
      const el = containerRef.value
      if (!el) throw new Error('地图容器不存在')
      amap.value = loaded
      map.value = new loaded.Map(el, {
        viewMode: '2D',
        zoom: 5,
        center: [130, 30], // 西太平洋
        mapStyle: 'amap://styles/normal', // 标准蓝白样式
        zooms: [3, 18],
        showLabel: true,
      })
      ready.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  })

  onUnmounted(() => {
    map.value?.destroy?.()
    map.value = null
    amap.value = null
  })

  return { amap, map, ready, error }
}
