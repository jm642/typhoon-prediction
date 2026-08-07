<script setup lang="ts">
/**
 * 应用外壳：沉浸式地图布局（spec §7 变体 B）
 * 全屏高德地图 + 玻璃拟态浮层（左上台风列表 / 左下实况卡 / 底部右强度曲线）
 * + 顶部数据时间与刷新。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchTyphoonDetail, fetchTyphoonList } from './api/typhoon'
import type { NormalizedTyphoon, TyphoonSummary } from './types/typhoon'
import { useAmapMap } from './composables/useAmapMap'
import TyphoonList from './components/TyphoonList.vue'
import StatusCard from './components/StatusCard.vue'
import IntensityChart from './components/IntensityChart.vue'
import TyphoonLayer from './components/TyphoonLayer.vue'
import ImageryLayer from './components/ImageryLayer.vue'
import WindFieldLayer from './components/WindFieldLayer.vue'
import LegendContent from './components/LegendContent.vue'
import { levelForCode } from './constants/levels'

const mapContainer = ref<HTMLElement | null>(null)
const { amap, map, ready, error } = useAmapMap(mapContainer)

const list = ref<TyphoonSummary[]>([])
const typhoons = ref<NormalizedTyphoon[]>([])
const activeId = ref<string | null>(null)
const typhoon = ref<NormalizedTyphoon | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const listError = ref<string | null>(null)
const updatedAt = ref<Date | null>(null)

// 图层开关：云图(卫星) / 雷达 / 风场
const showCloud = ref(false)
const showRadar = ref(false)
const showWind = ref(false)

// 移动端：抽屉详情展开态（false=收起信息条）；图例弹出卡开关与卡片 DOM
const detailExpanded = ref(false)
const mobileLegendOpen = ref(false)
const legendPopEl = ref<HTMLElement | null>(null)

// 移动端：选中台风时重置为收起态并关闭图例弹出；取消选中时清空图例弹出
function handleSelect(id: string) {
  selectTyphoon(id)
  detailExpanded.value = false
  mobileLegendOpen.value = false
}
function handleClear() {
  activeId.value = null
  typhoon.value = null
  detailExpanded.value = false
  mobileLegendOpen.value = false
}

// 移动端：抽屉信息条点击 展开/收起，同时关闭图例弹出
function toggleDetail() {
  detailExpanded.value = !detailExpanded.value
  mobileLegendOpen.value = false
}

// 移动端：点击图例弹出卡外部任意处关闭
function onDocClick(e: MouseEvent) {
  if (mobileLegendOpen.value && legendPopEl.value && !legendPopEl.value.contains(e.target as Node)) {
    mobileLegendOpen.value = false
  }
}

// 移动端抽屉信息条：一次性取出最后一个路径点的强度名/色/风速
const lastInfo = computed(() => {
  const t = typhoon.value
  if (!t || t.path.length === 0) return null
  const last = t.path[t.path.length - 1]
  const lvl = levelForCode(last.level)
  return { name: lvl.name, color: lvl.color, wind: last.wind }
})

function fmt(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadList() {
  loading.value = true
  listError.value = null
  try {
    const all = await fetchTyphoonList()
    const active = all.filter((t) => t.status === 'start')
    list.value = active
    // 并发拉取全部活跃台风详情（单个失败不阻塞其他）
    const details = await Promise.all(
      active.map((t) => fetchTyphoonDetail(t.id).catch(() => null)),
    )
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
    updatedAt.value = new Date()
  } catch (e) {
    listError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function selectTyphoon(id: string) {
  // toggle：再次点击已选中项 -> 取消选中，回到显示全部
  if (activeId.value === id) {
    activeId.value = null
    typhoon.value = null
    return
  }
  activeId.value = id
  typhoon.value = typhoons.value.find((t) => t.id === id) ?? null
}

async function refresh() {
  refreshing.value = true
  await loadList()
  refreshing.value = false
}

function handleVisibility() {
  if (document.visibilityState === 'visible') refresh()
}

onMounted(() => {
  loadList()
  document.addEventListener('visibilitychange', handleVisibility)
  document.addEventListener('click', onDocClick)
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibility)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div class="app">
    <div ref="mapContainer" class="map-container" />

    <TyphoonLayer :amap="amap" :map="map" :typhoons="typhoons" :selected-id="activeId" />

    <ImageryLayer :amap="amap" :map="map" :show-cloud="showCloud" :show-radar="showRadar" />
    <WindFieldLayer :amap="amap" :map="map" :enabled="showWind" />

    <!-- UI 浮层容器：桌面端子项仍为绝对定位（不受 flex 影响），
         手机端媒体查询中改为纵向 flex 流式排列 -->
    <div class="ui-layer">
      <!-- 左上：品牌 + 台风列表 -->
      <div class="glass top-left">
        <div class="brand">🌀 实时台风路径</div>
        <div class="sub">活跃台风 {{ list.length }} 个</div>
        <TyphoonList :list="list" :active-id="activeId" :loading="loading" @select="selectTyphoon" />
      </div>

      <!-- 底部左：实况卡（选中某台风时才显示） -->
      <div v-if="typhoon" class="glass bottom-left">
        <StatusCard :typhoon="typhoon" />
      </div>

      <!-- 底部右：强度曲线（选中某台风时才显示） -->
      <div v-if="typhoon" class="glass bottom-right">
        <IntensityChart :typhoon="typhoon" />
      </div>

      <!-- 顶部中：更新时间 + 刷新 -->
      <div class="glass top-center">
        <span class="tc-updated">{{ updatedAt ? `更新于 ${fmt(updatedAt.getTime())}` : '加载中…' }}</span>
        <button class="tc-refresh" :disabled="refreshing" @click="refresh">
          {{ refreshing ? '刷新中…' : '↻ 刷新' }}
        </button>
      </div>

      <!-- 右上：图例（沿海警戒线 + 强度等级 + 风圈等级） -->
      <div class="glass legend">
        <div class="legend-body-wrap">
          <LegendContent />
          <!-- 桌面端在此显示图层开关；手机端整层隐藏，图层开关由 .m-toolbar 承担 -->
          <div class="legend-layers">
            <div class="legend-title legend-gap">图层开关</div>
            <div class="layer-toggles">
              <button class="layer-chip" :class="{ on: showCloud }" @click="showCloud = !showCloud">🛰 云图</button>
              <button class="layer-chip" :class="{ on: showRadar }" @click="showRadar = !showRadar">📡 雷达</button>
              <button
                class="layer-chip"
                :class="{ on: showWind }"
                @click="showWind = !showWind"
              >
                🌬 全球风场
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 移动端 UI（≤768px 显示；桌面端由 CSS 隐藏） -->
    <div class="m-ui">
      <!-- 顶部细条：品牌 + 更新时间 + 刷新 -->
      <div class="m-topbar glass">
        <span class="m-brand">🌀 实时台风</span>
        <span class="m-updated">{{ updatedAt ? `更新于 ${fmt(updatedAt.getTime())}` : '加载中…' }}</span>
        <button class="m-refresh" :disabled="refreshing" @click="refresh">
          {{ refreshing ? '刷新中…' : '↻' }}
        </button>
      </div>

      <!-- 底部工具条：图层开关 + 图例 -->
      <div class="m-toolbar glass">
        <button class="layer-chip" :class="{ on: showCloud }" @click="showCloud = !showCloud">🛰 云图</button>
        <button class="layer-chip" :class="{ on: showRadar }" @click="showRadar = !showRadar">📡 雷达</button>
        <button class="layer-chip" :class="{ on: showWind }" @click="showWind = !showWind">🌬 风场</button>
        <button class="m-legend-btn" @click.stop="mobileLegendOpen = !mobileLegendOpen">☰ 图例</button>
      </div>

      <!-- 底部抽屉：列表态 / 详情收起态 / 详情展开态 -->
      <div class="m-drawer glass" :class="{ 'is-expanded': detailExpanded }">
        <!-- 列表态 -->
        <template v-if="!activeId">
          <div class="m-drawer-head">
            <span>活跃台风 {{ list.length }} 个</span>
          </div>
          <TyphoonList :list="list" :active-id="activeId" :loading="loading" @select="handleSelect" />
        </template>

        <!-- 详情态（收起/展开） -->
        <template v-else-if="typhoon">
          <button class="m-info-bar" @click="toggleDetail">
            <span class="m-back" @click.stop="handleClear">☰全部</span>
            <span class="m-info-name">{{ typhoon.nameCn ?? typhoon.nameEn }}</span>
            <span class="m-info-badge" :style="{ background: lastInfo?.color }">{{ lastInfo?.name }}</span>
            <span class="m-info-wind">{{ lastInfo?.wind }} m/s</span>
            <span class="m-drawer-caret">{{ detailExpanded ? '▾' : '▴' }}</span>
          </button>
          <div v-show="detailExpanded" class="m-drawer-body">
            <StatusCard :typhoon="typhoon" />
            <IntensityChart :typhoon="typhoon" />
          </div>
        </template>
      </div>

      <!-- 图例弹出卡 -->
      <div v-if="mobileLegendOpen" ref="legendPopEl" class="m-legend-pop glass">
        <LegendContent />
      </div>
    </div>

    <!-- 状态提示 -->
    <div v-if="error" class="toast toast-error">{{ error }}</div>
    <div v-else-if="listError" class="toast toast-error">数据加载失败：{{ listError }}</div>
    <div v-else-if="!loading && ready && list.length === 0 && !listError" class="toast">当前无活跃台风</div>
  </div>
</template>
