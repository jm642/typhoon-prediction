# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

实时台风路径可视化 Web 应用（作品集/学习目的）：Vue 3 + Vite + TypeScript + 高德地图 JS API 2.0。**纯前端静态站，无后端**（ADR-0002）——浏览器直接跨域请求外部气象接口。

- **唯一权威实现依据**：`docs/spec.md`；架构决策见 `docs/adr/`；领域术语（台风 ID vs 编号、路径点、风圈等）见 `CONTEXT.md`。
- 本项目文档与代码注释均为中文，新增注释/文档请保持一致。

## 常用命令

```bash
npm run dev        # 本地开发（端口 5173）
npm run build      # vue-tsc 类型检查 + vite build（构建前会先过类型检查）
npm run typecheck  # 仅类型检查（vue-tsc --noEmit）
npm run smoke      # 冒烟测试：真实请求 CMA 台风接口，验证剥壳+归一化逻辑
```

无测试框架、无 lint 配置；验证改动主要靠 `npm run typecheck`、`npm run smoke` 和本地 `dev` 跑通。

**环境要求**：复制 `.env.example` 为 `.env` 并填入高德 Key（`VITE_AMAP_KEY` / `VITE_AMAP_SECURITY_JSCODE`），否则地图不渲染（页面会显示错误提示）。

## 架构要点

### 数据流：api 层是唯一数据入口

```
src/api/*.ts（抓取 + 剥壳 + 归一化） → src/types 归一化类型 → Vue 组件消费
```

组件不接触原始接口。未来若加后端代理，只改 `src/api/typhoon.ts` 内部实现。

### 三个数据源各有各的坑（改动前先读文件头注释）

- **`src/api/typhoon.ts`**（CMA 台风网 typhoon.nmc.cn）：
  - 响应是 **JSONP 包装**，必须 `response.text()` → `unwrapJsonp()`（取首个 `{` 到末个 `}`）→ `JSON.parse`，`response.json()` 会失败。
  - **勿加自定义请求头**（触发 preflight → 405）。
  - 经度是 0~360° 记法（跨日期变更线 >180°）。
  - 预报只取**最新时次**路径点的预报快照（每个历史路径点都带一份当时预报，全收集会导致预报线穿过过去）。
  - `scripts/smoke-api.mjs` 是该模块归一化逻辑的**独立 JS 副本**（可脱离构建直接跑），修改归一化逻辑时两处要同步。
- **`src/api/imagery.ts`**（卫星云图 NASA GIBS + 雷达 NMC）：
  - 卫星：z≤6 红外 Band13，z≥7 切可见光 Band3（Level7），z>7 overzoom 复用 z7 瓦片（见 ADR-0003）。
  - 雷达：NMC 先 GET 时间戳 JSONP 再挂 2×2 分块 ImageLayer。
- **`src/api/windField.ts`**（浙江水利厅台风网 GFS 风场）：模块级 3 小时缓存 + inflight 去重；`windData` 字段是 JSON 字符串需二次解析。

### 地图与图层

- `src/composables/useAmapMap.ts` 独占高德实例生命周期（`AMapLoader.load` → `new AMap.Map` → unmount 时 `destroy`）。
- `App.vue` 把 `amap`/`map` 传给各图层组件；`TyphoonLayer`（路径/风圈/预报自绘覆盖物）、`ImageryLayer`、`WindFieldLayer` 各自 watch 数据变化重建 overlay。不用 `AMap.GeoJSON`（官方类型包未声明）。
- `src/lib/windy.ts`：风场粒子引擎，忠实移植自 cambecc/earth，**与原版 1:1 对齐**，唯一差异是去掉 Leaflet 耦合、改由构造参数注入 `project`/`invert` 投影函数。不要"顺手优化"这个文件。
- 坐标系：数据均为 WGS-84，直接叠在高德 GCJ-02 底图上（偏移数百米，有意不转换，见 spec §5）。

### 布局

单页沉浸式地图 + 玻璃拟态浮层。桌面端各面板绝对定位；≤768px 手机端用底部抽屉模型：`.ui-layer` 桌面面板整体隐藏，`.m-ui` 容器接管（顶部细条 `.m-topbar` / 底部工具条 `.m-toolbar` / 底部抽屉 `.m-drawer` 列表-收起-展开三态 / 图例弹出 `.m-legend-pop`，图例三区块由共享组件 `LegendContent.vue` 渲染）。改 UI 时两个断点的样式都要检查。

## 部署

GitHub Pages：`.github/workflows/deploy.yml`（push main 自动构建部署；`vite.config.ts` 的 `base: './'`）。构建时需仓库 Secrets 提供 `VITE_AMAP_KEY` / `VITE_AMAP_SECURITY_JSCODE`。

## 目录说明

- `wayfinder/`、`prototype/`、`docs/`：规划、研究与原型记录，已被 gitignore（本地资料）。其中 `prototype/` 是抛弃式原型，仅作参考，不要把改动同步进去。
- `scripts/`：冒烟与诊断脚本；`tmp-*` / `diag-*` 前缀为临时排查脚本，可忽略。
