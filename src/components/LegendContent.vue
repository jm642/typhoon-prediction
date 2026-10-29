<script setup lang="ts">
import { LEVELS } from '../constants/levels'
import { WIND_CIRCLE_LEVELS } from '../constants/windCircles'
</script>

<template>
  <div class="legend-body">
    <div class="legend-title">沿海警戒线</div>
    <div class="legend-item"><span class="legend-line solid"></span>24 小时</div>
    <div class="legend-item"><span class="legend-line dashed"></span>48 小时</div>

    <div class="legend-title legend-gap">强度等级</div>
    <div v-for="l in LEVELS" :key="l.code" class="legend-item">
      <span class="legend-dot" :style="{ background: l.color }"></span>{{ l.name }}
    </div>

    <div class="legend-title legend-gap">预报路径</div>
    <div class="legend-item"><span class="legend-line dashed forecast-main"></span>主机构（按强度着色）</div>
    <div class="legend-item"><span class="legend-line dashed forecast-other"></span>其他机构</div>

    <div class="legend-title legend-gap">登陆点</div>
    <div class="legend-item"><span class="legend-landfall">⚓ 登陆</span>已发生（推断）</div>
    <div class="legend-item">
      <span class="legend-landfall legend-landfall--forecast">⏱ 预计</span>由预报推断
    </div>

    <div class="legend-title legend-gap">风圈等级</div>
    <div v-for="l in WIND_CIRCLE_LEVELS" :key="l.code" class="legend-item">
      <span class="legend-dot" :style="{ background: l.stroke }"></span>{{ l.name }}
    </div>
  </div>
</template>
