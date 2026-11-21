/** 날씨(Open-Meteo, 키 없음). 지역 가운데 좌표로만 부른다(내 위치는 보내지 않는다). 30분 동안 다시 부르지 않는다. */
export interface Weather { at: number; temp: number; cloud: number; rain: boolean; prob: number }
const KEY = 'gn.weather'
export async function getWeather(lon: number, lat: number): Promise<Weather | null> {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null') as Weather | null
    if (c && Date.now() - c.at < 30 * 60e3) return c
  } catch { /* */ }
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,precipitation,cloud_cover&hourly=precipitation_probability&forecast_hours=2&timezone=Asia%2FSeoul`
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000)
    const j = await (await fetch(u, { signal: ctl.signal })).json(); clearTimeout(t)
    const prob = Math.max(...((j.hourly?.precipitation_probability as number[]) ?? [0]).slice(0, 2))
    const w: Weather = { at: Date.now(), temp: j.current.temperature_2m, cloud: j.current.cloud_cover, rain: j.current.precipitation >= 0.1 || prob >= 70, prob }
    try { localStorage.setItem(KEY, JSON.stringify(w)) } catch { /* */ }
    return w
  } catch { return null }
}

/** 지금 맞춤: 날씨와 해에 따라 트인 길이 더 보는 것 */
export type Fit = 'none' | 'sunset' | 'shade' | 'rain'
export function pickFit(w: Weather | null, sun: { alt: number }, sunsetTime: boolean): Fit {
  if (w?.rain) return 'rain'
  if (sunsetTime && (!w || w.cloud < 85)) return 'sunset'          // 아주 흐리면 노을이 안 보인다
  if (w && w.temp >= 26 && sun.alt >= 20 && w.cloud <= 60) return 'shade'
  return 'none'
}
export const FIT_REASON: Record<Fit, string> = {
  none: '',
  sunset: '해 질 무렵이라 해 지는 쪽이 트인 길로 골랐어요.',
  shade: '볕이 강해서 그늘진 구간이 많은 길로 골랐어요.',
  rain: '비가 와서 건물 안과 지하로 이어지는 길을 더 골랐어요.',
}
