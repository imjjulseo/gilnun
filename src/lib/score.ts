import type { Kind } from './theme'
export interface Prefs { k: boolean; w: boolean; g: boolean; calm: boolean }
export const DEFAULT_PREFS: Prefs = { k: true, w: true, g: true, calm: true }
export const KINDS: Kind[] = ['k', 'w', 'g']                 // 하늘, 물, 녹지
export const FLOOR = 12
export const SKY_FIRST = 0.8                                  // 하늘 우선 표시 기준                                       // 이 값 아래는 '뷰가 약한 길'
export interface LinkProps { k: number; w: number; g: number; c: number; ps: number; pw: number; pg: number; pa: number; z: number; r: number }
export interface Rated { kind: Kind | 'n'; v: number }
/** 길 조각 하나의 표시값. 종류마다 따로 계산하고 켜진 것 중 가장 큰 값을 쓴다.
 *  다른 칩을 끄고 켜도 한 종류의 값은 변하지 않는다. */
export function rate(p: LinkProps, prefs: Prefs): Rated {
  const calm = prefs.calm ? Math.min(p.c, 115) / 100 : 1
  let kind: Kind | 'n' = 'n', v = 0
  for (const k of KINDS) {
    if (!prefs[k]) continue
    const val = Math.min(100, p[k] * calm)
    if (val > v) { v = val; kind = k }
  }
  // 하늘이 메인이다. 하늘 값이 가장 큰 값의 SKY_FIRST배 이상이면 하늘색으로 칠한다(값은 바꾸지 않음).
  if (prefs.k && kind !== 'k') {
    const sk = Math.min(100, p.k * calm)
    if (sk >= FLOOR && sk >= v * SKY_FIRST) { kind = 'k'; v = sk }
  }
  return v < FLOOR ? { kind: 'n', v: Math.round(v) } : { kind, v: Math.round(v) }
}
