<script setup lang="ts">
import { computed } from 'vue'
import type { NormalizedTyphoon } from '../types/typhoon'
import { levelForCode } from '../constants/levels'

const props = defineProps<{ typhoon: NormalizedTyphoon | null }>()

const last = computed(() => {
  const t = props.typhoon
  if (!t || t.path.length === 0) return null
  return t.path[t.path.length - 1]
})
const lv = computed(() => levelForCode(last.value?.level))

function fmt(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <div v-if="typhoon && last" class="status">
    <div class="s-head">
      <span class="s-name">{{ typhoon.nameCn ?? typhoon.nameEn }}</span>
      <span class="s-en">{{ typhoon.nameEn }} · 编号{{ typhoon.code }}</span>
      <span class="s-badge" :style="{ background: lv.color }">{{ lv.name }}</span>
    </div>
    <div class="s-kv">
      <div class="s-cell">
        <span>最大风速</span><b>{{ last.wind }}<small> m/s</small></b>
      </div>
      <div class="s-cell">
        <span>中心气压</span><b>{{ last.pressure }}<small> hPa</small></b>
      </div>
      <div class="s-cell">
        <span>当前位置</span><b>{{ last.lat.toFixed(1) }}°N {{ last.lng.toFixed(1) }}°E</b>
      </div>
      <div class="s-cell">
        <span>观测时间</span><b>{{ fmt(last.time) }}</b>
      </div>
    </div>
  </div>
  <div v-else class="status s-empty">暂无实况</div>
</template>
