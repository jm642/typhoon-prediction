<script setup lang="ts">
/**
 * 强度演变曲线（spec §7 亮点⑦）：风速(m/s) + 中心气压(hPa)
 * 用 ECharts；气压轴反向（气压越低台风越强，视觉上强时曲线下探）。
 * 按需引入（折线图 + 网格/提示/图例 + Canvas 渲染器），避免打包 ECharts 全量。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { init, use, type ECharts } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { NormalizedTyphoon } from '../types/typhoon'
import { fmtHour } from '../lib/format'

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{ typhoon: NormalizedTyphoon | null }>()

const el = ref<HTMLElement | null>(null)
let chart: ECharts | null = null
let ro: ResizeObserver | null = null

function render() {
  if (!chart) return
  const t = props.typhoon
  if (!t || t.path.length === 0) {
    chart.clear()
    return
  }
  const pts = [...t.path].sort((a, b) => a.time - b.time)
  // 时间轴（而非类目轴）：历史台风缺时次时点位间距才真实，等距排布会失真
  const wind = pts.map((p) => [p.time, p.wind])
  const press = pts.map((p) => [p.time, p.pressure])
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,21,38,.92)', borderColor: 'rgba(148,180,220,.25)', textStyle: { color: '#dbe4f0', fontSize: 11 } },
    // 图例居中：靠右会与右侧气压轴名「hPa」重叠
    legend: { data: ['风速', '气压'], textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0, left: 'center', itemWidth: 14, itemHeight: 8 },
    grid: { left: 36, right: 42, top: 24, bottom: 22 },
    xAxis: {
      type: 'time',
      // 窄屏（手机抽屉）宽度小，靠 hideOverlap 丢弃重叠刻度，否则标签会挤成一团
      axisLabel: { color: '#7d93b5', fontSize: 9, formatter: (v: number) => fmtHour(v), hideOverlap: true },
      axisLine: { lineStyle: { color: 'rgba(148,180,220,.2)' } },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: 'm/s',
        nameTextStyle: { color: '#7d93b5', fontSize: 9 },
        splitLine: { lineStyle: { color: 'rgba(148,180,220,.08)' } },
        axisLabel: { color: '#7d93b5', fontSize: 9 },
      },
      {
        type: 'value',
        name: 'hPa',
        // 不从 0 起算（否则 900~1000 hPa 被压成一条贴底线）；不反向：气压越低曲线越靠下，
        // 与「越强越靠上」的风速曲线形成镜像，两条线不会重叠在一起
        scale: true,
        nameTextStyle: { color: '#7d93b5', fontSize: 9 },
        splitLine: { show: false },
        axisLabel: { color: '#7d93b5', fontSize: 9 },
      },
    ],
    series: [
      {
        name: '风速',
        type: 'line',
        data: wind,
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#38bdf8', width: 2 },
        itemStyle: { color: '#38bdf8' },
        areaStyle: { color: 'rgba(56,189,248,.08)' },
      },
      {
        name: '气压',
        type: 'line',
        yAxisIndex: 1,
        data: press,
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#fb923c', width: 2 },
        itemStyle: { color: '#fb923c' },
      },
    ],
  })
}

onMounted(() => {
  if (el.value) {
    chart = init(el.value)
    render()
    // 容器尺寸变化（如抽屉展开/收起）时自动 resize
    ro = new ResizeObserver(() => chart?.resize())
    ro.observe(el.value)
  }
})

onUnmounted(() => {
  ro?.disconnect()
  ro = null
  chart?.dispose()
  chart = null
})

watch(() => props.typhoon, render)
</script>

<template>
  <div class="chart-title">强度演变</div>
  <div ref="el" class="chart-body" />
</template>
