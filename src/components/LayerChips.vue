<script setup lang="ts">
/**
 * 图层开关（云图 / 雷达 / 全球风场）
 * 桌面端嵌在图例卡里、手机端嵌在底部工具条里，两处共用，避免各写一套。
 * 异步加载的图层（雷达/风场）在加载期间按钮置灰显示 ⏳，防止用户误以为没反应。
 */
defineProps<{
  cloud: boolean
  radar: boolean
  wind: boolean
  radarLoading: boolean
  windLoading: boolean
  /** 手机端宽度紧张，「全球风场」简写为「风场」 */
  compact?: boolean
}>()

const emit = defineEmits<{
  'update:cloud': [value: boolean]
  'update:radar': [value: boolean]
  'update:wind': [value: boolean]
}>()
</script>

<template>
  <button class="layer-chip" :class="{ on: cloud }" @click="emit('update:cloud', !cloud)">
    🛰 云图
  </button>
  <button
    class="layer-chip"
    :class="{ on: radar, loading: radarLoading }"
    :disabled="radarLoading"
    @click="emit('update:radar', !radar)"
  >
    {{ radarLoading ? '⏳ 雷达' : '📡 雷达' }}
  </button>
  <button
    class="layer-chip"
    :class="{ on: wind, loading: windLoading }"
    :disabled="windLoading"
    @click="emit('update:wind', !wind)"
  >
    {{ windLoading ? '⏳ 风场' : compact ? '🌬 风场' : '🌬 全球风场' }}
  </button>
</template>
