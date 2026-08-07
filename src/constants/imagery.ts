/**
 * 云图(卫星)/雷达图片范围常量（spec 新增 § imagery）
 * CMA 卫星云图与气象雷达均为 2×2 分块 PNG，覆盖范围相同（中国及周边海域），
 * 故两者共用同一套分块 bounds。数值取自 CMA 台风网 gis.js（line 954-959）。
 *
 * ⚠️ 坐标顺序统一为高德原生 [lng, lat]（gis.js 源是 Leaflet 的 [lat, lng]，已转换），
 * 以便直接传入 `new AMap.Bounds(sw, ne)`。
 */
export type ImageryType = 'satellite' | 'radar'

/** 图片整体覆盖范围（卫星/雷达一致） */
export const IMG_BOUNDS = {
  latMin: 11.1784,
  latMax: 55.7766,
  lonMin: 67.5,
  lonMax: 140.625,
  latMid: 36.59871,
  lonMid: 104.06387,
}

/** 高德顺序边界：sw=[lng,lat]（西南）~ ne=[lng,lat]（东北） */
export interface LngLatBounds {
  sw: [number, number]
  ne: [number, number]
}

const { latMin, latMax, lonMin, lonMax, latMid, lonMid } = IMG_BOUNDS

/**
 * 卫星云图与气象雷达共用的 2×2 分块：part 命名对齐 gis.js
 *（`_0_0` 北西 / `_1_0` 北东 / `_0_1` 南西 / `_1_1` 南东），
 * bounds 由 gis.js imageOverlay bounds 换算为高德 [lng,lat] 顺序。
 */
export const IMG_PARTS: { part: string; bounds: LngLatBounds }[] = [
  { part: '0_0', bounds: { sw: [lonMin, latMid], ne: [lonMid, latMax] } }, // 北西
  { part: '1_0', bounds: { sw: [lonMid, latMid], ne: [lonMax, latMax] } }, // 北东
  { part: '0_1', bounds: { sw: [lonMin, latMin], ne: [lonMid, latMid] } }, // 南西
  { part: '1_1', bounds: { sw: [lonMid, latMin], ne: [lonMax, latMid] } }, // 南东
]
