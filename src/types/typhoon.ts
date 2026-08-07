/**
 * 台风领域类型（spec §5 归一化 schema）
 * 数据源 CMA 中央气象台台风网，原始下标数组经 src/api/typhoon.ts 归一化后进入这些类型。
 */

/** 单档风圈:某风速阈值的四象限半径,单位 km */
export interface WindCircle {
  /** 风速阈值标识:'30KTS'(七级) | '50KTS'(十级) | '64KTS'(十二级) */
  level: string
  ne: number
  se: number
  sw: number
  nw: number
}

/** 风圈集合:从外到内多档(弱台风仅七级一档,强台风七/十/十二三档) */
export type WindCircles = WindCircle[]

/** 单个路径点或预报点 */
export interface TyphoonPoint {
  /** 观测时间戳 ms (UTC) */
  time: number
  /** 十进制经度 */
  lng: number
  /** 十进制纬度 */
  lat: number
  /** 中心气压 hPa */
  pressure: number
  /** 最大风速 m/s */
  wind: number
  /** CMA 强度码: TD|TS|STS|TY|STY|SuperTY */
  level: string
  /** 30KTS 四象限风圈（实测路径点有，预报点无） */
  windCircles: WindCircles | null
  /** 仅预报点存在：时距与到达时间 */
  forecast?: {
    hours: number
    arrivalTime: number
  }
}

/** 单台风详情（归一化） */
export interface NormalizedTyphoon {
  /** CMA 台风 ID（如 "3289093"），用于 view_<id> */
  id: string
  nameCn: string | null
  nameEn: string
  /** 台风编号（如 "2614"） */
  code: string
  status: 'start' | 'stop'
  /** 实测路径点 */
  path: TyphoonPoint[]
  /** 预报点（已算好 arrivalTime） */
  forecast: TyphoonPoint[]
}

/** 列表摘要（来自 list_default，无路径点） */
export interface TyphoonSummary {
  id: string
  nameCn: string | null
  nameEn: string
  code: string
  status: 'start' | 'stop'
}
