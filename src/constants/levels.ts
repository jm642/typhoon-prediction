/**
 * 台风强度等级（CMA 六级标准）与色标（spec §5）
 */
export interface IntensityLevel {
  code: string
  name: string
  minWind: number
  color: string
}

export const LEVELS: IntensityLevel[] = [
  { code: 'TD', name: '热带低压', minWind: 0, color: '#22c55e' },
  { code: 'TS', name: '热带风暴', minWind: 17.2, color: '#38bdf8' },
  { code: 'STS', name: '强热带风暴', minWind: 24.5, color: '#facc15' },
  { code: 'TY', name: '台风', minWind: 32.7, color: '#fb923c' },
  { code: 'STY', name: '强台风', minWind: 41.5, color: '#ef4444' },
  { code: 'SuperTY', name: '超强台风', minWind: 51, color: '#e879f9' },
]

/** 按风速判定等级 */
export function levelForWind(wind: number): IntensityLevel {
  let level = LEVELS[0]
  for (const l of LEVELS) if (wind >= l.minWind) level = l
  return level
}

/** 按 CMA 强度码判定等级（兼容大小写：SuperTY / SUPERTY） */
export function levelForCode(code: string | null | undefined): IntensityLevel {
  if (!code) return LEVELS[0]
  const key = code.toLowerCase()
  const level = LEVELS.find((l) => l.code.toLowerCase() === key)
  return level ?? LEVELS[0]
}
