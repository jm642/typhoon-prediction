<script setup lang="ts">
/**
 * 卫星云图 + 气象雷达图层
 * - 云图(卫星)：NASA GIBS 向日葵-9 XYZ 瓦片（见 api/imagery.ts，z≤6 红外 / z≥7 可见光，z>7 overzoom），
 *   单个 AMap.TileLayer 覆盖全图，time 参数 `default` 自动取最新时次。
 * - 雷达：NMC 2×2 分块 PNG，先 GET /imgs/radar/default 取最新时间戳，
 *   再创建 4 个 ImageLayer setMap（bounds 取 IMG_PARTS）。
 * 两者机制独立，各自独立开关。
 */
import { onUnmounted, watch } from 'vue'
import { buildRadarImageUrl, buildSatelliteTileUrl, fetchRadarTime, SAT_ZOOMS } from '../api/imagery'
import { IMG_PARTS } from '../constants/imagery'

const props = defineProps<{
  amap: any
  map: any
  showCloud: boolean
  showRadar: boolean
}>()

// ----- 云图（GIBS TileLayer）-----
let satLayer: any = null

function applySatellite(show: boolean) {
  if (!props.amap || !props.map) return
  if (show) {
    if (!satLayer) {
      satLayer = new props.amap.TileLayer({
        getTileUrl: (x: number, y: number, z: number) => buildSatelliteTileUrl(x, y, z),
        zooms: SAT_ZOOMS,
        opacity: 0.7,
      })
      satLayer.setMap(props.map)
    } else {
      satLayer.show()
    }
  } else {
    satLayer?.hide()
  }
}

// ----- 雷达（NMC 分块 ImageLayer）-----
let radarLayers: any[] = []
let radarCache: string | undefined
let radarToken = 0

function removeRadarLayers() {
  if (props.map && radarLayers.length) {
    for (const l of radarLayers) {
      l.setMap(null)
    }
  }
  radarLayers = []
}

async function applyRadar(show: boolean) {
  const my = ++radarToken
  if (show) {
    if (!radarLayers.length) {
      try {
        const time = radarCache ?? (await fetchRadarTime())?.time
        if (my !== radarToken) return
        if (time) {
          radarCache = time
          radarLayers = IMG_PARTS.map((p) => {
            const layer = new props.amap.ImageLayer({
              url: buildRadarImageUrl(time, p.part),
              bounds: new props.amap.Bounds(p.bounds.sw, p.bounds.ne),
              zooms: [3, 18],
              opacity: 0.6,
            })
            layer.setMap(props.map)
            return layer
          })
        } else {
          console.warn('[雷达] 当前无产品(state!=0)，稍后重试')
        }
      } catch (e) {
        console.warn('[雷达] 加载失败', e)
      }
    }
  } else {
    removeRadarLayers()
  }
}

async function update() {
  if (!props.amap || !props.map) return
  applySatellite(props.showCloud)
  await applyRadar(props.showRadar)
}

watch([() => props.amap, () => props.map, () => props.showCloud, () => props.showRadar], update)

onUnmounted(() => {
  satLayer?.setMap(null)
  satLayer = null
  removeRadarLayers()
})
</script>

<template>
  <div class="imagery-layer" />
</template>
