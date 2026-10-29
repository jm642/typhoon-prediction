<script setup lang="ts">
/**
 * 台风自绘图层（spec §6）
 * 实测路径(实线)、预报路径(虚线)、多档四象限风圈(七/十/十二级，花瓣多边形嵌套)、
 * 路径点/预报点、当前中心(脉冲)、登陆点标注(由轨迹推断，见 src/lib/landfall.ts)、点选 InfoWindow。
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
import { detectLandfalls, type LandfallPoint } from '../lib/landfall'
import { fmtShort } from '../lib/format'

const props = defineProps<{
  amap: any
  map: any
  typhoons: NormalizedTyphoon[]
  selectedId: string | null
  /** 路径回放游标（实测路径下标）；null = 实时态（画完整路径 + 预报） */
  frameIndex: number | null
  /** 强度曲线 hover 的时间戳，对应路径点画高亮环 */
  highlightTime: number | null
}>()

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let vecLayer: any = null
let centerMarkers: any[] = []
// 登陆点 DOM marker（z=115：自绘矢量层 110 之上、当前中心 120 之下）
let landfallMarkers: any[] = []
// 登陆点推断结果缓存（按台风 id，数据变化时重建）
const landfallCache = new Map<string, LandfallPoint[]>()
// 预报轨迹推断的「预计登陆点」
const forecastLandfallCache = new Map<string, LandfallPoint[]>()
// 每帧重建：路径点/预报点的容器像素位置，供 map click 命中弹详情
let dotHits: { x: number; y: number; point: TyphoonPoint }[] = []
// 上次已聚焦的台风 id：只在选中项变化时 setBounds，避免刷新/自动更新打断用户视角
let focusedId: string | null = null
// 首次拿到数据时自动定位到活跃台风（之后刷新/轮询不再抢视角）
let autoFitted = false

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

/**
 * 当前中心"最新位置"文案，格式对齐台风网 gis.js：
 * 月/日不补零、时补零、整点不带分(如 8月5日 14时 / 8月5日 14时30分)。
 * 手机窄屏用 compact 去掉「最新位置：」前缀，否则台风贴近屏幕边缘时标签被截断。
 */
function fmtLatest(ms: number, compact = false): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const min = d.getMinutes()
  const text = `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}时${min === 0 ? '' : p(min) + '分'}`
  return compact ? text : `最新位置：${text}`
}

/** 回放游标裁剪后的实测路径；实时态返回完整路径 */
function framePath(t: NormalizedTyphoon): TyphoonPoint[] {
  const i = props.frameIndex
  if (i == null) return t.path
  return t.path.slice(0, Math.min(i + 1, t.path.length))
}

/** 打开自定义 InfoWindow（点击弹窗内容不关闭，防止 map click 误关） */
function showInfo(content: string, lng: number, lat: number) {
  const { amap, map } = props
  if (!amap || !map) return
  closeInfo()
  const iw = new amap.InfoWindow({
    content,
    isCustom: true,
    offset: new amap.Pixel(0, -14),
    autoMove: true,
  })
  iw.open(map, [lng, lat])
  infoWindow = iw
  // 点击弹窗内容不关闭：阻止其 click 冒泡到地图（否则 map click 会误关弹窗）
  requestAnimationFrame(() => {
    const wrap = map.getContainer?.()
    const contentEl = wrap?.querySelector?.('.amap-info-content')
    contentEl?.addEventListener?.('click', (e: Event) => e.stopPropagation())
  })
}

function openInfo(point: TyphoonPoint) {
  const lv = levelForCode(point.level, point.wind)
  const content = `
    <div class="tc-info">
      <div class="tc-info-lv" style="background:${lv.color}">${lv.name}</div>
      <div class="tc-info-row"><span>时间</span><b>${fmtShort(point.time)}</b></div>
      <div class="tc-info-row"><span>位置</span><b>${point.lat.toFixed(1)}°N ${point.lng.toFixed(1)}°E</b></div>
      <div class="tc-info-row"><span>风速</span><b>${point.wind} m/s</b></div>
      <div class="tc-info-row"><span>气压</span><b>${point.pressure} hPa</b></div>
      ${point.forecast ? `<div class="tc-info-row"><span>预报</span><b>+${point.forecast.hours}h</b></div>` : ''}
    </div>`
  showInfo(content, point.lng, point.lat)
}

