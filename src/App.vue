<script setup lang="ts">
/**
 * 应用外壳：沉浸式地图布局（spec §7 变体 B）
 * 全屏高德地图 + 玻璃拟态浮层（左上台风列表 / 左下实况卡 / 底部右强度曲线）
 * + 顶部数据时间与刷新。
 */
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import { useAmapMap } from './composables/useAmapMap'
import { useTyphoonData, type Mode } from './composables/useTyphoonData'
import { usePlayback } from './composables/usePlayback'
import { useLayerToggles } from './composables/useLayerToggles'
import TyphoonList from './components/TyphoonList.vue'
import StatusCard from './components/StatusCard.vue'
import TyphoonLayer from './components/TyphoonLayer.vue'
import ImageryLayer from './components/ImageryLayer.vue'
import WindFieldLayer from './components/WindFieldLayer.vue'
import LegendContent from './components/LegendContent.vue'
import LayerChips from './components/LayerChips.vue'
import PlaybackBar from './components/PlaybackBar.vue'
import { levelForCode } from './constants/levels'
import { fmtCn, fmtClock } from './lib/format'

// 强度曲线（ECharts）按需加载：仅在选中台风后才渲染，避免首屏连带加载 ~160KB gzip
const IntensityChart = defineAsyncComponent(() => import('./components/IntensityChart.vue'))

const mapContainer = ref<HTMLElement | null>(null)
const { amap, map, ready, error } = useAmapMap(mapContainer)

// —— 编排层：数据 / 回放 / 图层开关各自封装，组件只负责渲染与布局 ——
const {
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
  switchMode: switchModeRaw,
} = useTyphoonData()

const { frameIndex, playing, highlightTime, shownPoint, frameLabel, setFrameIndex, togglePlay } =
  usePlayback(typhoon)

const {
  showCloud,
  showRadar,
  showWind,
  radarLoading,
  windLoading,
  layerError,
  notifyLayerError,
} = useLayerToggles()

// 移动端判定与 CSS 断点一致（≤768px）：只挂载一套 UI，避免隐藏端 ECharts 以 0 尺寸初始化
const mqMobile = window.matchMedia('(max-width: 768px)')
const isMobile = ref(mqMobile.matches)
function onMqChange(e: MediaQueryListEvent) {
  isMobile.value = e.matches
}

// 移动端：抽屉详情展开态（false=收起信息条）；图例弹出卡开关与卡片 DOM
const detailExpanded = ref(false)
const mobileLegendOpen = ref(false)
const legendPopEl = ref<HTMLElement | null>(null)

// 移动端：选中台风时收起详情并关闭图例弹出
function handleSelect(id: string) {
  selectTyphoon(id)
  detailExpanded.value = false
  mobileLegendOpen.value = false
}
function handleClear() {
  clearSelection()
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

// 移动端抽屉信息条：当前路径点的强度名/色/风速
const lastInfo = computed(() => {
  const p = shownPoint.value
  if (!p) return null
  const lvl = levelForCode(p.level, p.wind)
  return { name: lvl.name, color: lvl.color, wind: p.wind }
})

// 数据时次（观测时间，比「拉取时刻」更诚实）；无选中时取第一个台风
const dataTime = computed(() => {
  const t = typhoon.value ?? typhoons.value[0]
  if (!t || t.path.length === 0) return null
  return t.path[t.path.length - 1].time
})

// 历史模式年份选项：1949（CMA 有记录的最早年份）~ 当前年，倒序
const yearOptions = computed(() => {
  const cur = new Date().getFullYear()
  const arr: number[] = []
  for (let y = cur; y >= 1949; y--) arr.push(y)
  return arr
})

// 列表标题：实时=活跃台风；历史=所选年份台风
const listLabel = computed(() =>
  mode.value === 'live'
    ? `活跃台风 ${list.value.length} 个`
    : `${historyYear.value} 年台风 ${list.value.length} 个`,
)

async function switchMode(m: Mode) {
  detailExpanded.value = false
  mobileLegendOpen.value = false
  await switchModeRaw(m)
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  mqMobile.addEventListener('change', onMqChange)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  mqMobile.removeEventListener('change', onMqChange)
})
</script>

