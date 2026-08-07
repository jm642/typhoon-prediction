/**
 * 云图(卫星)/雷达数据层（spec 新增 § imagery）
 *
 * 卫星与雷达数据源不同：
 * - 卫星云图：NASA GIBS 向日葵-9（见 docs/adr/0003）。
 *   标准 WMTS REST XYZ 瓦片（Web Mercator），时间参数 `default` = 自动取最新可用产品，
 *   CORS `Access-Control-Allow-Origin: *`、无需密钥。
 *   z≤6 用干净红外 Band13（昼夜可用，Level6）；z7 切 Band3 可见光 1km（Level7，夜间全黑）；
 *   z>7 无更高分辨率源，canvas 拼合 z7 瓦片经 ImageLayer overzoom（放大显示，云图不消失）。
 * - 雷达：CMA 台风网 2×2 分块 PNG（逆向 gis.js + 实测）：
 *   - GET {NMC}/imgs/radar/default
 *     → JSONP `imgs_radar_default({"time":"YYYYMMDDHHmm","formatTime":"…","state":0|1})`
 *   - 图片 `{NMC}/imgs/radar/{time}_{0|1}_{0|1}.png`，CORS `*`；state!==0 表示无当前产品。
 */
import { unwrapJsonp } from './typhoon'

const NMC_BASE = 'https://typhoon.nmc.cn/weatherservice'
const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'

/** GIBS 图层标识：向日葵-9 干净红外（彩色增强，昼夜可用） */
export const SAT_LAYER = 'Himawari_AHI_Band13_Clean_Infrared'
/** GIBS 图层标识：向日葵-9 Band3 可见光 1km（夜间全黑，z≥7 高倍放大用） */
export const SAT_VISIBLE_LAYER = 'Himawari_AHI_Band3_Red_Visible_1km'
/** TileLayer 可见范围（z>7 的 overzoom 由 ImageLayer 拼合层负责，见 ImageryLayer.vue） */
export const SAT_ZOOMS: [number, number] = [2, 7]

/** 构造卫星云图瓦片 URL（z/y/x；time=default 取最新可用时次；z7 切可见光） */
export function buildSatelliteTileUrl(x: number, y: number, z: number): string {
  if (z >= 7) {
    return `${GIBS_BASE}/${SAT_VISIBLE_LAYER}/default/default/GoogleMapsCompatible_Level7/${z}/${y}/${x}.png`
  }
  return `${GIBS_BASE}/${SAT_LAYER}/default/default/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`
}

/** Web Mercator 瓦片索引：经纬度 → z 级瓦片坐标（向下取整） */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  }
}

/** Web Mercator 瓦片西北角经纬度（x+1/y+1 即东南角，用于拼合层 bounds） */
export function tileToLngLat(x: number, y: number, z: number): { lng: number; lat: number } {
  const n = 2 ** z
  return {
    lng: (x / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
  }
}

export interface RadarTime {
  /** CMA 产品时间戳，如 "202608060918" */
  time: string
  /** 中文展示时间，如 "2026年08月06日09时18分" */
  formatTime: string
}

/** 构造雷达分块图片 URL（part 如 "0_0"） */
export function buildRadarImageUrl(time: string, part: string): string {
  return `${NMC_BASE}/imgs/radar/${time}_${part}.png`
}

/**
 * 拉取最新雷达时间戳。state!==0（无当前产品）返回 null，调用方不显示。
 * 失败抛错，由调用方 try/catch 静默处理（图层缺失不应阻塞主功能）。
 */
export async function fetchRadarTime(): Promise<RadarTime | null> {
  const res = await fetch(`${NMC_BASE}/imgs/radar/default`)
  if (!res.ok) throw new Error(`雷达时间戳接口 ${res.status}`)
  const data = unwrapJsonp(await res.text()) as { time?: unknown; formatTime?: unknown; state?: unknown }
  if (typeof data.time !== 'string' || data.state !== 0) return null
  return { time: data.time, formatTime: typeof data.formatTime === 'string' ? data.formatTime : '' }
}
