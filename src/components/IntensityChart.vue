<script setup lang="ts">
/**
 * 强度演变曲线（spec §7 亮点⑦）：风速(m/s) + 中心气压(hPa)
 * 用 ECharts；气压轴反向（气压越低台风越强，视觉上强时曲线下探）。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { NormalizedTyphoon } from '../types/typhoon'

const props = defineProps<{ typhoon: NormalizedTyphoon | null }>()

const el = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

function fmt(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`
}

function render() {
  if (!chart) return
  const t = props.typhoon
  if (!t || t.path.length === 0) {
    chart.clear()
    return
  }
  const pts = [...t.path].sort((a, b) => a.time - b.time)
  const times = pts.map((p) => fmt(p.time))
  const wind = pts.map((p) => p.wind)
  const press = pts.map((p) => p.pressure)
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,21,38,.92)', borderColor: 'rgba(148,180,220,.25)', textStyle: { color: '#dbe4f0', fontSize: 11 } },
    legend: { data: ['风速', '气压'], textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0, right: 0, itemWidth: 14, itemHeight: 8 },
    grid: { left: 36, right: 42, top: 24, bottom: 22 },
    xAxis: {
      type: 'category',
      data: times,
      axisLabel: { color: '#7d93b5', fontSize: 9 },
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
        inverse: true,
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

function resize() {
  chart?.resize()
}

onMounted(() => {
  if (el.value) chart = echarts.init(el.value)
  render()
  window.addEventListener('resize', resize)
})

onUnmounted(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = null
})

watch(() => props.typhoon, render)
</script>

<template>
  <div class="chart-title">强度演变</div>
  <div ref="el" class="chart-body" />
</template>
