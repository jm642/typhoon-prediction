<script setup lang="ts">
/**
 * 卫星云图 + 气象雷达图层
 * - 云图(卫星)：NASA GIBS 向日葵-9 XYZ 瓦片（见 api/imagery.ts，z≤6 红外 / z7 可见光），
 *   单个 AMap.TileLayer 覆盖全图，time 参数 `default` 自动取最新时次；
 *   z>7 无更高分辨率源，canvas 拼合 z7 瓦片经 ImageLayer overzoom（地理锚定，随图缩放）。
 * - 雷达：NMC 2×2 分块 PNG，先 GET /imgs/radar/default 取最新时间戳，
 *   再创建 4 个 ImageLayer setMap（bounds 取 IMG_PARTS）。
 * 两者机制独立，各自独立开关。
 */
import { onUnmounted, watch } from 'vue'
import {
  buildRadarImageUrl,
  buildSatelliteTileUrl,
  fetchRadarTime,
  lngLatToTile,
  SAT_ZOOMS,
  tileToLngLat,
} from '../api/imagery'
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

// ----- 云图 overzoom（z>7：canvas 拼合 z7 瓦片 → ImageLayer）-----
let overLayer: any = null
let overToken = 0
let overArea: { sw: [number, number]; ne: [number, number] } | null = null

function removeOverLayer() {
  overLayer?.setMap(null)
  overLayer = null
  overArea = null
}

function loadTileImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous' // GIBS CORS *，保证 canvas 可 toDataURL
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`瓦片加载失败 ${url}`))
    img.src = url
  })
}

async function applyOverzoom() {
  if (!props.amap || !props.map) return
  if (!props.showCloud || props.map.getZoom() <= 7) {
    removeOverLayer()
    return
  }
  const b = props.map.getBounds()
  const sw = b.getSouthWest()
  const ne = b.getNorthEast()
  // 视口仍在既有拼合范围内圈（四周留 1/4 边距）则不重建，避免拖动频繁重拼
  if (overLayer && overArea) {
    const w = overArea.ne[0] - overArea.sw[0]
    const h = overArea.ne[1] - overArea.sw[1]
    if (
      sw.getLng() > overArea.sw[0] + w / 4 &&
      ne.getLng() < overArea.ne[0] - w / 4 &&
      sw.getLat() > overArea.sw[1] + h / 4 &&
      ne.getLat() < overArea.ne[1] - h / 4
    ) {
      return
    }
  }
  const my = ++overToken
  // 四周各扩半个视口宽高，取覆盖的 z7 瓦片范围（扩一个视口会让 z=8 全屏瓦片数破上限被拒 → 云图消失）
  const dLng = (ne.getLng() - sw.getLng()) / 2
  const dLat = (ne.getLat() - sw.getLat()) / 2
  const t0 = lngLatToTile(sw.getLng() - dLng, ne.getLat() + dLat, 7)
  const t1 = lngLatToTile(ne.getLng() + dLng, sw.getLat() - dLat, 7)
  const cols = t1.x - t0.x + 1
  const rows = t1.y - t0.y + 1
  // 上限防超大屏一次拼合过多瓦片卡顿（1/2 扩展下：1080p z=8 约 45 块、1440p 约 77 块）
  if (cols < 1 || rows < 1 || cols * rows > 128) return
  try {
    const coords: { x: number; y: number }[] = []
    for (let y = t0.y; y <= t1.y; y++) for (let x = t0.x; x <= t1.x; x++) coords.push({ x, y })
    const imgs = await Promise.all(coords.map((c) => loadTileImage(buildSatelliteTileUrl(c.x, c.y, 7))))
    if (my !== overToken) return
    const canvas = document.createElement('canvas')
    canvas.width = cols * 256
    canvas.height = rows * 256
    const ctx = canvas.getContext('2d')!
    imgs.forEach((img, i) => {
      ctx.drawImage(img, (coords[i].x - t0.x) * 256, (coords[i].y - t0.y) * 256)
    })
    const bsw = tileToLngLat(t0.x, t1.y + 1, 7)
    const bne = tileToLngLat(t1.x + 1, t0.y, 7)
    const layer = new props.amap.ImageLayer({
      url: canvas.toDataURL(),
      bounds: new props.amap.Bounds([bsw.lng, bsw.lat], [bne.lng, bne.lat]),
      zooms: [7, 18],
      opacity: 0.7,
    })
    layer.setMap(props.map)
    const old = overLayer
    overLayer = layer
    overArea = { sw: [bsw.lng, bsw.lat], ne: [bne.lng, bne.lat] }
    old?.setMap(null)
  } catch (e) {
    console.warn('[云图] overzoom 拼合失败', e)
  }
}

let overzoomHandler: (() => void) | null = null

function bindOverzoomEvents() {
  if (overzoomHandler || !props.map) return
  overzoomHandler = () => applyOverzoom()
  props.map.on('moveend', overzoomHandler)
  props.map.on('zoomend', overzoomHandler)
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
  bindOverzoomEvents()
  applySatellite(props.showCloud)
  await applyRadar(props.showRadar)
  await applyOverzoom()
}

watch([() => props.amap, () => props.map, () => props.showCloud, () => props.showRadar], update)

onUnmounted(() => {
  if (overzoomHandler && props.map) {
    props.map.off('moveend', overzoomHandler)
    props.map.off('zoomend', overzoomHandler)
    overzoomHandler = null
  }
  satLayer?.setMap(null)
  satLayer = null
  removeOverLayer()
  removeRadarLayers()
})
</script>

<template>
  <div class="imagery-layer" />
</template>
