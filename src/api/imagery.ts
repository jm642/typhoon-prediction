/**
 * 云图(卫星)/雷达数据层（spec 新增 § imagery）
 *
 * 卫星与雷达数据源不同：
 * - 卫星云图：NASA GIBS 向日葵-9（见 docs/adr/0003）。
 *   标准 WMTS REST XYZ 瓦片（Web Mercator），时间参数 `default` = 自动取最新可用产品，
 *   CORS `Access-Control-Allow-Origin: *`、无需密钥。
 *   z≤6 用干净红外 Band13（昼夜可用，Level6）；z≥7 切 Band3 可见光 1km（Level7，夜间全黑），
 *   z>7 无更高分辨率源，overzoom 复用 z7 瓦片（放大显示，云图不消失）。
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
/** 图层可见范围：与地图 zooms 一致；z>7 为 overzoom（复用 z7 瓦片，无新细节） */
export const SAT_ZOOMS: [number, number] = [2, 18]

/** 构造卫星云图瓦片 URL（z/y/x；time=default 取最新可用时次；z≥7 切可见光，z>7 回落到父级 z7 瓦片） */
export function buildSatelliteTileUrl(x: number, y: number, z: number): string {
  if (z >= 7) {
    const dz = z - 7
    return `${GIBS_BASE}/${SAT_VISIBLE_LAYER}/default/default/GoogleMapsCompatible_Level7/7/${y >> dz}/${x >> dz}.png`
  }
  return `${GIBS_BASE}/${SAT_LAYER}/default/default/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`
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
