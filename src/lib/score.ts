import type { Kind } from './theme'
export interface Prefs { k: boolean; w: boolean; g: boolean; calm: boolean }
export const DEFAULT_PREFS: Prefs = { k: true, w: true, g: true, calm: true }
const WEIGHT: Record<Kind, number> = { k: 0.6, w: 0.2, g: 0.15 }
const STEPS = [0.12, 0.22, 0.35, 0.5]
export interface LinkProps { k: number; w: number; g: number; c: number; ps: number; pw: number; pg: number; pa: number; z: number; r: number }
/** 길 하나의 표시값. cls는 'n'(약함) 또는 종류+단계('w3'), val은 0~1 점수. */
export function rate(p: LinkProps, prefs: Prefs): { cls: string; val: number; kind: Kind | null } {
  let sum = 0, wsum = 0, best: Kind | null = null, bestV = 0
  for (const kind of ['k', 'w', 'g'] as Kind[]) {
    if (!prefs[kind]) continue
    const s = p[kind] / 100
    sum += WEIGHT[kind] * s; wsum += WEIGHT[kind]
    const lead = s * (kind === 'w' ? 1.2 : 1)
    if (lead > bestV) { bestV = lead; best = kind }
  }
  if (!wsum || !best) return { cls: 'n', val: 0, kind: null }
  let val = sum / wsum
  if (prefs.calm) val *= Math.min(p.c, 115) / 100
  let step = 0
  for (const t of STEPS) if (val >= t) step++
  return { cls: step ? best + step : 'n', val, kind: step ? best : null }
}
