/**
 * 时间格式化（各组件共用的几种短格式）
 * 统一在此维护，避免各组件各写一份 pad/年月日拼接。
 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** YYYY-MM-DD HH:mm（顶部更新时间） */
export function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** MM-DD HH:mm（实况卡、路径点弹窗、登陆点标注） */
export function fmtShort(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** M月D日 HH时（数据时次展示） */
export function fmtCn(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}时`
}

/** HH:mm（拉取时刻） */
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** MM-DD HH:00（强度曲线横轴，数据为逐小时整点） */
export function fmtHour(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
}