/** 登陆点详情弹窗（predicted = 由预报轨迹推断的预计登陆） */
function openLandfallInfo(lf: LandfallPoint, predicted = false) {
  const content = `
    <div class="tc-info">
      <div class="tc-info-lv" style="background:${predicted ? '#0ea5e9' : '#ef4444'}">${predicted ? '预计登陆' : '登陆点'}</div>
      <div class="tc-info-row"><span>时间</span><b>${predicted ? '预计 ' : ''}${fmtShort(lf.time)}</b></div>
      <div class="tc-info-row"><span>位置</span><b>${lf.lat.toFixed(1)}°N ${lf.lng.toFixed(1)}°E</b></div>
    </div>`
  showInfo(content, lf.lng, lf.lat)
}

/** 风圈详情弹窗（点击风圈内部触发） */
function openCircleInfo(circle: WindCircle, point: TyphoonPoint) {
  const lv = WIND_CIRCLE_LEVELS.find((l) => l.code === circle.level)
  const content = `
    <div class="tc-info">
      <div class="tc-info-lv" style="background:${lv?.stroke ?? '#F4D000'};color:#1a1205">${lv?.name ?? circle.level}</div>
      <div class="tc-info-row"><span>东北</span><b>${circle.ne} km</b></div>
      <div class="tc-info-row"><span>东南</span><b>${circle.se} km</b></div>
      <div class="tc-info-row"><span>西南</span><b>${circle.sw} km</b></div>
      <div class="tc-info-row"><span>西北</span><b>${circle.nw} km</b></div>
      <div class="tc-info-row"><span>时次</span><b>${fmtShort(point.time)}</b></div>
    </div>`
  showInfo(content, point.lng, point.lat)
}

/** 点在多边形内（容器像素坐标） */
function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 命中当前帧的风圈（由内向外优先：点在核心区时报告最强档） */
function hitWindCircle(x: number, y: number): { circle: WindCircle; point: TyphoonPoint } | null {
  const { typhoons, selectedId } = props
  const list = selectedId ? typhoons.filter((t) => t.id === selectedId) : typhoons
  for (const t of list) {
    const pts = framePath(t)
    const last = pts[pts.length - 1]
    const circles = last?.windCircles
    if (!circles?.length) continue
    for (let i = circles.length - 1; i >= 0; i--) {
      const poly = windCirclePath(last.lng, last.lat, circles[i]).map(([lng, lat]) => p2c(lng, lat))
      if (pointInPolygon(x, y, poly)) return { circle: circles[i], point: last }
    }
  }
  return null
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
  ctx.fillStyle = levelForCode(point.level, point.wind).color
  ctx.fill()
  ctx.strokeStyle = '#0a1424'
  ctx.lineWidth = 1
  ctx.stroke()
  dotHits.push({ x, y, point })
}

