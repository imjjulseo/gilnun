/** 코스 짜기. 칸마다 후보가 있고, 칸 순서대로 하나씩 골라 걷는 비용이 가장 작은 조합을 여러 개 찾는다.
 *  후보 사이 비용은 다익스트라로 한 번에 구하고, 칸 순서를 따라 동적 계획법(칸마다 상위 M개 유지)으로 고른다.
 *  효율은 길이만, 적절은 균형 길 비용, 트인 코스는 트인 길 비용에 트인 자리와 가게 앞 뷰를 더 쳐 준다. */
import { Graph, routeAll, openness, type ModeId } from './route'
import type { Prefs } from './score'

export type CourseStyle = 'fast' | 'fit' | 'view'
export interface CCand { key: string; lon: number; lat: number; bonus: number }
export interface CSlot { cands: CCand[]; pin: number }
export interface CourseReq { slots: CSlot[]; start: [number, number] | null; prefs: Prefs; open: number; styles: CourseStyle[]; want: number; jitter?: number; seed?: number; exclude?: string[] }
export interface CourseOut { style: CourseStyle; pick: number[]; len: number; legs: number[]; view: number; key: string }

const STYLE_MODE: Record<CourseStyle, ModeId> = { fast: 'fast', fit: 'balance', view: 'view' }
const BONUS_M: Record<CourseStyle, number> = { fast: 0, fit: 120, view: 380 }
const M = 12

function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }

export function planCourses(G: Graph, q: CourseReq): CourseOut[] | { error: string } {
  G.setPrefs(q.prefs)
  const slots = q.slots.map((s) => ({ ...s, cands: s.pin >= 0 ? [s.cands[s.pin]] : s.cands, map: s.pin >= 0 ? [s.pin] : s.cands.map((_, i) => i) }))
  if (!slots.length || slots.some((s) => !s.cands.length)) return { error: 'empty' }
  const snap = slots.map((s) => s.cands.map((c) => G.snap(c.lon, c.lat)))
  const st = q.start ? G.snap(q.start[0], q.start[1]) : null
  const rand = rng(q.seed ?? 7), jit = q.jitter ?? 0
  const out: CourseOut[] = []
  const exclude = new Set(q.exclude ?? [])
  for (const style of q.styles) {
    const lam = style === 'fast' ? 0 : style === 'fit' ? 2.5 : openness(q.open).lambda
    G.setLambda(lam)
    const cache = new Map<number, Float64Array>()
    const from = (n: number) => { let d = cache.get(n); if (!d) { d = G.dijkstraCost(n, 3500).cost; cache.set(n, d) }; return d }
    const noise = slots.map((s) => s.cands.map(() => 1 + (rand() * 2 - 1) * jit))
    const bon = (i: number, j: number) => BONUS_M[style] * slots[i].cands[j].bonus * noise[i][j]
    // 각 칸의 후보마다 상위 M개 경로: [비용, 이전 후보, 이전 순위]
    type E = [number, number, number]
    let prev: E[][] = slots[0].cands.map((_, j) => {
      const [n, d] = snap[0][j]
      const c0 = d > 300 ? Infinity : st ? (from(st[0])[n] + st[1] + d) : 0
      return isFinite(c0) ? [[c0 - bon(0, j), -1, -1]] : []
    })
    const table: E[][][] = [prev]
    for (let i = 1; i < slots.length; i++) {
      const cur: E[][] = slots[i].cands.map(() => [])
      prev.forEach((list, a) => {
        if (!list.length) return
        const [na, da] = snap[i - 1][a], d = from(na)
        slots[i].cands.forEach((_, b) => {
          const [nb, db] = snap[i][b], w = d[nb]
          if (!isFinite(w) || db > 300) return
          const step = (w + da + db) * (1 + (rand() * 2 - 1) * jit) - bon(i, b)
          list.forEach((e, r) => cur[b].push([e[0] + step, a, r]))
        })
      })
      for (const l of cur) { l.sort((x, y) => x[0] - y[0]); l.length = Math.min(l.length, M) }
      table.push(cur); prev = cur
    }
    // 끝에서 거꾸로 따라가며 조합을 만든다
    const last = table[table.length - 1], all: { cost: number; pick: number[] }[] = []
    last.forEach((l, j) => l.forEach((e, r) => {
      const pick = new Array(slots.length); let jj = j, rr = r
      for (let i = slots.length - 1; i >= 0; i--) { pick[i] = jj; const en = table[i][jj][rr]; jj = en[1]; rr = en[2] }
      all.push({ cost: e[0], pick })
    }))
    all.sort((a, b) => a.cost - b.cost)
    const free = slots.filter((s) => s.cands.length > 1).length
    const chosen: number[][] = []
    for (const need of [free >= 3 ? 2 : 1, 1]) {
      for (const c of all) {
        if (chosen.length >= q.want) break
        const keys = c.pick.map((j, i) => slots[i].cands[j].key)
        if (new Set(keys).size < keys.length) continue
        if (exclude.has(keys.join('|'))) continue
        if (chosen.some((p) => p.join() === c.pick.join() || p.filter((j, i) => j !== c.pick[i]).length < need)) continue
        chosen.push(c.pick)
      }
      if (chosen.length >= q.want || free === 0) break
    }
    for (const pick of chosen) {
      const cands = pick.map((j, i) => slots[i].cands[j])
      const stops: [number, number][] = [...(q.start ? [q.start] : []), ...cands.map((c) => [c.lon, c.lat] as [number, number])]
      if (stops.length < 2) { out.push({ style, pick: pick.map((j, i) => slots[i].map[j]), len: 0, legs: [], view: 0, key: cands.map((c) => c.key).join('|') }); continue }
      const r = routeAll(G, stops, q.prefs, openness(q.open))
      if ('error' in r) continue
      const m = r.find((x) => x.mode === STYLE_MODE[style])!
      out.push({ style, pick: pick.map((j, i) => slots[i].map[j]), len: m.len, legs: m.legs.map((l) => l.len), view: m.share.k + m.share.w + m.share.g, key: cands.map((c) => c.key).join('|') })
    }
  }
  return out
}
