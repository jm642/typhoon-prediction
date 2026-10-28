/**
 * 全球大气环流风场数据层
 * 从浙江省水利厅台风网 API 获取 GFS 模型的全球 10m 风场 u/v 分量（GRIB2JSON 格式）。
 * 返回原始数据集数组（{header, data}[]），直接供 Windy 引擎消费。
 *
 * 数据缓存 3 小时（GFS 每 6 小时更新一次），避免重复请求。
 */
import type { WindDataSet } from '../lib/windy'

export type { WindDataSet }

const API_URL = 'https://typhoon.slt.zj.gov.cn/Api/LastWind'
const CACHE_TTL = 3 * 3600 * 1000 // 缓存 3 小时
const TIMEOUT_MS = 30_000 // 全球网格体积较大，超时放宽

let cached: WindDataSet[] | null = null
let cacheTime = 0
let inflight: Promise<WindDataSet[]> | null = null

async function fetchWindData(): Promise<WindDataSet[]> {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`风场接口 ${res.status}`)
  const raw = await res.json()

  // windData 是 JSON 字符串，需二次解析
  const datasets: WindDataSet[] = JSON.parse(raw.windData)
  if (!Array.isArray(datasets) || datasets.length < 2) {
    throw new Error('风场数据格式异常：缺少 U/V 分量')
  }
  return datasets
}

/**
 * 获取全球风场数据集（带缓存）。
 * 并发调用共享同一 inflight Promise，避免重复请求。
 */
export async function fetchGlobalWind(): Promise<WindDataSet[]> {
  const now = Date.now()

  if (cached && now - cacheTime < CACHE_TTL) return cached

  if (inflight) return inflight

  inflight = fetchWindData()
    .then((data) => {
      cached = data
      cacheTime = Date.now()
      inflight = null
      return data
    })
    .catch((err) => {
      inflight = null
      throw err
    })

  return inflight
}
