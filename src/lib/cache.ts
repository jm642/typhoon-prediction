/**
 * localStorage 兜底缓存
 *
 * CMA/雷达等接口无 SLA，网络失败或服务异常时回退到上次成功的数据，
 * 让页面仍可展示（调用方需提示数据时次，避免把旧数据当实时）。
 * 隐私模式/配额不足时静默降级为「不缓存」，不影响主流程。
 */

const PREFIX = 'taifeng:v1:'
/** 最多保留条数（详情单条约 10–20KB），超出按写入时间淘汰最旧的 */
const MAX_ENTRIES = 24

interface CacheEntry<T> {
  /** 写入时间 ms */
  at: number
  data: T
}

export interface CacheResult<T> {
  data: T
  at: number
  /** true = 网络请求失败，数据来自本地缓存 */
  stale: boolean
}

function readEntry<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    return typeof entry?.at === 'number' && entry.data != null ? entry : null
  } catch {
    return null
  }
}

/** 超出上限时淘汰最旧的若干条（按写入时间） */
function prune() {
  try {
    const entries: { key: string; at: number }[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const entry = readEntry(key.slice(PREFIX.length))
      entries.push({ key, at: entry?.at ?? 0 })
    }
    if (entries.length <= MAX_ENTRIES) return
    entries.sort((a, b) => a.at - b.at)
    for (const { key } of entries.slice(0, entries.length - MAX_ENTRIES)) {
      localStorage.removeItem(key)
    }
  } catch {
    // 忽略：缓存只是增强，不影响主流程
  }
}

/**
 * 先走网络，成功则写入缓存；失败则回退缓存，两者都无才抛出原始错误。
 */
export async function withCache<T>(key: string, fetcher: () => Promise<T>): Promise<CacheResult<T>> {
  try {
    const data = await fetcher()
    const at = Date.now()
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({ at, data }))
      prune()
    } catch {
      // 配额不足/隐私模式：仍返回网络数据
    }
    return { data, at, stale: false }
  } catch (err) {
    const cached = readEntry<T>(key)
    if (cached) return { data: cached.data, at: cached.at, stale: true }
    throw err
  }
}
