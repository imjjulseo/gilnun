/** 해 뜨고 지는 시각 (NOAA 간이식, 오차 1~2분). 서울 기준 좌표를 기본으로 쓴다. */
const RAD = Math.PI / 180
function times(date: Date, lat = 37.51, lon = 126.94): { rise: Date; set: Date } {
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const n = Math.floor((day - Date.UTC(2000, 0, 1, 12)) / 864e5) + 1
  const J = n - lon / 360
  const M = (357.5291 + 0.98560028 * J) % 360
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD)
  const L = (M + C + 180 + 102.9372) % 360
  const T = 2451545 + J + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD)
  const dec = Math.asin(Math.sin(L * RAD) * Math.sin(23.44 * RAD))
  const w = Math.acos((Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(dec)) / (Math.cos(lat * RAD) * Math.cos(dec))) / RAD
  const toDate = (jd: number) => new Date((jd - 2440587.5) * 864e5)
  return { rise: toDate(T - w / 360), set: toDate(T + w / 360) }
}
export function sunTimes(now = new Date()) { return times(now) }

/** 하늘 길이 노을 색으로 얼마나 바뀌었는지 (0 낮, 1 노을).
 *  해 지기 60분 전부터 서서히 바뀌어 해 질 때 다 바뀌고, 해 뜬 뒤 40분에 걸쳐 돌아온다. */
export function duskMix(now = new Date()): number {
  const { rise, set } = times(now), t = now.getTime()
  const a = set.getTime() - 60 * 6e4, b = set.getTime(), c = rise.getTime(), d = rise.getTime() + 40 * 6e4
  if (t >= b || t < c) return 1
  if (t >= a) return (t - a) / (b - a)
  if (t < d) return 1 - (t - c) / (d - c)
  return 0
}
export const hhmm = (d: Date) => `${d.getHours()}시 ${String(d.getMinutes()).padStart(2, '0')}분`
