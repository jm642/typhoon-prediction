<script setup lang="ts">
import type { TyphoonSummary } from '../types/typhoon'

defineProps<{
  list: TyphoonSummary[]
  activeId: string | null
  loading: boolean
}>()

const emit = defineEmits<{ select: [id: string] }>()

// 摘要无强度等级，列表色点用固定循环色区分台风
const COLORS = ['#38bdf8', '#facc15', '#fb923c', '#e879f9', '#22c55e', '#ef4444']
function dotColor(index: number): string {
  return COLORS[index % COLORS.length]
}
</script>

<template>
  <div class="t-list">
    <div v-if="loading" class="t-empty">加载中…</div>
    <div v-else-if="list.length === 0" class="t-empty">暂无活跃台风</div>
    <div
      v-for="(t, i) in list"
      :key="t.id"
      class="t-item"
      :class="{ sel: t.id === activeId }"
      @click="emit('select', t.id)"
    >
      <span class="t-dot" :style="{ background: dotColor(i) }"></span>
      <span class="t-name">{{ t.nameCn ?? t.nameEn }}</span>
      <span class="t-code">{{ t.code }}</span>
    </div>
  </div>
</template>
