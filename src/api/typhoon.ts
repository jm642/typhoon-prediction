/**
 * 数据层：CMA 台风数据获取与归一化（spec §3, §4, §5）
 *
 * 唯一数据入口，只暴露两个函数。前端组件不接触原始接口。
 * 未来若演化到后端代理（ADR-0002），仅需修改本模块实现，组件不变。
 *
 * 接口事实（research/02-CMA接口/findings.md）：
 * - CORS: `Access-Control-Allow-Origin: *`，简单 GET 可直接跨域
 *   ⚠️ 勿加自定义头，否则触发 preflight → 405 失败
 * - 响应是 JSONP 包装，须 response.text() → 剥壳 → JSON.parse
 */

import type {
  NormalizedTyphoon,
  TyphoonPoint,
  TyphoonSummary,
  WindCircles,
} from '../types/typhoon'

const BASE = 'https://typhoon.nmc.cn/weatherservice'

/**
 * 剥 JSONP 壳 → JSON 对象。
 * 实测各接口 JSONP 包装不一致：`函数名({...})` 与 `函数名(({...}))` 并存。
 * 最健壮做法：取第一个 `{` 到最后一个 `}`，忽略外层函数名与括号层数。
 */
export function unwrapJsonp(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('非法 JSONP 响应')
  return JSON.parse(text.slice(start, end + 1))
}

/** 列表项：`[id, 英文名, 中文名|null, 短编号, 完整编号, 系统序号, 名称寓意|null, 状态]` */
function normalizeSummary(raw: unknown[]): TyphoonSummary {
  const id = raw[0]
  const nameEn = raw[1]
  const nameCn = raw[2]
  const code = raw[3]
  const status = raw[7]
  return {
    id: String(id),
    nameEn: String(nameEn),
    nameCn: nameCn == null ? null : String(nameCn),
    code: String(code),
    status: status === 'start' ? 'start' : 'stop',
  }
}

/**
 * 风圈数组:`[["30KTS", NE, SE, SW, NW, 点ID], ["50KTS", ...], ["64KTS", ...]]`
 * 弱台风仅七级(30KTS)一档,强台风七/十/十二(30/50/64KTS)三档;
 * 返回从外到内的多档集合,保留原始顺序。
 */
function normalizeCircles(raw: unknown): WindCircles | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const result: WindCircles = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 5) continue
    const level = String(entry[0])
    const ne = Number(entry[1])
    const se = Number(entry[2])
    const sw = Number(entry[3])
    const nw = Number(entry[4])
    if ([ne, se, sw, nw].some((v) => Number.isNaN(v))) continue
    result.push({ level, ne, se, sw, nw })
  }
  return result.length === 0 ? null : result
}

/** 预报点元素：`[时距, 基准时间串, 经, 纬, 压, 风, 机构, 强度码]` */
function normalizeForecast(raw: unknown[], baseTime: number): TyphoonPoint[] {
  if (!Array.isArray(raw)) return []
  const points: TyphoonPoint[] = []
  for (const item of raw) {
    if (!Array.isArray(item)) continue
    const hours = Number(item[0])
    const lng = Number(item[2])
    const lat = Number(item[3])
    const pressure = Number(item[4])
    const wind = Number(item[5])
    const level = String(item[7])
    if ([lng, lat, pressure, wind].some((v) => Number.isNaN(v))) continue
    points.push({
      time: baseTime + hours * 3600000,
      lng,
      lat,
      pressure,
      wind,
      level,
      windCircles: null,
      forecast: { hours, arrivalTime: baseTime + hours * 3600000 },
    })
  }
  return points
}

/** 路径点：13 元素数组 `[点ID, 时间串, 时间戳, 强度码, 经, 纬, 压, 风, 方向, 移速, 风圈, 预报对象, 图层时间]` */
function normalizePathPoint(raw: unknown[]): TyphoonPoint {
  const time = Number(raw[2])
  const level = String(raw[3])
  const lng = Number(raw[4])
  const lat = Number(raw[5])
  const pressure = Number(raw[6])
  const wind = Number(raw[7])
  const circles = normalizeCircles(raw[10])
  return { time, lng, lat, pressure, wind, level, windCircles: circles }
}

/**
 * 单台风详情归一化。顶层 10 元素数组：
 * `[id, 英文名, 中文名, 短编号, 完整编号, 系统序号, 名称寓意, 状态, 路径点数组, 同步引用]`
 * 预报对象挂在路径点 `[11]`（`{"BABJ": [[时距,基准,经,纬,压,风,机构,强度], ...]}`），
 * 到达时间 = 所在路径点时间戳 + 时距×3600000。
 */
export function normalizeTyphoon(raw: unknown[]): NormalizedTyphoon {
  const id = String(raw[0])
  const nameEn = String(raw[1])
  const nameCn = raw[2] == null ? null : String(raw[2])
  const code = String(raw[3])
  const status = raw[7] === 'start' ? 'start' : 'stop'
  const pathRaw = Array.isArray(raw[8]) ? (raw[8] as unknown[][]) : []

  const path = pathRaw.map(normalizePathPoint)

  // 只取最新时次（从后往前第一个带预报的路径点）的预报。
  // 每个历史路径点都携带一份「当时」的预报快照，若全部收集，
  // 预报线会穿过过去并与实测路径重叠（见 ticket 排查记录）。
  const forecast: TyphoonPoint[] = []
  for (let i = pathRaw.length - 1; i >= 0; i--) {
    const forecastObj = pathRaw[i]?.[11]
    if (forecastObj && typeof forecastObj === 'object') {
      const baseTime = Number(pathRaw[i][2])
      for (const key of Object.keys(forecastObj as Record<string, unknown>)) {
        const arr = (forecastObj as Record<string, unknown[]>)[key]
        forecast.push(...normalizeForecast(arr, baseTime))
      }
      break
    }
  }
  forecast.sort((a, b) => a.time - b.time)

  return { id, nameCn, nameEn, code, status, path, forecast }
}

/** 活跃台风列表（filter status==='start'）→ 摘要 */
export async function fetchTyphoonList(): Promise<TyphoonSummary[]> {
  const res = await fetch(`${BASE}/typhoon/jsons/list_default`)
  if (!res.ok) throw new Error(`列表接口 ${res.status}`)
  const text = await res.text()
  const data = unwrapJsonp(text) as { typhoonList?: unknown[][] }
  return (data.typhoonList ?? []).map(normalizeSummary)
}

/** 单台风详情 → 归一化。`view_<id>` 响应的 `typhoon` 字段直接是 10 元素台风数组（非嵌套）。 */
export async function fetchTyphoonDetail(id: string): Promise<NormalizedTyphoon> {
  const res = await fetch(`${BASE}/typhoon/jsons/view_${id}`)
  if (!res.ok) throw new Error(`详情接口 ${res.status}`)
  const text = await res.text()
  const data = unwrapJsonp(text) as { typhoon?: unknown[] }
  if (!data.typhoon) throw new Error(`台风详情为空: ${id}`)
  return normalizeTyphoon(data.typhoon)
}