function drawTyphoon(t: NormalizedTyphoon) {
  const path = framePath(t)
  // 实测路径（按强度分段着色，每段颜色 = 该段起点强度色，与路径点同色标）
  for (let i = 1; i < path.length; i++) {
    strokeLngLatPath(
      [
        [path[i - 1].lng, path[i - 1].lat],
        [path[i].lng, path[i].lat],
      ],
      levelForCode(path[i - 1].level, path[i - 1].wind).color,
      3,
      0.9,
      []
    )
  }
  const curCenter = path[path.length - 1]
  // 预报路径（虚线，按强度分段着色）——从当前中心连出，与实测路径终点衔接
  // （预报点从 +12h 开始，若不前置当前中心，实线与虚线之间会有视觉断口）
  // 回放时隐藏预报（那是「未来」）；主机构按强度着色，其他机构用中性虚线便于对比
  if (props.frameIndex == null) {
    if (t.forecast.length >= 2) {
      const chain: TyphoonPoint[] = curCenter ? [curCenter, ...t.forecast] : [...t.forecast]
      for (let i = 1; i < chain.length; i++) {
        strokeLngLatPath(
          [
            [chain[i - 1].lng, chain[i - 1].lat],
            [chain[i].lng, chain[i].lat],
          ],
          levelForCode(chain[i - 1].level, chain[i - 1].wind).color,
          2.5,
          0.7,
          [8, 6]
        )
      }
    }
    for (const series of t.forecasts) {
      if (series.agency === t.primaryAgency || series.points.length < 2) continue
      const chain: TyphoonPoint[] = curCenter
        ? [curCenter, ...series.points]
        : [...series.points]
      for (let i = 1; i < chain.length; i++) {
        strokeLngLatPath(
          [
            [chain[i - 1].lng, chain[i - 1].lat],
            [chain[i].lng, chain[i].lat],
          ],
          '#94a3b8',
          1.5,
          0.55,
          [3, 5]
        )
      }
    }
  }
  // 风圈（当前帧中心的多档四象限，花瓣形嵌套：七级最外最淡 -> 十二级最内最深）
  if (curCenter?.windCircles) {
    for (const c of curCenter.windCircles) {
      const lv = WIND_CIRCLE_LEVELS.find((l) => l.code === c.level)
      if (lv) fillLngLatPath(windCirclePath(curCenter.lng, curCenter.lat, c), lv.fill, lv.stroke)
    }
  }
  // 路径点 / 预报点（点击弹详情）
  for (const p of path) dot(p.lng, p.lat, 4, p)
  if (props.frameIndex == null) for (const p of t.forecast) dot(p.lng, p.lat, 3, p)
}

// CustomLayer render 回调：高德每帧调用，拖动/缩放期间也跟随重绘
function drawFrame() {
  const { map, typhoons, selectedId } = props
  if (!map || !canvas) return
  const size = map.getSize()
  // 位图按 devicePixelRatio 放大、绘制坐标缩回 CSS 像素，否则高 dpr 屏路径发虚
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(size.width * dpr)
  const h = Math.round(size.height * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
  }
  if (!ctx) ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)
  dotHits = []
  // 24h / 48h 沿海警戒线（CMA 固定折线，与具体台风无关，常驻）
  strokeLngLatPath(GUARD_LINE_24H, '#FFFF00', 1.5, 0.85, [])
  strokeLngLatPath(GUARD_LINE_48H, '#FFFF00', 1.5, 0.85, [6, 4])
  // 选中某台风则只画它，否则画全部
  const toDraw = selectedId ? typhoons.filter((t) => t.id === selectedId) : typhoons
  for (const t of toDraw) drawTyphoon(t)
  // 强度曲线 hover 联动：高亮对应时次的路径点
  if (props.highlightTime != null) {
    for (const t of toDraw) {
      const p = t.path.find((q) => q.time === props.highlightTime)
      if (!p) continue
      const [x, y] = p2c(p.lng, p.lat)
      ctx.beginPath()
      ctx.arc(x, y, 9, 0, Math.PI * 2)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x, y, 13, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,.45)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
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
  // 命中路径点 → 点详情；否则命中风圈 → 风圈半径；都没命中 → 关闭弹窗
  if (best) {
    openInfo(best.point)
    return
  }
  const circleHit = hitWindCircle(px, py)
  if (circleHit) openCircleInfo(circleHit.circle, circleHit.point)
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
    const pts = framePath(t)
    const last = pts[pts.length - 1]
    if (!last) continue
    const compact = map.getSize().width <= 768
    const marker = new amap.Marker({
      position: [last.lng, last.lat],
      content: `<div class="tc-center"><div class="tc-pulse"><span></span><span></span></div><div class="tc-latest">${fmtLatest(last.time, compact)}</div></div>`,
      anchor: 'center',
      zIndex: 120,
    })
    marker.on('click', () => openInfo(last))
    centerMarkers.push(marker)
  }
  map.add(centerMarkers)
  // 选中项变化时聚焦一次；首次载入无选中时自动定位到活跃台风（避免打开页面看不到台风）。
  // 注意：轨迹是自绘 canvas，不是高德覆盖物，setFitView(null) 感知不到其范围；
  // 故按「路径 + 预报 + 登陆点」数据显式算包围盒再 setBounds 聚焦。
  if (selectedId) {
    // 只在真正移动了视野后才记为已聚焦：详情尚未返回时 toDraw 为空，
    // 若提前记账，数据到达后就不会再聚焦（表现为偶尔“点了没定位”）
    if (focusedId !== selectedId && focusOn(toDraw)) focusedId = selectedId
  } else {
    focusedId = null
    if (!autoFitted && focusOn(typhoons)) autoFitted = true
  }
}

