// 冒烟测试：真实请求 CMA 台风接口，验证剥壳 + 归一化逻辑
// 与 src/api/typhoon.ts 的核心逻辑一一对应（无测试框架，改归一化时两处必须同步）。运行：npm run smoke
const BASE = 'https://typhoon.nmc.cn/weatherservice'

/** 同 src/lib/geo.ts 的 normLng（冒烟脚本可脱离构建直接跑，故内联） */
const normLng = (lng) =>
  lng >= -180 && lng <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180
const TIMEOUT_MS = 15_000

async function fetchJsonp(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`接口 ${res.status}: ${url}`)
  const text = await res.text()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('非法 JSONP 响应')
  return JSON.parse(text.slice(start, end + 1))
}

function normalizeSummary(raw) {
  return {
    id: String(raw[0]),
    nameEn: String(raw[1]),
    nameCn: raw[2] == null ? null : String(raw[2]),
    code: String(raw[3]),
    status: raw[7] === 'start' ? 'start' : 'stop',
  }
}

function normalizeCircles(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const result = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 5) continue
    const level = String(entry[0])
    const ne = Number(entry[1]); const se = Number(entry[2])
    const sw = Number(entry[3]); const nw = Number(entry[4])
    if ([ne, se, sw, nw].some((v) => Number.isNaN(v))) continue
    result.push({ level, ne, se, sw, nw })
  }
  return result.length === 0 ? null : result
}

function normalizeForecast(raw, baseTime) {
  if (!Array.isArray(raw)) return []
  const points = []
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
      lng: normLng(lng),
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

function normalizePathPoint(raw) {
  return {
    time: Number(raw[2]),
    level: String(raw[3]),
    lng: normLng(Number(raw[4])),
    lat: Number(raw[5]),
    pressure: Number(raw[6]),
    wind: Number(raw[7]),
    windCircles: normalizeCircles(raw[10]),
  }
}

function normalizeTyphoon(raw) {
  const pathRaw = Array.isArray(raw[8]) ? raw[8] : []
  const path = pathRaw.map(normalizePathPoint)
  // 只取最新时次（从后往前第一个带预报的路径点）的预报，避免预报线穿过过去；
  // 各机构预报全部保留，BABJ 优先作为主预报。
  const forecasts = []
  for (let i = pathRaw.length - 1; i >= 0; i--) {
    const fo = pathRaw[i]?.[11]
    if (fo && typeof fo === 'object') {
      const base = Number(pathRaw[i][2])
      for (const [agency, rawPoints] of Object.entries(fo)) {
        const points = normalizeForecast(rawPoints, base)
        if (!points.length) continue
        points.sort((a, b) => a.time - b.time)
        forecasts.push({ agency, points })
      }
      break
    }
  }
  forecasts.sort((a, b) => Number(b.agency === 'BABJ') - Number(a.agency === 'BABJ'))
  const primary = forecasts[0]
  return {
    id: String(raw[0]),
    nameEn: String(raw[1]),
    nameCn: raw[2] == null ? null : String(raw[2]),
    code: String(raw[3]),
    status: raw[7] === 'start' ? 'start' : 'stop',
    path,
    forecast: primary ? primary.points : [],
    primaryAgency: primary ? primary.agency : null,
    forecasts,
  }
}

async function main() {
  console.log('[1] 拉活跃台风列表...')
  const data = await fetchJsonp(`${BASE}/typhoon/jsons/list_default`)
  const all = (data.typhoonList ?? []).map(normalizeSummary)
  const active = all.filter((t) => t.status === 'start')
  console.log('    台风总数', all.length, '| 活跃', active.length)
  for (const t of active) console.log(`    - ${t.nameCn ?? '(未命名)'} ${t.nameEn} 编号${t.code} id=${t.id}`)

  if (active.length === 0) {
    console.log('    （当前无活跃台风，跳过详情校验）')
  } else {
    const id = active[0].id
    console.log(`[2] 拉活跃台风详情 ${id}...`)
    const t = normalizeTyphoon((await fetchJsonp(`${BASE}/typhoon/jsons/view_${id}`)).typhoon)
    console.log('    名称:', t.nameCn ?? t.nameEn, '| 编号:', t.code, '| 状态:', t.status)
    console.log('    路径点:', t.path.length, '| 预报点:', t.forecast.length)
    const last = t.path[t.path.length - 1]
    const wc = last?.windCircles
    if (last) {
      console.log(
        '    最新实况:', new Date(last.time).toISOString(), '| 位置', last.lat, last.lng,
        '| 风', last.wind, 'm/s | 压', last.pressure, 'hPa | 等级', last.level,
        '| 风圈', wc ? `${wc.length}档 ${JSON.stringify(wc)}` : '无'
      )
    }
    console.log('    预报机构:', t.forecasts.map((s) => `${s.agency}(${s.points.length})`).join(', ') || '无')
    if (t.forecast.length) {
      const f = t.forecast[0]
      console.log('    首个预报:', new Date(f.forecast.arrivalTime).toISOString(), '| +', f.forecast.hours, 'h | 风', f.wind, 'm/s')
    }
  }

  // 历史年份列表（历史台风浏览入口）
  const year = new Date().getFullYear() - 1
  console.log(`[3] 拉 ${year} 年台风列表...`)
  const past = (await fetchJsonp(`${BASE}/typhoon/jsons/list_${year}`)).typhoonList ?? []
  const pastRows = past.map(normalizeSummary)
  console.log(`    共 ${pastRows.length} 个（含已停编）`)
  if (pastRows.length) {
    const sample = pastRows[pastRows.length - 1]
    console.log(`    样例: ${sample.nameCn ?? sample.nameEn} 编号${sample.code} 状态${sample.status}`)
  }

  console.log('SMOKE OK ✅')
}

main().catch((e) => {
  console.error('SMOKE FAIL ❌', e)
  process.exit(1)
})
