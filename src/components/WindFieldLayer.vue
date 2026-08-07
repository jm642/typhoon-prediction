<script setup lang="ts">
/**
 * 全球大气环流风场图层（忠实移植 leaflet-velocity / windy.js，对齐 typhoon.slt.zj.gov.cn）
 *
 * 层级结构（.amap-layers 栈内，底->顶）：底图 WebGL canvas(static) -> 背景填色(CustomLayer 50)
 *   -> 粒子流线(60) -> 台风自绘矢量(TyphoonLayer CustomLayer 110) -> markers(120) -> info，
 *   台风元素始终在风场之上。
 * - 背景填色层：用 AMap.CustomLayer 注册进高德图层栈（zIndex 50，低于矢量）；
 *   容器须 pointer-events:none，否则拦截覆盖物点击命中；
 *   canvas 由 windy drawOverlay 绘制，高德负责合成。
 * - 粒子层：原生 canvas 在 start() 里插入 .amap-layers（inline zIndex 60，填色之上、矢量之下）。
 * - 投影用原生 Web Mercator (EPSG:3857) 由 map 的 center/zoom 推算，不调用高德投影 API；
 * - 地图拖动/缩放开始时停止动画并清屏，moveend/zoomend 后 debounce 750ms 重建风场。
 *
 * 引擎与数据格式 1:1 对齐官网，参数见 lib/windy.ts SITE_PARAMS。
 */
import { onUnmounted, ref, watch } from 'vue'
import { fetchGlobalWind, type WindDataSet } from '../api/windField'
import { Windy, SITE_PARAMS } from '../lib/windy'

const props = defineProps<{
  amap: any
  map: any
  enabled: boolean
}>()

const REDRAW_DELAY = 750 // 对齐 leaflet-velocity 的 onDrawLayer debounce

const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let windy: Windy | null = null
let moveTimer = 0
let resizeObserver: ResizeObserver | null = null
let aborted = false
// 背景填色层：动态创建 canvas，注册为高德 CustomLayer（zIndex 50，低于台风自绘层 110）。
// 挂载后容器须事件穿透（见 start()）。由 windy drawOverlay 绘制。
let bgCanvas: HTMLCanvasElement | null = null
let bgCustomLayer: any = null

// 缓存当前视口（moveend/resize 时刷新）。场重建期间 project/invert 只读这组值，
// 既避免每次插值都重算中心点世界像素，也保证整场投影自洽。
let vp = { s: 1, cx: 0, cy: 0, width: 0, height: 0 }

function refreshViewport() {
  const map = props.map
  if (!map) return
  const c = map.getCenter()
  const lng = typeof c.getLng === 'function' ? c.getLng() : c.lng
  const lat = typeof c.getLat === 'function' ? c.getLat() : c.lat
  const size = map.getSize()
  const s = Math.pow(2, map.getZoom())
  vp = {
    s,
    cx: ((lng + 180) / 360) * 256 * s,
    cy: ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * 256 * s,
    width: size.width,
    height: size.height,
  }
}

// (lat, lon) -> [x, y] 容器像素。原生 Web Mercator，以地图中心锚定容器中心。
function project(lat: number, lon: number): [number, number] {
  const { s, cx, cy, width, height } = vp
  const wx = ((lon + 180) / 360) * 256 * s
  const wy = ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * 256 * s
  return [wx - cx + width / 2, wy - cy + height / 2]
}

// (x, y) 容器像素 -> [lng, lat]
function invert(x: number, y: number): [number, number] {
  const { s, cx, cy, width, height } = vp
  const wx = x - width / 2 + cx
  const wy = y - height / 2 + cy
  const lon = (wx / (256 * s)) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / (256 * s)))) * 180) / Math.PI
  return [lon, lat]
}

function sizeCanvas() {
  const canvas = canvasRef.value
  if (!props.map || !canvas) return
  const size = props.map.getSize()
  // 仅在尺寸变化时重设（赋值会清空 canvas），避免每次都清屏
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width
    canvas.height = size.height
  }
  if (bgCanvas && (bgCanvas.width !== size.width || bgCanvas.height !== size.height)) {
    bgCanvas.width = size.width
    bgCanvas.height = size.height
  }
}

function clearCanvas() {
  const canvas = canvasRef.value
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (bgCanvas) {
    const bgCtx = bgCanvas.getContext('2d')
    if (bgCtx) bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height)
  }
}

