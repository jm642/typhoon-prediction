/**
 * 登陆点推断（spec 无此功能，2026-08-19 新增）
 *
 * CMA 接口不含「登陆」字段（已核实 list_<year> / view_<id> 均无），
 * 因此根据台风中心轨迹 + 陆海掩膜（src/data/land.ts，Natural Earth 110m）
 * 推断登陆点：轨迹点从「海」进入「陆」的那一段，用二分法求与海岸线的交点。
 *
 * 坐标说明：CMA 数据为 0~360° 记法（跨日期变更线 >180°），本模块统一
 * 归一化到 -180~180 再与陆地图案比对；线段跨 180° 时先解缠绕再插值。
 */
import { LAND_POLYGONS, type LandPolygon } from '../data/land'
import type { TyphoonPoint } from '../types/typhoon'

/** 一个登陆点（台风中心跨上海岸线的位置） */
export interface LandfallPoint {
  lng: number
  lat: number
  /** 登陆时刻（由相邻路径点时间线性插值，ms） */
  time: number
}

/** 归一化经度到 [-180, 180) */
export function normLng(lng: number): number {
  return ((lng + 180) % 360 + 360) % 360 - 180
}

// 预计算每个多边形的包围盒，命中测试先过滤再逐环判点
const BOXES: [number, number, number, number][] = LAND_POLYGONS.map((p) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of p.outer) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
})

function inRing(ring: [number, number][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** 点是否在陆上（归一化经度后比对；在外环内且不在任一内环） */
export function isLand(lng: number, lat: number): boolean {
  const x = normLng(lng)
  for (let i = 0; i < LAND_POLYGONS.length; i++) {
    const b = BOXES[i]
    if (x < b[0] || x > b[2] || lat < b[1] || lat > b[3]) continue
    const p: LandPolygon = LAND_POLYGONS[i]
    if (!inRing(p.outer, x, lat)) continue
    if (p.holes.some((h) => inRing(h, x, lat))) return false
    return true
  }
  return false
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** 线段 a→b 与海岸线的交点（二分求边界，迭代 12 次 ≈ 0.02% 精度） */
function crossing(a: TyphoonPoint, b: TyphoonPoint): { lng: number; lat: number; t: number } {
  // 解缠绕：若两经度差超过 180°，把 b 平移 ±360 使线段不跨日界线
  let aX = normLng(a.lng)
  let bX = normLng(b.lng)
  if (bX - aX > 180) bX -= 360
  else if (aX - bX > 180) bX += 360
  let lo = 0
  let hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (isLand(lerp(aX, bX, mid), lerp(a.lat, b.lat, mid))) hi = mid
    else lo = mid
  }
  return { lng: normLng(lerp(aX, bX, hi)), lat: lerp(a.lat, b.lat, hi), t: hi }
}

/** 从实测轨迹推断登陆点：海→陆 每段跨线记一个点 */
export function detectLandfalls(path: TyphoonPoint[]): LandfallPoint[] {
  const out: LandfallPoint[] = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    if (isLand(a.lng, a.lat)) continue // 起点须在海（台风生成于洋面）
    if (!isLand(b.lng, b.lat)) continue // 未跨上陆地
    const c = crossing(a, b)
    out.push({ lng: c.lng, lat: c.lat, time: a.time + (b.time - a.time) * c.t })
  }
  return out
}
