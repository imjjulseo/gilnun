import type { StyleSpecification } from 'maplibre-gl'
export type ThemeName = 'light' | 'night'
export type Kind = 'k' | 'w' | 'g'           // 하늘, 물, 녹지
export interface Theme {
  bg: string; surf: string; line: string; ink: string; sub: string; acc: string; onAcc: string
  land: string; river: string; park: string; block: string; road: string; label: string
  none: string; ramp: Record<Kind, [string, string, string, string]>; dot: Record<Kind, string>
  dusk: { ramp: [string, string, string, string]; dot: string }   // 노을 때 하늘 길 색
  starry: { ramp: [string, string, string, string]; dot: string; star: string }   // 밤 하늘 길 색과 별빛
}
export const THEMES: Record<ThemeName, Theme> = {
  light: {
    bg: '#FFFFFF', surf: '#F3F6FA', line: '#E1E7EE', ink: '#16202B', sub: '#55616E', acc: '#1D64D8', onAcc: '#FFFFFF',
    land: '#F7F9FB', river: '#DCEAF8', park: '#E9F2E6', block: '#ECF0F4', road: '#FFFFFF', label: '#6B7682',
    none: '#D5DCE4',
    ramp: { k: ['#CFEAFB', '#8FD3F7', '#4DB8EE', '#149BD8'], w: ['#B9C3E6', '#7F90D0', '#4257A8', '#1B2A6B'], g: ['#CFE8D2', '#93D0A0', '#4FAE68', '#1E7A3C'] },
    dot: { k: '#4DB8EE', w: '#2B3D8C', g: '#4FAE68' },
    dusk: { ramp: ['#FBE1D2', '#F6B894', '#EC8863', '#CF5E4A'], dot: '#EC8863' },
    starry: { ramp: ['#E6DEF2', '#C6B2E4', '#9D7FD0', '#6B48A8'], dot: '#9D7FD0', star: '#F7C948' },
  },
  night: {
    bg: '#141829', surf: '#1E2440', line: '#2E3558', ink: '#F5EFE7', sub: '#B4BAD0', acc: '#F4E4C9', onAcc: '#1A1420',
    land: '#181D33', river: '#1B2C52', park: '#1A2A30', block: '#20263F', road: '#242B49', label: '#8E96B4',
    none: '#333A60',
    ramp: { k: ['#24506B', '#2F7DA8', '#4FB4E6', '#A5E1FF'], w: ['#2E2F6E', '#4A4CB0', '#7375E8', '#B4B6FF'], g: ['#2C5A44', '#3C8660', '#55B884', '#96E3B4'] },
    dot: { k: '#4FB4E6', w: '#7375E8', g: '#55B884' },
    dusk: { ramp: ['#4E3452', '#94506A', '#E27C62', '#FFC28F'], dot: '#E27C62' },
    starry: { ramp: ['#3B3352', '#6E5C8E', '#BCA6DC', '#F1E6FF'], dot: '#BCA6DC', star: '#FFF1C4' },
  },
}
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
function mix(a: string, b: string, t: number): string {
  const x = hex(a), y = hex(b)
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
/** 하늘 길 색이 실제 하늘을 따라간다. 낮 하늘색에서 노을색, 밤에는 보라빛 남색으로 바뀐다. */
export function withSky(name: ThemeName, sky: { dusk: number; night: number }): Theme {
  const b = THEMES[name], d = Math.max(0, Math.min(1, sky.dusk)), n = Math.max(0, Math.min(1, sky.night))
  if (d === 0 && n === 0) return b
  const at = (i: number) => mix(mix(b.ramp.k[i], b.dusk.ramp[i], d), b.starry.ramp[i], n)
  return { ...b, ramp: { ...b.ramp, k: [0, 1, 2, 3].map(at) as Theme['ramp']['k'] }, dot: { ...b.dot, k: mix(mix(b.dot.k, b.dusk.dot, d), b.starry.dot, n) } }
}
export { mix }
const BASE = 'https://tiles.openfreemap.org/styles/positron'
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'
/** 지도 위 글자에 쓰는 글꼴(바탕 지도 스타일에 있는 것) */
export let FONT: string[] = ['Noto Sans Regular']
let cache: StyleSpecification | null = null
/** OpenFreeMap 기본 스타일을 받아 테마 색으로 다시 칠한다. 받지 못하면 바탕색만 있는 스타일로 대신한다. */
export async function basemap(t: Theme): Promise<StyleSpecification> {
  if (!cache) {
    try { cache = await (await fetch(BASE)).json() } catch { cache = null }
  }
  if (!cache) return { version: 8, glyphs: GLYPHS, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': t.land } }] }
  const s: StyleSpecification = JSON.parse(JSON.stringify(cache))
  const f = (s.layers as any[]).find((l) => l.layout?.['text-font'])?.layout['text-font']
  if (Array.isArray(f)) FONT = f
  s.layers = s.layers.filter((l: any) => !(l.type === 'symbol' && (l['source-layer'] === 'poi' || l['source-layer'] === 'aerodrome_label' || (l['source-layer'] === 'transportation_name' && l.layout?.['icon-image']))))
  for (const l of s.layers as any[]) {
    const sl = l['source-layer']; l.paint = l.paint ?? {}
    if (l.type === 'background') l.paint['background-color'] = t.land
    else if (l.type === 'fill') {
      if (sl === 'water') l.paint['fill-color'] = t.river
      else if (sl === 'building') { l.paint['fill-color'] = t.block; delete l.paint['fill-outline-color'] }
      else if (sl === 'park' || sl === 'landcover') l.paint['fill-color'] = t.park
      else l.paint['fill-color'] = t.land
      delete l.paint['fill-pattern']
    } else if (l.type === 'line') {
      if (sl === 'waterway') l.paint['line-color'] = t.river
      else if (sl === 'transportation') l.paint['line-color'] = t.road
      else l.paint['line-color'] = t.line
    } else if (l.type === 'symbol') {
      l.paint['text-color'] = t.label; l.paint['text-halo-color'] = t.land; l.paint['text-halo-width'] = 1.2
      if (l.layout?.['text-field']) l.layout['text-field'] = ['coalesce', ['get', 'name:ko'], ['get', 'name'], ['get', 'name:latin']]   // 지명은 한글로
    } else if (l.type === 'fill-extrusion') { l.paint['fill-extrusion-color'] = t.block }
  }
  return s
}