<template>
  <div class="app">
    <div ref="mapContainer" class="map-container" />

    <TyphoonLayer
      :amap="amap"
      :map="map"
      :typhoons="typhoons"
      :selected-id="activeId"
      :frame-index="frameIndex"
      :highlight-time="highlightTime"
    />

    <ImageryLayer
      :amap="amap"
      :map="map"
      :show-cloud="showCloud"
      :show-radar="showRadar"
      @loading="radarLoading = true"
      @ready="radarLoading = false"
      @error="notifyLayerError"
    />
    <WindFieldLayer
      :amap="amap"
      :map="map"
      :enabled="showWind"
      @loading="windLoading = true"
      @ready="windLoading = false"
      @error="notifyLayerError"
    />

    <!-- UI 浮层容器：桌面端子项仍为绝对定位（不受 flex 影响），
         手机端媒体查询中改为纵向 flex 流式排列 -->
    <div v-if="!isMobile" class="ui-layer">
      <!-- 左上：品牌 + 台风列表 -->
      <div class="glass top-left">
        <div class="brand">🌀 实时台风路径</div>
        <div class="mode-toggle">
          <button :class="{ on: mode === 'live' }" @click="switchMode('live')">实时</button>
          <button :class="{ on: mode === 'history' }" @click="switchMode('history')">历史</button>
        </div>
        <div v-if="mode === 'history'" class="year-row">
          <span class="year-label" id="year-label-desk">年份</span>
          <select
            v-model.number="historyYear"
            class="year-select"
            aria-labelledby="year-label-desk"
            @change="loadList"
          >
            <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
          </select>
        </div>
        <div class="sub">{{ listLabel }}</div>
        <TyphoonList :list="list" :active-id="activeId" :loading="loading" @select="selectTyphoon" />
      </div>

      <!-- 底部左：实况卡（选中某台风时才显示） -->
      <div v-if="typhoon" class="glass bottom-left">
        <StatusCard :typhoon="typhoon" :frame-index="frameIndex" />
      </div>

      <!-- 底部右：路径回放 + 强度曲线（选中某台风时才显示） -->
      <div v-if="typhoon" class="glass bottom-right">
        <PlaybackBar
          v-if="typhoon.path.length > 1"
          :total="typhoon.path.length"
          :index="frameIndex"
          :playing="playing"
          :label="frameLabel"
          @update:index="setFrameIndex"
          @toggle="togglePlay"
        />
        <IntensityChart :typhoon="typhoon" @hover="highlightTime = $event" />
      </div>

      <!-- 顶部中：数据时次 + 拉取时间 + 刷新 -->
      <div class="glass top-center">
        <span class="tc-updated">
          <template v-if="dataTime">数据 {{ fmtCn(dataTime) }}</template>
          <template v-else>加载中…</template>
          <small v-if="cachedAt" class="tc-cache"> · 缓存于 {{ fmtClock(cachedAt.getTime()) }}（网络异常）</small>
          <small v-else-if="updatedAt" class="tc-fetch"> · {{ fmtClock(updatedAt.getTime()) }} 拉取</small>
        </span>
        <button class="tc-refresh" :disabled="refreshing" aria-label="刷新数据" @click="refresh">
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
              <LayerChips
                v-model:cloud="showCloud"
                v-model:radar="showRadar"
                v-model:wind="showWind"
                :radar-loading="radarLoading"
                :wind-loading="windLoading"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 移动端 UI（≤768px 显示；桌面端由 CSS 隐藏） -->
    <div v-if="isMobile" class="m-ui">
      <!-- 顶部细条：品牌 + 更新时间 + 刷新 -->
      <div class="m-topbar glass">
        <span class="m-brand">🌀 实时台风</span>
        <span class="m-updated">
          <template v-if="dataTime">数据 {{ fmtCn(dataTime) }}</template>
          <template v-else>加载中…</template>
          <small v-if="cachedAt" class="tc-cache"> · 缓存</small>
        </span>
        <button class="m-refresh" :disabled="refreshing" aria-label="刷新数据" @click="refresh">
          {{ refreshing ? '刷新中…' : '↻' }}
        </button>
      </div>

      <!-- 底部工具条：图层开关 + 图例 -->
      <div class="m-toolbar glass">
        <LayerChips
          v-model:cloud="showCloud"
          v-model:radar="showRadar"
          v-model:wind="showWind"
          :radar-loading="radarLoading"
          :wind-loading="windLoading"
          compact
        />
        <button
          class="m-legend-btn"
          :aria-expanded="mobileLegendOpen"
          aria-label="图例"
          @click.stop="mobileLegendOpen = !mobileLegendOpen"
        >
          ☰ 图例
        </button>
      </div>

      <!-- 底部抽屉：列表态 / 详情收起态 / 详情展开态 -->
      <div class="m-drawer glass" :class="{ 'is-expanded': detailExpanded }">
        <!-- 列表态 -->
        <template v-if="!activeId">
          <div class="m-drawer-head">
            <span>{{ listLabel }}</span>
          </div>
          <div class="m-mode-row">
            <div class="m-mode">
              <button :class="{ on: mode === 'live' }" @click="switchMode('live')">实时</button>
              <button :class="{ on: mode === 'history' }" @click="switchMode('history')">历史</button>
            </div>
            <select v-if="mode === 'history'" v-model.number="historyYear" class="year-select" @change="loadList">
              <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
            </select>
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
          <PlaybackBar
            v-if="typhoon.path.length > 1"
            :total="typhoon.path.length"
            :index="frameIndex"
            :playing="playing"
            :label="frameLabel"
            @update:index="setFrameIndex"
            @toggle="togglePlay"
          />
          <!-- 用 v-if 而非 v-show：收起时 ECharts 容器高度为 0，初始化会告警且尺寸错误 -->
          <div v-if="detailExpanded" class="m-drawer-body">
            <StatusCard :typhoon="typhoon" :frame-index="frameIndex" />
            <IntensityChart :typhoon="typhoon" @hover="highlightTime = $event" />
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
    <div v-else-if="layerError" class="toast toast-error">{{ layerError }}</div>
    <div v-else-if="!loading && ready && list.length === 0 && !listError" class="toast">
      {{ mode === 'live' ? '当前无活跃台风' : `${historyYear} 年暂无台风数据` }}
    </div>
  </div>
</template>
