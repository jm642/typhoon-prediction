<script setup lang="ts">
import { computed } from 'vue'
import type { NormalizedTyphoon } from '../types/typhoon'
import { levelForCode } from '../constants/levels'
import { fmtShort } from '../lib/format'

const props = defineProps<{
  typhoon: NormalizedTyphoon | null
  /** 路径回放游标；null = 显示最新时次 */
  frameIndex?: number | null
}>()

const last = computed(() => {
  const t = props.typhoon
  if (!t || t.path.length === 0) return null
  const i = props.frameIndex
  return i == null ? t.path[t.path.length - 1] : t.path[Math.min(i, t.path.length - 1)]
})
const lv = computed(() => levelForCode(last.value?.level, last.value?.wind))
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
        <span>{{ frameIndex == null ? '观测时间' : '回放时次' }}</span><b>{{ fmtShort(last.time) }}</b>
      </div>
    </div>
  </div>
  <div v-else class="status s-empty">暂无实况</div>
</template>
