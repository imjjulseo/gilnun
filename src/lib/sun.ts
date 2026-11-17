/** 해 위치와 하늘 단계. NOAA 간이식(오차 1~2분, 방위 1도 안팎). 서울 기준 좌표를 기본으로 쓴다. */
const RAD = Math.PI / 180
const LAT = 37.51, LON = 126.94

function julian(t: number) { return t / 864e5 + 2440587.5 }
/** 해의 고도와 방위(도). 방위는 북 0, 동 90, 남 180, 서 270. */
export function sunPos(date = new Date(), lat = LAT, lon = LON): { alt: number; az: number } {
  const d = julian(date.getTime()) - 2451545
  const g = (357.529 + 0.98560028 * d) % 360
  const q = (280.459 + 0.98564736 * d) % 360
  const L = q + 1.915 * Math.sin(g * RAD) + 0.02 * Math.sin(2 * g * RAD)
  const e = 23.439 - 0.00000036 * d
  const ra = Math.atan2(Math.cos(e * RAD) * Math.sin(L * RAD), Math.cos(L * RAD)) / RAD
  const dec = Math.asin(Math.sin(e * RAD) * Math.sin(L * RAD))
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24
  const ha = ((gmst * 15 + lon - ra) % 360) * RAD
  const la = lat * RAD
  const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha))
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha))
  return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 }
}

function times(date: Date, lat = LAT, lon = LON): { rise: Date; set: Date } {
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
/** 오늘 해 지는 방위 */
export function sunsetAz(now = new Date()) { return sunPos(times(now).set).az }

export interface Sky { dusk: number; night: number }
const MIN = 6e4
/** 하늘 단계. dusk는 노을 색 비중, night는 밤 하늘 비중(0~1).
 *  해 지기 60분 전부터 노을로 바뀌어 해 질 때 가장 진하고, 해 진 뒤 40분에 걸쳐 밤이 된다.
 *  아침은 해 뜨기 40분 전부터 밝아져 해 뜰 때 노을, 해 뜬 뒤 40분에 낮이 된다. */
export function skyAt(now = new Date()): Sky {
  const { rise, set } = times(now), t = now.getTime(), s = set.getTime(), r = rise.getTime()
  const ramp = (a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)))
  if (t >= s - 60 * MIN && t < s) return { dusk: ramp(s - 60 * MIN, s), night: 0 }
  if (t >= s && t < s + 40 * MIN) { const k = ramp(s, s + 40 * MIN); return { dusk: 1 - k, night: k } }
  if (t >= r - 40 * MIN && t < r) { const k = ramp(r - 40 * MIN, r); return { dusk: k, night: 1 - k } }
  if (t >= r && t < r + 40 * MIN) return { dusk: 1 - ramp(r, r + 40 * MIN), night: 0 }
  if (t >= s + 40 * MIN || t < r - 40 * MIN) return { dusk: 0, night: 1 }
  return { dusk: 0, night: 0 }
}
/** 노을을 보러 가기 좋은 때: 해 지기 3시간 전부터 해 진 뒤 15분까지 */
export function sunsetWindow(now = new Date()) {
  const s = times(now).set.getTime(), t = now.getTime()
  return t >= s - 180 * MIN && t <= s + 15 * MIN
}
export const hhmm = (d: Date) => `${d.getHours()}시 ${String(d.getMinutes()).padStart(2, '0')}분`