function startWindy() {
  if (!windy || !props.map) return
  refreshViewport()
  const { width, height } = vp
  // 视口四角用原生 invert 推经纬度，保证 extent 与 project 同源（WGS84）
  const [wLng, nLat] = invert(0, 0)
  const [eLng, sLat] = invert(width, height)
  windy.start([[0, 0], [width, height]], width, height, [[wLng, sLat], [eLng, nLat]])
}

// 地图移动/缩放结束后，延迟重建风场（debounce），避免高频重建网格
function scheduleRestart() {
  if (moveTimer) clearTimeout(moveTimer)
  moveTimer = window.setTimeout(() => {
    moveTimer = 0
    windy?.stop()
    clearCanvas()
    startWindy()
  }, REDRAW_DELAY)
}

const onStop = () => {
  windy?.stop()
  clearCanvas()
}

async function start() {
  const map = props.map
  const amap = props.amap
  const canvas = canvasRef.value
  if (!map || !amap || !canvas || windy || !props.enabled) return

  let data: WindDataSet[]
  try {
    data = await fetchGlobalWind()
  } catch (err) {
    console.error('[WindFieldLayer] 数据加载失败:', err)
    return
  }
  if (aborted || !props.enabled) return

  ctx = canvas.getContext('2d')
  if (!ctx) return

  // 背景层：动态创建 canvas，注册为高德 CustomLayer（zIndex 50，底图之上、矢量之下）。
  // 挂载后容器须事件穿透、粒子 canvas 插入 .amap-layers，见 map.add 之后。
  // windy 场重建完成后触发 customLayer.render()，高德在 render 回调里调 redrawOverlay 绘制。
  const size = map.getSize()
  bgCanvas = document.createElement('canvas')
  bgCanvas.width = size.width
  bgCanvas.height = size.height
  bgCustomLayer = new amap.CustomLayer(bgCanvas, {
    zIndex: 50,
    zooms: [3, 18],
    render: () => {
      windy?.redrawOverlay()
    },
  })
  map.add(bgCustomLayer)
  // 填色层容器默认拦截鼠标，会影响覆盖物点击命中，须事件穿透。
  requestAnimationFrame(() => {
    const wrap = bgCanvas?.parentElement
    if (wrap) wrap.style.pointerEvents = 'none'
  })
  // 粒子层插入 .amap-layers 图层栈（z=60）：高于背景填色(50)、低于台风自绘矢量层
  // (110)/markers(120)/info，保证台风风圈、路径、信息在最上层。
  const layersEl = map.getContainer()?.querySelector('.amap-layers')
  if (layersEl && canvas.parentElement !== layersEl) {
    layersEl.appendChild(canvas)
    canvas.style.zIndex = '60'
  }

  windy = new Windy({
    canvas,
    overlayCanvas: bgCanvas,
    onOverlayDrawn: () => bgCustomLayer?.render?.(),
    data,
    project,
    invert,
    ...SITE_PARAMS,
  })

  map.on('dragstart', onStop)
  map.on('zoomstart', onStop)
  map.on('moveend', scheduleRestart)
  map.on('zoomend', scheduleRestart)

  resizeObserver = new ResizeObserver(() => {
    sizeCanvas()
    scheduleRestart()
  })
  resizeObserver.observe(canvas)

  sizeCanvas()
  startWindy()
}

function stop() {
  aborted = true
  const map = props.map
  if (map) {
    map.off('dragstart', onStop)
    map.off('zoomstart', onStop)
    map.off('moveend', scheduleRestart)
    map.off('zoomend', scheduleRestart)
  }
  if (moveTimer) {
    clearTimeout(moveTimer)
    moveTimer = 0
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  // 先停动画、移除图层，确保此后没有任何回调能再往背景 canvas 上绘制
  windy?.stop()
  windy = null
  if (map && bgCustomLayer) {
    map.remove(bgCustomLayer)
    bgCustomLayer = null
  }
  // 必须在 bgCanvas 置空前清屏，否则 clearCanvas 拿不到背景 canvas，背景残留
  clearCanvas()
  // 高德移除 CustomLayer 后 canvas 元素可能仍留在 DOM 中，手动移除兜底
  bgCanvas?.remove()
  bgCanvas = null
  ctx = null
}

function draw() {
  stop()
  aborted = false
  const { map, enabled } = props
  if (!map || !enabled) return
  start()
}

watch([() => props.map, () => props.enabled], draw)
onUnmounted(stop)
</script>

<template>
  <canvas ref="canvasRef" class="wind-canvas" />
</template>
