/**
 * windy.js 风场粒子引擎 —— 忠实移植自 cambecc/earth（经 leaflet-velocity 封装）。
 * 消费 GRIB2JSON 数据集数组（U/V 分量），在 canvas 上渲染动画粒子流线。
 *
 * 与原版唯一差异：去掉 Leaflet 耦合。原版通过 params.map.latLngToContainerPoint /
 * containerPointToLatLng 做经纬度<->像素投影，这里改为由构造参数注入 project/invert
 * 两个纯函数，使引擎与地图库无关。
 *
 * 算法、常量、色标、参数语义均与源码 1:1 对齐，以保证视觉效果与官网一致。
 */

// -- GRIB2JSON 数据结构 --

export interface WindHeader {
  parameterCategory: number
  parameterNumber: number
  lo1: number
  la1: number
  dx: number
  dy: number
  nx: number
  ny: number
  scanMode?: number
  refTime?: string
  forecastTime?: number
  gridDefinitionTemplate?: number
}

export interface WindDataSet {
  header: WindHeader
  data: number[]
}

// (lat, lon) -> [x, y] 像素；对应原版 project(lat, lon)
export type ProjectFn = (lat: number, lon: number) => [number, number]
// (x, y) 像素 -> [lng, lat]；对应原版 invert(x, y)
export type InvertFn = (x: number, y: number) => [number, number]

export interface WindyParams {
  canvas: HTMLCanvasElement
  data: WindDataSet[]
  project: ProjectFn
  invert: InvertFn
  minVelocity?: number
  maxVelocity?: number
  velocityScale?: number
  particleAge?: number
  lineWidth?: number
  particleMultiplier?: number
  frameRate?: number
  colorScale?: string[]
  opacity?: number
  overlayCanvas?: HTMLCanvasElement
  overlayOpacity?: number
  scalarMin?: number
  scalarMax?: number
  scalarColorScale?: number[][]
  // 场重建完成、背景已可绘制时回调（供 CustomLayer 触发 render 合成）。
  onOverlayDrawn?: () => void
}

// 站点 velocityLayer 实际配置（逆向自 typhoon.slt.zj.gov.cn）。
// particleMultiplier / particleAge 取 leaflet-velocity 默认值（1/300、90），
// 原 1/180、500 会导致粒子数过多且存活 ~31s，是卡顿主因之一。
export const SITE_PARAMS = {
  maxVelocity: 70,
  particleMultiplier: 1 / 300,
  particleAge: 90,
  lineWidth: 1.5,
  frameRate: 16,
  velocityScale: 0.01,
} as const

// 像素风场插值步长（px）。越大重建越快、越粗糙；3px 视觉无损、invert 调用减 1/3。
const FIELD_STEP = 3

// 经典 15 色 windy.js 色标：蓝 -> 青 -> 绿 -> 黄 -> 橙 -> 红 -> 暗红
const DEFAULT_COLOR_SCALE = [
  'rgb(36,104, 180)', 'rgb(60,157, 194)', 'rgb(128,205,193)', 'rgb(151,218,168)',
  'rgb(198,231,181)', 'rgb(238,247,217)', 'rgb(255,238,159)', 'rgb(252,217,125)',
  'rgb(255,182,100)', 'rgb(252,150,75)', 'rgb(250,112,52)', 'rgb(245,64,32)',
  'rgb(237,45,28)', 'rgb(220,24,32)', 'rgb(180,0,35)',
]

// 风场背景色带（简化版）：低值深蓝 -> 青绿 -> 高值深绿，对应风速 0.01–30 m/s。
const SCALAR_COLOR_SCALE: number[][] = [
  [70, 90, 160], [90, 150, 200], [120, 190, 170], [60, 170, 90], [0, 100, 0],
]

const LUT_RESOLUTION = 256

