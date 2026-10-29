<script setup lang="ts">
/**
 * 路径回放控制条
 * index = null 表示实时态（完整路径 + 预报线）；拖到最右端也回到实时态。
 */
const props = defineProps<{
  /** 实测路径点总数 */
  total: number
  /** 当前回放下标；null = 实时 */
  index: number | null
  playing: boolean
  /** 当前时次文案（如 10-29 08:00） */
  label: string
}>()

const emit = defineEmits<{
  'update:index': [value: number | null]
  toggle: []
}>()

function onInput(e: Event) {
  const max = Math.max(props.total - 1, 0)
  const v = Number((e.target as HTMLInputElement).value)
  emit('update:index', v >= max ? null : v)
}
</script>

<template>
  <div class="playback">
    <button
      class="pb-btn"
      :aria-label="playing ? '暂停回放' : '播放路径'"
      @click="emit('toggle')"
    >
      {{ playing ? '⏸' : '▶' }}
    </button>
    <input
      class="pb-range"
      type="range"
      min="0"
      :max="Math.max(total - 1, 0)"
      :value="index ?? Math.max(total - 1, 0)"
      aria-label="路径回放进度"
      @input="onInput"
    />
    <span class="pb-label">{{ index == null ? '实时' : label }}</span>
  </div>
</template>
