/**
 * 台风数据编排：列表/详情加载、实时⇄历史切换、选中、缓存兜底、自动刷新
 *
 * 从 App.vue 抽出的「编排层」——组件只管渲染，这里负责请求、竞态与状态同步。
 * 请求代际（listToken / selectToken）用于丢弃过期响应：
 * - 快速切换模式/年份时，旧列表响应不能覆盖新列表
 * - 历史模式快速连点 A→B 时，A 的慢响应不能覆盖 B 的选中
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { fetchTyphoonDetail, fetchTyphoonList, fetchTyphoonYearList } from '../api/typhoon'
import type { NormalizedTyphoon, TyphoonSummary } from '../types/typhoon'
import { withCache } from '../lib/cache'

/** 历史详情缓存条数上限（单条 10–20KB） */
const HISTORY_CACHE_MAX = 30

export type Mode = 'live' | 'history'

export function useTyphoonData() {
  const list = ref<TyphoonSummary[]>([])
  const typhoons = ref<NormalizedTyphoon[]>([])
  const activeId = ref<string | null>(null)
  const typhoon = ref<NormalizedTyphoon | null>(null)
  const loading = ref(false)
  const refreshing = ref(false)
  const listError = ref<string | null>(null)
  const updatedAt = ref<Date | null>(null)
  /** 本次数据来自本地缓存时记录其写入时间 */
  const cachedAt = ref<Date | null>(null)

  const mode = ref<Mode>('live')
  const historyYear = ref(new Date().getFullYear())
  const historyCache = ref<Record<string, NormalizedTyphoon>>({})

  let listToken = 0
  let selectToken = 0

  async function loadList() {
    const token = ++listToken
    loading.value = true
    listError.value = null
    let staleAt: number | null = null
    const markStale = (at: number) => {
      staleAt = staleAt == null ? at : Math.min(staleAt, at)
    }
    try {
      if (mode.value === 'live') {
        const listRes = await withCache('list:default', fetchTyphoonList)
        if (token !== listToken) return
        if (listRes.stale) markStale(listRes.at)
        const active = listRes.data.filter((t) => t.status === 'start')
        list.value = active
        // 并发拉取全部活跃台风详情（单个失败不阻塞其他；失败时回退本地缓存）
        const details = await Promise.all(
          active.map((t) =>
            withCache(`detail:${t.id}`, () => fetchTyphoonDetail(t.id))
              .then((r) => {
                if (r.stale) markStale(r.at)
                return r.data
              })
              .catch(() => null),
          ),
        )
        if (token !== listToken) return
        typhoons.value = details.filter((d): d is NormalizedTyphoon => d !== null)
        // 选中项与最新详情同步：已停止活跃则取消选中，否则刷新其详情
        if (activeId.value && !active.some((t) => t.id === activeId.value)) {
          activeId.value = null
          typhoon.value = null
        } else if (activeId.value) {
          typhoon.value = typhoons.value.find((t) => t.id === activeId.value) ?? null
        }
        if (active.length === 0) {
          typhoon.value = null
          activeId.value = null
        }
      } else {
        const yearRes = await withCache(`list:${historyYear.value}`, () =>
          fetchTyphoonYearList(historyYear.value),
        )
        if (token !== listToken) return
        if (yearRes.stale) markStale(yearRes.at)
        list.value = yearRes.data
        // 年份切换后清空选中与图层（历史详情按需加载）
        activeId.value = null
        typhoon.value = null
        typhoons.value = []
      }
      cachedAt.value = staleAt == null ? null : new Date(staleAt)
      updatedAt.value = new Date()
    } catch (e) {
      if (token !== listToken) return
      listError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (token === listToken) loading.value = false
    }
  }

  async function selectTyphoon(id: string) {
    const token = ++selectToken
    // toggle：再次点击已选中项 -> 取消选中
    if (activeId.value === id) {
      activeId.value = null
      typhoon.value = null
      // 历史模式取消选中后清空图层（实时模式保留全部活跃台风图层）
      if (mode.value === 'history') typhoons.value = []
      return
    }
    if (mode.value === 'history') {
      // 历史详情按需加载并缓存（静态数据，重复选中不重复请求）
      let t = historyCache.value[id]
      if (!t) {
        try {
          const res = await withCache(`detail:${id}`, () => fetchTyphoonDetail(id))
          t = res.data
          if (res.stale) cachedAt.value = new Date(res.at)
          const next = { ...historyCache.value, [id]: t }
          const keys = Object.keys(next)
          if (keys.length > HISTORY_CACHE_MAX) delete next[keys[0]]
          historyCache.value = next
        } catch (e) {
          if (token !== selectToken) return
          listError.value = e instanceof Error ? e.message : String(e)
          return
        }
      }
      // 期间用户又点了别的台风或切了模式 → 丢弃这次结果，避免慢响应覆盖新选中
      if (token !== selectToken || mode.value !== 'history') return
      activeId.value = id
      typhoon.value = t
      typhoons.value = [t]
    } else {
      activeId.value = id
      typhoon.value = typhoons.value.find((t) => t.id === id) ?? null
    }
  }

  /** 清空选中（并作废在途的选中请求） */
  function clearSelection() {
    selectToken++
    activeId.value = null
    typhoon.value = null
    if (mode.value === 'history') typhoons.value = []
  }

  async function refresh() {
    refreshing.value = true
    await loadList()
    refreshing.value = false
  }

  /** 切换 实时/历史 模式：作废在途选中请求并重新加载对应列表 */
  async function switchMode(m: Mode) {
    if (mode.value === m) return
    selectToken++
    mode.value = m
    await loadList()
  }

  function handleVisibility() {
    // 历史数据是静态的：自动刷新既无意义，又会清掉当前选中的台风
    if (document.visibilityState === 'visible' && mode.value === 'live') refresh()
  }

  onMounted(() => {
    loadList()
    document.addEventListener('visibilitychange', handleVisibility)
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', handleVisibility)
  })

  return {
    list,
    typhoons,
    activeId,
    typhoon,
    loading,
    refreshing,
    listError,
    updatedAt,
    cachedAt,
    mode,
    historyYear,
    loadList,
    selectTyphoon,
    clearSelection,
    refresh,
    switchMode,
  }
}