/**
 * 视野避让：桌面给左上列表卡与底部卡片留边；手机给顶部细条与底部抽屉/工具条留边。
 * ⚠️ 避让总和必须明显小于容器尺寸——AMap 在可用区域过小时会算出错误中心
 * （手机 390px 宽沿用桌面的左右各 230/60 曾把镜头甩到北纬 73 度）。
 */
function focusPadding(size: { width: number; height: number }): [number, number, number, number] {
  if (size.width <= 768) {
    // 手机：顶部细条约 53px；底部抽屉(含回放条)+工具条约 250px
    return [Math.round(size.height * 0.08), 16, Math.round(size.height * 0.3), 16]
  }
  // 桌面：底部强度曲线卡约 248px、左侧列表卡约 298px，留边需覆盖它们
  return [130, 70, 250, 300]
}

/** 按给定台风的路径 + 预报 + 登陆点包围盒聚焦视野；返回是否真的移动了视野 */
function focusOn(list: NormalizedTyphoon[]): boolean {
  const { amap, map } = props
  if (!amap || !map || list.length === 0) return false
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const t of list) {
    for (const p of [...t.path, ...t.forecast]) {
      if (p.lng < minLng) minLng = p.lng
      if (p.lng > maxLng) maxLng = p.lng
      if (p.lat < minLat) minLat = p.lat
      if (p.lat > maxLat) maxLat = p.lat
    }
    for (const lf of [
      ...(landfallCache.get(t.id) ?? []),
      ...(forecastLandfallCache.get(t.id) ?? []),
    ]) {
      if (lf.lng < minLng) minLng = lf.lng
      if (lf.lng > maxLng) maxLng = lf.lng
      if (lf.lat < minLat) minLat = lf.lat
      if (lf.lat > maxLat) maxLat = lf.lat
    }
  }
  if (minLng === Infinity) return false
  // 轨迹跨 180° 经线时包围盒会横跨全球，聚焦反而更糟，保持当前视野
  if (maxLng - minLng > 180) return false

  // 自己算缩放与中心，不用 map.setBounds(..., avoid)：
  // AMap 在非对称留边（手机顶部细条 + 底部抽屉）下会把中心算偏——
  // 实测 bbox 中心 151.8°E 被放到了 122.6°E，非对称留边越大偏得越多。
  const size = map.getSize()
  const [top, right, bottom, left] = focusPadding(size)
  const availW = Math.max(size.width - left - right, 80)
  const availH = Math.max(size.height - top - bottom, 80)
  const mercY = (lat: number) =>
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2
  const lngSpanPx = ((maxLng - minLng) / 360) * 256
  const latSpanPx = Math.abs(mercY(minLat) - mercY(maxLat)) * 256
  const zoom = Math.min(
    Math.log2(availW / Math.max(lngSpanPx, 1e-6)),
    Math.log2(availH / Math.max(latSpanPx, 1e-6)),
    6, // 单条轨迹最多放大到 6 级
  )
  const clamped = Math.max(3, Math.min(zoom, 17))
  const worldPx = 256 * 2 ** clamped
  // 把 bbox 中心放到「可用区域」的中心（可用区域相对容器有偏移）
  const cx = left + availW / 2
  const cy = top + availH / 2
  const centerLng = (minLng + maxLng) / 2 - ((cx - size.width / 2) * 360) / worldPx
  const mercCenter = (mercY(minLat) + mercY(maxLat)) / 2 - (cy - size.height / 2) / worldPx
  const centerLat =
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercCenter))) * 180) / Math.PI
  map.setZoomAndCenter(clamped, [centerLng, centerLat])
  return true
}

