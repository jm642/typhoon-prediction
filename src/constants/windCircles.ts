/**
 * 风圈等级(CMA 三档:七级/十级/十二级)与配色
 * 与强度等级(constants/levels.ts)是不同概念:强度等级按中心最大风速分六级,
 * 风圈等级是中心周围达到特定风速阈值的半径区域,分三档。
 */
export interface WindCircleLevel {
  /** 风速阈值标识,对应 CMA 原始数据的 level 字段 */
  code: string
  /** 中文名称 */
  name: string
  /** 填充色(半透明,外圈淡内圈深,嵌套叠层) */
  fill: string
  /** 描边色 */
  stroke: string
}

// 配色取自中央气象台台风网(typhoon.nmc.cn) gis.js 的 typhoonCircle_colors：
// 七级黄 #F4D000 → 十级橙 #FD8B00 → 十二级橙红 #FD5C1C，同色系渐进，填充 fillOpacity≈0.3、描边实色细实线
export const WIND_CIRCLE_LEVELS: WindCircleLevel[] = [
  { code: '30KTS', name: '七级风圈', fill: 'rgba(244,208,0,.3)', stroke: '#F4D000' },
  { code: '50KTS', name: '十级风圈', fill: 'rgba(253,139,0,.3)', stroke: '#FD8B00' },
  { code: '64KTS', name: '十二级风圈', fill: 'rgba(253,92,28,.3)', stroke: '#FD5C1C' },
]