// 把色带 stops 预烘焙成 256 项 RGBA 查找表，drawOverlay 逐像素查表写 imageData。
function buildScalarLUT(colors: number[][]): Uint8ClampedArray {
  const n = colors.length
  const lut = new Uint8ClampedArray(LUT_RESOLUTION * 4)
  for (let i = 0; i < LUT_RESOLUTION; i++) {
    const pos = (i / (LUT_RESOLUTION - 1)) * (n - 1)
    const j = Math.min(n - 2, Math.floor(pos))
    const f = pos - j
    const c0 = colors[j], c1 = colors[j + 1]
    lut[i * 4] = c0[0] + (c1[0] - c0[0]) * f
    lut[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * f
    lut[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * f
    lut[i * 4 + 3] = 255
  }
  return lut
}

const NULL_WIND_VECTOR: [number, number, null] = [NaN, NaN, null]

interface Particle {
  x: number
  y: number
  xt: number
  yt: number
  age: number
}

interface Bounds {
  x: number
  y: number
  xMax: number
  yMax: number
  width: number
  height: number
}

interface MapBounds {
  south: number
  north: number
  east: number
  west: number
  width: number
  height: number
}

// 预插值出的像素风场：field(x, y) -> [u, v, magnitude]，u/v 已是像素位移
type Field = ((x: number, y: number) => [number, number, number | null]) & {
  release: () => void
  randomize: (o: Particle) => Particle
}

function floorMod(a: number, n: number): number {
  return a - n * Math.floor(a / n)
}

function isValue(x: unknown): boolean {
  return x !== null && x !== undefined
}

function deg2rad(deg: number): number {
  return (deg / 180) * Math.PI
}

// 双线性插值向量（u, v, magnitude）
function bilinearInterpolateVector(
  x: number, y: number,
  g00: number[], g10: number[], g01: number[], g11: number[],
): [number, number, number] {
  const rx = 1 - x
  const ry = 1 - y
  const a = rx * ry, b = x * ry, c = rx * y, d = x * y
  const u = g00[0] * a + g10[0] * b + g01[0] * c + g11[0] * d
  const v = g00[1] * a + g10[1] * b + g01[1] * c + g11[1] * d
  return [u, v, Math.sqrt(u * u + v * v)]
}

export class Windy {
  private params: WindyParams
  private MIN_VELOCITY_INTENSITY: number
  private MAX_VELOCITY_INTENSITY: number
  private VELOCITY_SCALE: number
  private MAX_PARTICLE_AGE: number
  private PARTICLE_LINE_WIDTH: number
  private PARTICLE_MULTIPLIER: number
  private PARTICLE_REDUCTION: number
  private FRAME_RATE: number
  private FRAME_TIME: number
  private OPACITY: number
  private OVERLAY_OPACITY: number
  private overlayCanvas: HTMLCanvasElement | null
  private SCALAR_MIN: number
  private SCALAR_MAX: number
  private scalarLUT: Uint8ClampedArray
  private colorScale: string[]

  private gridData: WindDataSet[]
  private builder: { header: WindHeader; data: (i: number) => number[]; interpolate: typeof bilinearInterpolateVector } | null = null
  private grid: number[][][] | null = null
  private λ0 = 0
  private φ0 = 0
  private Δλ = 0
  private Δφ = 0
  private ni = 0
  private nj = 0
  private date: Date | null = null
  private field: Field | null = null
  private overlayBounds: Bounds | null = null
  private onOverlayDrawn: (() => void) | null
  private animationLoop = 0
  // 代际令牌：每次 stop() 自增，使上一代在途的场重建 / 动画循环自行终止，
  // 避免多次 moveend 后多套 setTimeout 链与 rAF 循环堆积（卡顿主因）。
  private generation = 0

  constructor(params: WindyParams) {
    this.params = params
    this.gridData = params.data
    this.MIN_VELOCITY_INTENSITY = params.minVelocity ?? 0
    this.MAX_VELOCITY_INTENSITY = params.maxVelocity ?? 10
    // velocityScale 随 dpr^(1/3) 缩放（原版完全任意，此值观感好）
    this.VELOCITY_SCALE = (params.velocityScale ?? 0.005) * (Math.pow(window.devicePixelRatio, 1 / 3) || 1)
    this.MAX_PARTICLE_AGE = params.particleAge ?? 90
    this.PARTICLE_LINE_WIDTH = params.lineWidth ?? 1
    this.PARTICLE_MULTIPLIER = params.particleMultiplier ?? 1 / 300
    this.PARTICLE_REDUCTION = Math.pow(window.devicePixelRatio, 1 / 3) || 1.6
    this.FRAME_RATE = params.frameRate ?? 15
    this.FRAME_TIME = 1000 / this.FRAME_RATE
    this.OPACITY = params.opacity ?? 0.97
    // 官网 Scalar 引擎 alpha=Math.floor(204)（≈0.8 不透明），底图透出 ~20% 使海岸线隐约可见
    this.OVERLAY_OPACITY = params.overlayOpacity ?? 204 / 255
    this.overlayCanvas = params.overlayCanvas ?? null
    this.SCALAR_MIN = params.scalarMin ?? 0.01
    this.SCALAR_MAX = params.scalarMax ?? 30
    this.scalarLUT = buildScalarLUT(params.scalarColorScale ?? SCALAR_COLOR_SCALE)
    this.onOverlayDrawn = params.onOverlayDrawn ?? null
    this.colorScale = params.colorScale ?? DEFAULT_COLOR_SCALE
  }

  // -- 构建 wind builder：按 parameterCategory,parameterNumber 匹配 U/V --
  private createBuilder(data: WindDataSet[]) {
    let uComp: WindDataSet | null = null
    let vComp: WindDataSet | null = null
    for (const record of data) {
      switch (record.header.parameterCategory + ',' + record.header.parameterNumber) {
        case '1,2':
        case '2,2':
          uComp = record
          break
        case '1,3':
        case '2,3':
          vComp = record
          break
      }
    }
    if (!uComp || !vComp) {
      console.log('Windy Error: data must have at least two components (u,v)')
    }
    const uData = uComp!.data
    const vData = vComp!.data
    return {
      header: uComp!.header,
      data: (i: number) => [uData[i], vData[i]],
      interpolate: bilinearInterpolateVector,
    }
  }

  // -- 构建网格：解析 header，连续网格首列复制到末列以简化经度环绕插值 --
  private buildGrid(callback: (grid: { date: Date; interpolate: (lng: number, lat: number) => [number, number, number] | null }) => void) {
    let supported = true
    if (this.gridData.length < 2) supported = false
    if (!supported) console.log('Windy Error: data must have at least two components (u,v)')

    this.builder = this.createBuilder(this.gridData)
    const header = this.builder.header
    if (header.gridDefinitionTemplate !== undefined && header.gridDefinitionTemplate !== 0) {
      console.log('Windy Error: Only data with Latitude_Longitude coordinates is supported')
    }

    this.λ0 = header.lo1
    this.φ0 = header.la1 // 网格原点（如 0°E, 90°N）
    this.Δλ = header.dx
    this.Δφ = header.dy // 网格点间距（度）
    this.ni = header.nx
    this.nj = header.ny // W-E / N-S 网格点数

    if (header.scanMode !== undefined) {
      const mask = ('0' + header.scanMode.toString(2)).slice(-8).split('').map((c) => c === '1')
      if (mask[0]) this.Δλ = -this.Δλ
      if (mask[1]) this.Δφ = -this.Δφ
      if (mask.slice(2).some(Boolean)) {
        console.log('Windy Error: Data with scanMode: ' + header.scanMode + ' is not supported.')
      }
    }

    this.date = header.refTime ? new Date(header.refTime) : new Date()
    if (header.forecastTime) this.date.setHours(this.date.getHours() + header.forecastTime)

    const grid: number[][][] = []
    const builder = this.builder
    let p = 0
    // 连续网格（经度跨度 >= 360°）-> 复制首列为末列，使环绕插值无需特判
    const isContinuous = Math.floor(this.ni * this.Δλ) >= 360

    for (let j = 0; j < this.nj; j++) {
      const row: number[][] = []
      for (let i = 0; i < this.ni; i++, p++) {
        row[i] = builder.data(p)
      }
      if (isContinuous) row.push(row[0])
      grid[j] = row
    }
    this.grid = grid

    callback({ date: this.date, interpolate: (lng, lat) => this.interpolate(lng, lat) })
  }

  // -- 经纬度 -> 风向量 [u, v, magnitude]（floorMod 处理全球经度环绕）--
  private interpolate(λ: number, φ: number): [number, number, number] | null {
    const grid = this.grid
    if (!grid) return null
    const i = floorMod(λ - this.λ0, 360) / this.Δλ // 经度索引，环绕到 [0, 360)
    const j = (this.φ0 - φ) / this.Δφ // 纬度索引，+90 -> -90 方向

    const fi = Math.floor(i)
    const ci = fi + 1
    const fj = Math.floor(j)
    const cj = fj + 1
    let row = grid[fj]
    if (row) {
      const g00 = row[fi]
      const g10 = row[ci]
      if (isValue(g00) && isValue(g10) && (row = grid[cj])) {
        const g01 = row[fi]
        const g11 = row[ci]
        if (isValue(g01) && isValue(g11)) {
          return this.builder!.interpolate(i - fi, j - fj, g00, g10, g01, g11)
        }
      }
    }
    return null
  }

  // -- 投影畸变：在 (x,y) 处对地图投影求 Jacobian，修正高纬 Mercator 拉伸 --
  private distortion(λ: number, φ: number, x: number, y: number): [number, number, number, number] {
    const τ = 2 * Math.PI
    const H = 5
    const hλ = λ < 0 ? H : -H
    const hφ = φ < 0 ? H : -H
    const pλ = this.params.project(φ, λ + hλ)
    const pφ = this.params.project(φ + hφ, λ)
    // 经线方向比例因子（Snyder 4-3，R=1），消除两极挤捏
    const k = Math.cos((φ / 360) * τ)
    return [(pλ[0] - x) / hλ / k, (pλ[1] - y) / hλ / k, (pφ[0] - x) / hφ, (pφ[1] - y) / hφ]
  }

  private distort(λ: number, φ: number, x: number, y: number, scale: number, wind: [number, number, number]): [number, number, number] {
    const u = wind[0] * scale
    const v = wind[1] * scale
    const d = this.distortion(λ, φ, x, y)
    wind[0] = d[0] * u + d[2] * v
    wind[1] = d[1] * u + d[3] * v
    return wind
  }

  // -- 把预插值出的 columns 包成 field 对象 --
  private createField(columns: Array<Array<[number, number, number] | undefined>>, bounds: Bounds, callback: (bounds: Bounds, field: Field) => void) {
    const field = ((x: number, y: number): [number, number, number | null] => {
      const column = columns[Math.round(x)]
      return (column && column[Math.round(y)]) || NULL_WIND_VECTOR
    }) as Field
    field.release = () => {
      columns = []
    }
    field.randomize = (o: Particle) => {
      let safetyNet = 0
      let x: number, y: number
      do {
        x = Math.round(Math.floor(Math.random() * bounds.width) + bounds.x)
        y = Math.round(Math.floor(Math.random() * bounds.height) + bounds.y)
      } while (field(x, y)[2] === null && safetyNet++ < 30)
      o.x = x
      o.y = y
      return o
    }
    callback(bounds, field)
  }

  private buildBounds(bounds: number[][], width: number, height: number): Bounds {
    const upperLeft = bounds[0]
    const lowerRight = bounds[1]
    const x = Math.round(upperLeft[0])
    const y = Math.max(Math.floor(upperLeft[1]), 0)
    const yMax = Math.min(Math.ceil(lowerRight[1]), height - 1)
    return { x, y, xMax: width, yMax, width, height }
  }

  // -- 逐列插值出像素风场：2px 步长，1000ms 时间预算让出主线程 --
  private interpolateField(grid: { interpolate: (lng: number, lat: number) => [number, number, number] | null }, bounds: Bounds, extent: MapBounds, callback: (bounds: Bounds, field: Field) => void) {
    const mapArea = (extent.south - extent.north) * (extent.west - extent.east)
    const velocityScale = this.VELOCITY_SCALE * Math.pow(mapArea, 0.4)
    const columns: Array<Array<[number, number, number] | undefined>> = []
    const gen = this.generation
    let x = bounds.x

    const interpolateColumn = (x: number) => {
      const column: Array<[number, number, number] | undefined> = []
      for (let y = bounds.y; y <= bounds.yMax; y += FIELD_STEP) {
        const coord = this.params.invert(x, y)
        if (coord) {
          const λ = coord[0]
          const φ = coord[1]
          if (isFinite(λ)) {
            const wind = grid.interpolate(λ, φ)
            if (wind) {
              this.distort(λ, φ, x, y, velocityScale, wind)
              column[y] = column[y + 1] = column[y + 2] = wind
            }
          }
        }
      }
      columns[x] = columns[x + 1] = columns[x + 2] = column
    }

    const batchInterpolate = () => {
      if (this.generation !== gen) return // 已被 stop/start 作废，立即终止重建
      const start = Date.now()
      while (x < bounds.width) {
        interpolateColumn(x)
        x += FIELD_STEP
        if (Date.now() - start > 1000) {
          setTimeout(batchInterpolate, 25)
          return
        }
      }
      if (this.generation !== gen) return
      this.createField(columns, bounds, callback)
    }
    batchInterpolate()
  }

  // -- 风速填色背景（对齐官网 scalarLayer）：逐像素查 LUT 写 imageData，putImageData 一次贴图。
  //    magnitude 用 (|u|+|v|)/2（官网口径，非 sqrt）；仅在网格重建时画一次，不随粒子每帧重绘。--
  private drawOverlay(bounds: Bounds, field: Field) {
    if (!this.overlayCanvas) return
    const g = this.overlayCanvas.getContext('2d')
    if (!g) return
    const { x, y, width, yMax } = bounds
    const w = width - x
    const h = yMax - y + 1
    if (w <= 0 || h <= 0) return
    const lut = this.scalarLUT
    const res = LUT_RESOLUTION
    const alpha = Math.round(this.OVERLAY_OPACITY * 255)
    const min = this.SCALAR_MIN
    const range = this.SCALAR_MAX - min
    const img = g.createImageData(w, h)
    const data = img.data
    for (let py = 0; py < h; py++) {
      const absY = y + py
      const rowOff = py * w
      for (let px = 0; px < w; px++) {
        const v = field(x + px, absY)
        if (v[2] !== null) {
          // v[2]=sqrt(u²+v²) 是原始风速 (m/s)；v[0]/v[1] 是粒子位移(经 velocityScale 缩放)不能用于配色。
          // 官网 scalarLayer 用 (|u|+|v|)/2(avg-abs)，sqrt 与其同量级、视觉等价，映射 [0.01,30] 色带。
          const mag = v[2]
          let t = (mag - min) / range
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const li = (t * (res - 1)) | 0
          const di = (rowOff + px) << 2
          data[di] = lut[li * 4]
          data[di + 1] = lut[li * 4 + 1]
          data[di + 2] = lut[li * 4 + 2]
          data[di + 3] = alpha
        }
      }
    }
    g.clearRect(x, y, w, h)
    g.putImageData(img, x, y)
  }

  // 供 CustomLayer render 回调调用：用最近一次场重建的 bounds/field 重画背景。
  redrawOverlay() {
    if (this.overlayCanvas && this.field && this.overlayBounds) {
      this.drawOverlay(this.overlayBounds, this.field)
    }
  }

  // -- 粒子动画主循环 --
  private animate(bounds: Bounds, field: Field) {
    const min = this.MIN_VELOCITY_INTENSITY
    const max = this.MAX_VELOCITY_INTENSITY
    const colorStyles = this.colorScale
    const indexFor = (m: number) =>
      Math.max(0, Math.min(colorStyles.length - 1, Math.round(((m - min) / (max - min)) * (colorStyles.length - 1))))
    const buckets: Particle[][] = colorStyles.map(() => [])

    let particleCount = Math.round(bounds.width * bounds.height * this.PARTICLE_MULTIPLIER)
    if (/android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i.test(navigator.userAgent)) {
      particleCount *= this.PARTICLE_REDUCTION
    }

    const fadeFillStyle = `rgba(0, 0, 0, ${this.OPACITY})`
    const particles: Particle[] = []
    for (let i = 0; i < particleCount; i++) {
      particles.push(field.randomize({ x: 0, y: 0, xt: 0, yt: 0, age: Math.floor(Math.random() * this.MAX_PARTICLE_AGE) }))
    }

    const evolve = () => {
      for (const bucket of buckets) bucket.length = 0
      for (const particle of particles) {
        if (particle.age > this.MAX_PARTICLE_AGE) {
          field.randomize(particle).age = 0
        }
        const x = particle.x
        const y = particle.y
        const v = field(x, y)
        const m = v[2]
        if (m === null) {
          particle.age = this.MAX_PARTICLE_AGE // 粒子已飞出网格，不再回归
        } else {
          const xt = x + v[0]
          const yt = y + v[1]
          if (field(xt, yt)[2] !== null) {
            particle.xt = xt
            particle.yt = yt
            buckets[indexFor(m)].push(particle)
          } else {
            particle.x = xt
            particle.y = yt
          }
        }
        particle.age += 1
      }
    }

    const g = this.params.canvas.getContext('2d')!
    g.lineWidth = this.PARTICLE_LINE_WIDTH
    g.fillStyle = fadeFillStyle
    g.globalAlpha = 0.6

    const draw = () => {
      // 渐隐已有粒子尾迹
      g.globalCompositeOperation = 'destination-in'
      g.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)
      g.globalCompositeOperation = 'lighter' // 叠加绘制，重叠处更亮
      g.globalAlpha = this.OPACITY === 0 ? 0 : this.OPACITY * 0.9
      // 按色分桶批量绘制（每个 strokeStyle 一次 stroke）
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i]
        if (bucket.length > 0) {
          g.beginPath()
          g.strokeStyle = colorStyles[i]
          for (const particle of bucket) {
            g.moveTo(particle.x, particle.y)
            g.lineTo(particle.xt, particle.yt)
            particle.x = particle.xt
            particle.y = particle.yt
          }
          g.stroke()
        }
      }
    }

    const gen = this.generation
    let then = Date.now()
    const frame = () => {
      if (this.generation !== gen) return // 已被 stop/start 作废，停止调度
      this.animationLoop = requestAnimationFrame(frame)
      const now = Date.now()
      const delta = now - then
      if (delta > this.FRAME_TIME) {
        then = now - (delta % this.FRAME_TIME)
        evolve()
        draw()
      }
    }
    frame()
  }

  // -- 启动：bounds=[[0,0],[w,h]], extent=[[swLng,swLat],[neLng,neLat]] --
  start(bounds: number[][], width: number, height: number, extent: number[][]) {
    const mapBounds: MapBounds = {
      south: deg2rad(extent[0][1]),
      north: deg2rad(extent[1][1]),
      east: deg2rad(extent[1][0]),
      west: deg2rad(extent[0][0]),
      width,
      height,
    }
    this.stop()
    this.buildGrid((grid) => {
      this.interpolateField(grid, this.buildBounds(bounds, width, height), mapBounds, (b, field) => {
        this.field = field
        this.overlayBounds = b
        // 不直接 drawOverlay：改通知 layer 触发 CustomLayer.render()，
        // 由高德在 render 回调里调 redrawOverlay() 绘制并合成到矢量之下。
        this.onOverlayDrawn?.()
        this.animate(b, field)
      })
    })
  }

  stop() {
    this.generation++ // 作废所有在途重建链与动画循环
    if (this.field) this.field.release()
    this.field = null
    if (this.animationLoop) cancelAnimationFrame(this.animationLoop)
    this.animationLoop = 0
  }
}