/** 回放游标对应的时刻；实时态返回 Infinity（即展示全部已发生事件） */
function frameTimeLimit(): number {
  const { frameIndex, typhoons, selectedId } = props
  if (frameIndex == null) return Infinity
  const t = typhoons.find((x) => x.id === selectedId) ?? typhoons[0]
  const pts = t ? framePath(t) : []
  return pts.length ? pts[pts.length - 1].time : Infinity
}

// 登陆点标注（DOM marker z=115，位于自绘矢量层之上、当前中心之下）
function syncLandfallMarkers() {
  const { amap, map, typhoons, selectedId } = props
  if (map && landfallMarkers.length) map.remove(landfallMarkers)
  landfallMarkers = []
  if (!amap || !map) return
  const toDraw = selectedId ? typhoons.filter((t) => t.id === selectedId) : typhoons
  const limit = frameTimeLimit()
  const replaying = props.frameIndex != null
  for (const t of toDraw) {
    // 已发生的登陆点：回放时只显示游标之前的事件
    for (const lf of landfallCache.get(t.id) ?? []) {
      if (lf.time > limit) continue
      const marker = new amap.Marker({
        position: [lf.lng, lf.lat],
        content: `<div class="tc-landfall"><span class="tc-landfall-badge">⚓ 登陆</span><span class="tc-landfall-time">${fmtShort(lf.time)}</span></div>`,
        anchor: 'center',
        zIndex: 115,
      })
      marker.on('click', () => openLandfallInfo(lf))
      landfallMarkers.push(marker)
    }
    // 预计登陆点：回放「过去」时无意义，只在实时态显示
    if (replaying) continue
    for (const lf of forecastLandfallCache.get(t.id) ?? []) {
      const marker = new amap.Marker({
        position: [lf.lng, lf.lat],
        content: `<div class="tc-landfall"><span class="tc-landfall-badge tc-landfall-badge--forecast">⏱ 预计登陆</span><span class="tc-landfall-time tc-landfall-time--forecast">${fmtShort(lf.time)}</span></div>`,
        anchor: 'center',
        zIndex: 115,
      })
      marker.on('click', () => openLandfallInfo(lf, true))
      landfallMarkers.push(marker)
    }
  }
  if (landfallMarkers.length) map.add(landfallMarkers)
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
  syncLandfallMarkers()
}

function teardown() {
  const { map } = props
  if (map) {
    map.off('click', onMapClick)
    if (centerMarkers.length) map.remove(centerMarkers)
    if (landfallMarkers.length) map.remove(landfallMarkers)
    if (vecLayer) map.remove(vecLayer)
  }
  centerMarkers = []
  landfallMarkers = []
  landfallCache.clear()
  forecastLandfallCache.clear()
  focusedId = null
  autoFitted = false
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
  // 数据变化时重新推断登陆点（历史/实时详情都是静态快照，按 id 缓存）
  landfallCache.clear()
  forecastLandfallCache.clear()
  for (const t of props.typhoons) {
    landfallCache.set(t.id, detectLandfalls(t.path))
    // 预计登陆：把「当前中心 + 预报点」当成一条未来轨迹，复用同一套海陆二分
    const cur = t.path[t.path.length - 1]
    const future = cur ? [cur, ...t.forecast] : [...t.forecast]
    forecastLandfallCache.set(t.id, future.length > 1 ? detectLandfalls(future) : [])
  }
  syncMarkers()
  syncLandfallMarkers()
  drawFrame()
})

// 回放游标变化：中心标记/风圈/登陆点标注都要跟着走
watch([() => props.frameIndex], () => {
  syncMarkers()
  syncLandfallMarkers()
  drawFrame()
})

// 强度曲线 hover：只需重绘画布（高亮环）
watch([() => props.highlightTime], () => drawFrame())

onUnmounted(teardown)
</script>

<template>
  <div class="typhoon-layer" />
</template>
