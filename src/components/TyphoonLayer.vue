<script setup lang="ts">
/**
 * 台风自绘图层（spec §6）
 * 实测路径(实线)、预报路径(虚线)、多档四象限风圈(七/十/十二级，花瓣多边形嵌套)、
 * 路径点/预报点、当前中心(脉冲)、点选 InfoWindow。
 *
 * 重要：高德 2.0 把矢量覆盖物(Polyline/Polygon/CircleMarker)与底图合成在同一张
 * WebGL canvas（.amap-layers 内 static 元素，永远垫底）里绘制，JS 侧
 * VectorLayer 的 zIndex 不产生真实 DOM 层叠——任何盖在底图上的图层（风场填色 50 /
 * 粒子 60）都会把台风路径、风圈埋住。因此矢量元素改为自绘到独立 CustomLayer canvas
 * （zIndex 110：风场粒子之上、中心 marker 120 / InfoWindow 之下），保证台风元素
 * 始终在最上层；路径点点击用 map click + 像素命中（dotHits）。
 * 沿海警戒线同属矢量，一并自绘到该层。数据源不含误差圈字段，故无误差圈图层。
 */
import { onUnmounted, watch } from 'vue'
import type { NormalizedTyphoon, TyphoonPoint, WindCircle } from '../types/typhoon'
import { levelForCode } from '../constants/levels'
import { WIND_CIRCLE_LEVELS } from '../constants/windCircles'
import { GUARD_LINE_24H, GUARD_LINE_48H } from '../data/guardLines'

const props = defineProps<{
  amap: any
  map: any
  typhoons: NormalizedTyphoon[]
  selectedId: string | null
}>()

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let vecLayer: any = null
let centerMarkers: any[] = []
// 每帧重建：路径点/预报点的容器像素位置，供 map click 命中弹详情
let dotHits: { x: number; y: number; point: TyphoonPoint }[] = []

// —— Web Mercator 投影：米坐标系下画 km 半径才精确 ——
const R = 6378137
function lngLatToMeters(lng: number, lat: number): [number, number] {
  const x = ((lng * Math.PI) / 180) * R
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R
  return [x, y]
}
function metersToLngLat(x: number, y: number): [number, number] {
  const lng = (x / R) * (180 / Math.PI)
  const lat = Math.atan(Math.exp(y / R)) * (360 / Math.PI) - 90
  return [lng, lat]
}
/**
 * 风圈花瓣：中心 + 四象限半径(km)。
 * 画法对齐中央气象台台风网 leaflet-typhoon.min.js 的 getPathString：每个象限用各自
 * 恒定半径画一段 90° 弧，象限交界处(正北/东/南/西)半径直接跳变 → 折角花瓣(非平滑椭圆)。
 * deg→方位：0=北 90=东 180=南 270=西；故 0-90=NE 90-180=SE 180-270=SW 270-360=NW。
 */
