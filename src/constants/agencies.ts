/**
 * 预报机构代码 → 中文名
 * CMA 预报对象按机构分键，实测常见 BABJ；其余机构出现时用于图例/提示。
 */
const AGENCY_NAMES: Record<string, string> = {
  BABJ: '中央气象台',
  RJTD: '日本气象厅',
  VHHH: '香港天文台',
  PGTW: '联合台风警报中心',
  KWBC: '美国国家气象局',
  RKSL: '韩国气象厅',
  BCSG: '越南国家水文气象预报中心',
}

/** 机构中文名（未知代码原样返回） */
export function agencyName(code: string): string {
  return AGENCY_NAMES[code] ?? code
}
