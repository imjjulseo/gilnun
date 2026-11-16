import type { StyleSpecification } from 'maplibre-gl'
export type ThemeName = 'light' | 'night'
export type Kind = 'k' | 'w' | 'g'           // 하늘, 물, 녹지
export interface Theme {
  bg: string; surf: string; line: string; ink: string; sub: string; acc: string; onAcc: string
  land: string; river: string; park: string; block: string; road: string; label: string
  none: string; ramp: Record<Kind, [string, string, string, string]>; dot: Record<Kind, string>
}
export const THEMES: Record<ThemeName, Theme> = {
  light: {
    bg: '#FFFFFF', surf: '#F3F6FA', line: '#E1E7EE', ink: '#16202B', sub: '#55616E', acc: '#1D64D8', onAcc: '#FFFFFF',
    land: '#F7F9FB', river: '#DCEAF8', park: '#E9F2E6', block: '#ECF0F4', road: '#FFFFFF', label: '#6B7682',
    none: '#D5DCE4',
    ramp: { k: ['#CFEAFB', '#8FD3F7', '#4DB8EE', '#149BD8'], w: ['#B9C3E6', '#7F90D0', '#4257A8', '#1B2A6B'], g: ['#CFE8D2', '#93D0A0', '#4FAE68', '#1E7A3C'] },
    dot: { k: '#4DB8EE', w: '#2B3D8C', g: '#4FAE68' },
  },
  night: {
    bg: '#141829', surf: '#1E2440', line: '#2E3558', ink: '#F5EFE7', sub: '#B4BAD0', acc: '#FFA872', onAcc: '#1A1420',
    land: '#181D33', river: '#1B2C52', park: '#1A2A30', block: '#20263F', road: '#242B49', label: '#8E96B4',
    none: '#333A60',
    ramp: { k: ['#24506B', '#2F7DA8', '#4FB4E6', '#A5E1FF'], w: ['#2E2F6E', '#4A4CB0', '#7375E8', '#B4B6FF'], g: ['#2C5A44', '#3C8660', '#55B884', '#96E3B4'] },
    dot: { k: '#4FB4E6', w: '#7375E8', g: '#55B884' },
  },
}
const BASE = 'https://tiles.openfreemap.org/styles/positron'
let cache: StyleSpecification | null = null
/** OpenFreeMap 기본 스타일을 받아 테마 색으로 다시 칠한다. 받지 못하면 바탕색만 있는 스타일로 대신한다. */
export async function basemap(t: Theme): Promise<StyleSpecification> {
  if (!cache) {
    try { cache = await (await fetch(BASE)).json() } catch { cache = null }
  }
  if (!cache) return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': t.land } }] }
  const s: StyleSpecification = JSON.parse(JSON.stringify(cache))
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