function windCirclePath(centerLng: number, centerLat: number, c: WindCircle): [number, number][] {
  const [cx, cy] = lngLatToMeters(centerLng, centerLat)
  const STEPS = 16 // 每象限弧段数(折线近似台风网的 SVG 圆弧)
  const quads: ReadonlyArray<{ from: number; r: number }> = [
    { from: 0, r: c.ne },
    { from: 90, r: c.se },
    { from: 180, r: c.sw },
    { from: 270, r: c.nw },
  ]
  const pts: [number, number][] = []
  for (const q of quads) {
    for (let i = 0; i <= STEPS; i++) {
      const rad = ((q.from + 90 * (i / STEPS)) * Math.PI) / 180
      pts.push(metersToLngLat(cx + Math.sin(rad) * q.r * 1000, cy + Math.cos(rad) * q.r * 1000))
    }
  }
  return pts
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 当前中心"最新位置"文案，格式对齐台风网 gis.js：
 * 月/日不补零、时补零、整点不带分(如 8月5日 14时 / 8月5日 14时30分)。
 */
function fmtLatest(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const min = d.getMinutes()
  return `最新位置：${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}时${min === 0 ? '' : p(min) + '分'}`
}

function openInfo(point: TyphoonPoint) {
  const { amap, map } = props
  if (!amap || !map) return
  const lv = levelForCode(point.level)
  const content = `
    <div class="tc-info">
      <div class="tc-info-lv" style="background:${lv.color}">${lv.name}</div>
      <div class="tc-info-row"><span>时间</span><b>${fmtTime(point.time)}</b></div>
      <div class="tc-info-row"><span>位置</span><b>${point.lat.toFixed(1)}°N ${point.lng.toFixed(1)}°E</b></div>
      <div class="tc-info-row"><span>风速</span><b>${point.wind} m/s</b></div>
      <div class="tc-info-row"><span>气压</span><b>${point.pressure} hPa</b></div>
      ${point.forecast ? `<div class="tc-info-row"><span>预报</span><b>+${point.forecast.hours}h</b></div>` : ''}
    </div>`
  closeInfo()
  const iw = new amap.InfoWindow({
    content,
    isCustom: true,
    offset: new amap.Pixel(0, -14),
    autoMove: true,
  })
  iw.open(map, [point.lng, point.lat])
  infoWindow = iw
  // 点击弹窗内容不关闭：阻止其 click 冒泡到地图（否则 map click 会误关弹窗）
  requestAnimationFrame(() => {
    const wrap = map.getContainer?.()
    const contentEl = wrap?.querySelector?.('.amap-info-content')
    contentEl?.addEventListener?.('click', (e: Event) => e.stopPropagation())
  })
}
let infoWindow: any = null
function closeInfo() {
  infoWindow?.close?.()
  infoWindow = null
}

// (lng, lat) -> 容器像素
function p2c(lng: number, lat: number): [number, number] {
  const pt = props.map.lngLatToContainer([lng, lat])
  return [pt.x, pt.y]
}

function strokeLngLatPath(pts: [number, number][], color: string, width: number, alpha: number, dash: number[]) {
  const c = ctx
  if (!c || pts.length < 2) return
  c.beginPath()
  pts.forEach((p, i) => {
    const [x, y] = p2c(p[0], p[1])
    if (i === 0) c.moveTo(x, y)
    else c.lineTo(x, y)
  })
  c.globalAlpha = alpha
  c.strokeStyle = color
  c.lineWidth = width
  c.setLineDash(dash)
  c.stroke()
  c.setLineDash([])
  c.globalAlpha = 1
}

function fillLngLatPath(pts: [number, number][], fill: string, stroke: string) {
  const c = ctx
  if (!c || pts.length < 3) return
  c.beginPath()
  pts.forEach((p, i) => {
    const [x, y] = p2c(p[0], p[1])
    if (i === 0) c.moveTo(x, y)
    else c.lineTo(x, y)
  })
  c.closePath()
  c.fillStyle = fill
  c.fill()
  c.strokeStyle = stroke
  c.lineWidth = 1
  c.stroke()
}

function dot(lng: number, lat: number, r: number, point: TyphoonPoint) {
  if (!ctx) return
  const [x, y] = p2c(lng, lat)
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = levelForCode(point.level).color
  ctx.fill()
  ctx.strokeStyle = '#0a1424'
  ctx.lineWidth = 1
  ctx.stroke()
  dotHits.push({ x, y, point })
}

function drawTyphoon(t: NormalizedTyphoon) {
  // 实测路径（按强度分段着色，每段颜色 = 该段起点强度色，与路径点同色标）
  for (let i = 1; i < t.path.length; i++) {
    strokeLngLatPath(
      [
        [t.path[i - 1].lng, t.path[i - 1].lat],
        [t.path[i].lng, t.path[i].lat],
      ],
      levelForCode(t.path[i - 1].level).color,
      3,
      0.9,
      []
    )
  }
  // 预报路径（虚线，按强度分段着色，与实测路径同色标）——从当前中心连出，与实测路径终点衔接
  // （预报点从 +12h 开始，若不前置当前中心，实线与虚线之间会有视觉断口）
  const curCenter = t.path[t.path.length - 1]
  if (t.forecast.length >= 2) {
    const chain: TyphoonPoint[] = curCenter ? [curCenter, ...t.forecast] : [...t.forecast]
    for (let i = 1; i < chain.length; i++) {
      strokeLngLatPath(
        [
          [chain[i - 1].lng, chain[i - 1].lat],
          [chain[i].lng, chain[i].lat],
        ],
        levelForCode(chain[i - 1].level).color,
        2.5,
        0.7,
        [8, 6]
      )
    }
  }
  // 风圈（最新实测点的多档四象限，花瓣形嵌套：七级最外最淡 -> 十二级最内最深）
  const last = t.path[t.path.length - 1]
  if (last?.windCircles) {
    for (const c of last.windCircles) {
      const lv = WIND_CIRCLE_LEVELS.find((l) => l.code === c.level)
      if (lv) fillLngLatPath(windCirclePath(last.lng, last.lat, c), lv.fill, lv.stroke)
    }
  }
  // 路径点 / 预报点（点击弹详情）
  for (const p of t.path) dot(p.lng, p.lat, 4, p)
  for (const p of t.forecast) dot(p.lng, p.lat, 3, p)
}

// CustomLayer render 回调：高德每帧调用，拖动/缩放期间也跟随重绘
function drawFrame() {
  const { map, typhoons, selectedId } = props
  if (!map || !canvas) return
  const size = map.getSize()
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width
    canvas.height = size.height
  }
  if (!ctx) ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  dotHits = []
  // 24h / 48h 沿海警戒线（CMA 固定折线，与具体台风无关，常驻）
  strokeLngLatPath(GUARD_LINE_24H, '#FFFF00', 1.5, 0.85, [])
  strokeLngLatPath(GUARD_LINE_48H, '#FFFF00', 1.5, 0.85, [6, 4])
  // 选中某台风则只画它，否则画全部
  const toDraw = selectedId ? typhoons.filter((t) => t.id === selectedId) : typhoons
  for (const t of toDraw) drawTyphoon(t)
}

// 路径点点击：map click 像素命中 dotHits（自绘 canvas 事件穿透，click 由地图派发）
function onMapClick(e: any) {
  const px = e.pixel?.x
  const py = e.pixel?.y
  if (typeof px !== 'number' || typeof py !== 'number') return
  let best: { x: number; y: number; point: TyphoonPoint } | null = null
  let bestD = 8 // 半径 4/3 + 命中余量
  for (const d of dotHits) {
    const dist = Math.hypot(d.x - px, d.y - py)
    if (dist <= bestD) {
      best = d
      bestD = dist
    }
  }
  // 命中路径点弹详情；未命中视为点击弹窗外区域 → 关闭弹窗
  if (best) openInfo(best.point)
  else closeInfo()
}

// 当前中心（脉冲标记，DOM marker z=120，本就在最上层）
function syncMarkers() {
  const { amap, map, typhoons, selectedId } = props
  if (map && centerMarkers.length) map.remove(centerMarkers)
  centerMarkers = []
  if (!amap || !map) return
  const toDraw = selectedId ? typhoons.filter((t) => t.id === selectedId) : typhoons
  for (const t of toDraw) {
    const last = t.path[t.path.length - 1]
    if (!last) continue
    const marker = new amap.Marker({
      position: [last.lng, last.lat],
      content: `<div class="tc-center"><div class="tc-pulse"><span></span><span></span></div><div class="tc-latest">${fmtLatest(last.time)}</div></div>`,
      anchor: 'center',
      zIndex: 120,
    })
    marker.on('click', () => openInfo(last))
    centerMarkers.push(marker)
  }
  map.add(centerMarkers)
  // 仅选中某台风时聚焦其路径范围（避开左上/底部玻璃浮层）；无选中时保持初始视图
  if (selectedId && toDraw.some((t) => t.path.length || t.forecast.length)) {
    map.setFitView(null, false, [130, 60, 170, 230], 6)
  }
}

function ensureLayer() {
  const { amap, map } = props
  if (!amap || !map || vecLayer) return
  const size = map.getSize()
  canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  vecLayer = new amap.CustomLayer(canvas, {
    zIndex: 110, // 风场粒子(60)之上、中心 marker(120)/InfoWindow 之下
    zooms: [3, 18],
    render: drawFrame,
  })
  map.add(vecLayer)
  // 图层容器默认拦截鼠标，须事件穿透，否则地图拖动/点击失效
  requestAnimationFrame(() => {
    const wrap = canvas?.parentElement
    if (wrap) wrap.style.pointerEvents = 'none'
  })
  map.on('click', onMapClick)
  syncMarkers()
}

function teardown() {
  const { map } = props
  if (map) {
    map.off('click', onMapClick)
    if (centerMarkers.length) map.remove(centerMarkers)
    if (vecLayer) map.remove(vecLayer)
  }
  centerMarkers = []
  vecLayer = null
  canvas?.remove()
  canvas = null
  ctx = null
  dotHits = []
  closeInfo()
}

watch([() => props.amap, () => props.map], () => {
  teardown()
  ensureLayer()
})
watch([() => props.typhoons, () => props.selectedId], () => {
  syncMarkers()
  drawFrame()
})

onUnmounted(teardown)

defineExpose({})
</script>

<template>
  <div class="typhoon-layer" />
</template>
