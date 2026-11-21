/** 동선 엔진. 도보 그래프 위에서 뷰 가중 최단 경로를 찾는다. Web Worker 안에서 돈다.
 *  비용 = 길이 × (1 + λ × (1 − min(1, 뷰 ÷ VIEW_FULL))). 뷰는 화면 칩 설정과 같은 rate()로 계산한다.
 *  길 대부분의 뷰가 낮아서(평균 0.11) 뷰를 그대로 쓰면 λ를 키워도 경로가 거의 안 바뀐다. 그래서 뷰 0.45를 만점으로 본다.
 *  파일럿 무작위 60쌍(600~2000m) 시험: 균형은 평균 3% 더 걷고 뷰 +28%, 뷰 좋은 길은 평균 8% 더 걷고 뷰 +43% 정도. */
import { rate, type Prefs } from './score'

export type ModeId = 'fast' | 'balance' | 'view'
export const MODES: { id: ModeId; label: string; lambda: number; cap: number }[] = [
  { id: 'fast', label: '빠른 길', lambda: 0, cap: 1 },
  { id: 'balance', label: '균형', lambda: 2.5, cap: 1.25 },
  { id: 'view', label: '트인 길', lambda: 8, cap: 1.6 },
]
/** 트인 정도(0~100) -> 트인 길의 λ와 한도. 30이 예전 트인 길(λ8, 1.6배)과 같다. 100이면 2.5배까지 돌아가는 산책 길. */
export function openness(t: number): { lambda: number; cap: number } {
  const x = Math.max(0, Math.min(100, t)) / 100
  if (x <= 0.3) { const k = x / 0.3; return { lambda: 2 + 6 * k, cap: 1.2 + 0.4 * k } }
  const k = (x - 0.3) / 0.7; return { lambda: 8 + 22 * k, cap: 1.6 + 0.9 * k }
}
export const VIEW_FULL = 0.45
export const WALK = 67                                   // 걷는 속도 m/분 (시속 4km)
export interface Seg { coords: [number, number][]; kind: 'k' | 'w' | 'g' | 'n'; v: number; walk?: boolean }
export interface Leg { len: number; segs: Seg[] }
export interface RouteResult { mode: ModeId; len: number; legs: Leg[]; share: { k: number; w: number; g: number }; lambda: number; boost: number }

export class Graph {
  N: number; E: number
  nx: Float64Array; ny: Float64Array            // 노드 위치(m, 지역 중심 기준 평면)
  lon: Float64Array; lat: Float64Array
  ea: Uint32Array; eb: Uint32Array; el: Float32Array; ev: Uint8Array; cs: Uint32Array; co: Int32Array
  adjStart: Uint32Array; adjNode: Uint32Array; adjEdge: Uint32Array
  cost = new Float64Array(0)
  lon0: number; lat0: number; kx: number
  grid = new Map<number, number[]>()
  constructor(buf: ArrayBuffer) {
    const h = new Uint32Array(buf, 0, 4)
    if (h[0] !== 0x4c475447) throw new Error('graph.bin 형식이 아니에요')
    const N = (this.N = h[1]), E = (this.E = h[2]), C = h[3]
    let o = 16
    const nodes = new Int32Array(buf, o, 2 * N); o += 8 * N
    const ends = new Uint32Array(buf, o, 2 * E); o += 8 * E
    this.el = new Float32Array(buf, o, E); o += 4 * E
    this.ev = new Uint8Array(buf, o, 4 * E); o += 4 * E
    this.cs = new Uint32Array(buf, o, E + 1); o += 4 * (E + 1)
    this.co = new Int32Array(buf, o, 2 * C); o += 8 * C
    // 간선 표시(1 건물내, 2 지하). 예전 graph.bin에는 없다.
    this.flags = buf.byteLength >= o + E ? new Uint8Array(buf, o, E) : new Uint8Array(E)
    this.lon = new Float64Array(N); this.lat = new Float64Array(N)
    for (let i = 0; i < N; i++) { this.lon[i] = nodes[2 * i] / 1e6; this.lat[i] = nodes[2 * i + 1] / 1e6 }
    this.lon0 = this.lon.reduce((a, b) => a + b, 0) / N; this.lat0 = this.lat.reduce((a, b) => a + b, 0) / N
    this.kx = 111320 * Math.cos((this.lat0 * Math.PI) / 180)
    this.nx = new Float64Array(N); this.ny = new Float64Array(N)
    for (let i = 0; i < N; i++) { this.nx[i] = (this.lon[i] - this.lon0) * this.kx; this.ny[i] = (this.lat[i] - this.lat0) * 110540 }
    this.ea = new Uint32Array(E); this.eb = new Uint32Array(E)
    const deg = new Uint32Array(N + 1)
    for (let e = 0; e < E; e++) { this.ea[e] = ends[2 * e]; this.eb[e] = ends[2 * e + 1]; deg[this.ea[e] + 1]++; deg[this.eb[e] + 1]++ }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i]
    this.adjStart = deg.slice(); this.adjNode = new Uint32Array(2 * E); this.adjEdge = new Uint32Array(2 * E)
    const fill = deg.slice(0, N)
    for (let e = 0; e < E; e++) {
      const a = this.ea[e], b = this.eb[e]
      this.adjNode[fill[a]] = b; this.adjEdge[fill[a]++] = e
      this.adjNode[fill[b]] = a; this.adjEdge[fill[b]++] = e
    }
    for (let i = 0; i < N; i++) { const k = this.cell(this.nx[i], this.ny[i]); (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i) }
  }
  private cell(x: number, y: number) { return Math.floor(x / 100) * 100003 + Math.floor(y / 100) }
  xy(lon: number, lat: number): [number, number] { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * 110540] }
  /** 가장 가까운 노드와 거리(m) */
  snap(lon: number, lat: number): [number, number] {
    const [x, y] = this.xy(lon, lat)
    let best = -1, bd = Infinity
    for (let r = 0; r <= 12 && (best < 0 || r <= 1 + bd / 100); r++) {
      const cx = Math.floor(x / 100), cy = Math.floor(y / 100)
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue
        for (const n of this.grid.get((cx + i) * 100003 + cy + j) ?? []) { const d = Math.hypot(this.nx[n] - x, this.ny[n] - y); if (d < bd) { bd = d; best = n } }
      }
    }
    return [best, bd]
  }
  /** 간선 비용을 칩 설정과 λ로 다시 계산한다. viewOf[e]는 0~1. */
  viewOf = new Float32Array(0); kindOf = new Uint8Array(0)
  /** 지금 상황(노을 등)에 따라 더해 주는 간선별 값(0~1). 없으면 null. */
  boost: Float32Array | null = null
  boosted = new Uint8Array(0)
  flags = new Uint8Array(0)
  baseView = new Float32Array(0); baseKind = new Uint8Array(0)
  /** 비 오는 날: 건물 안과 지하 구간을 트인 길처럼 우대한다 */
  rain = false
  setPrefs(prefs: Prefs) {
    this.viewOf = new Float32Array(this.E); this.kindOf = new Uint8Array(this.E)
    for (let e = 0; e < this.E; e++) {
      const r = rate({ k: this.ev[4 * e], w: this.ev[4 * e + 1], g: this.ev[4 * e + 2], c: this.ev[4 * e + 3], ps: 0, pw: 0, pg: 0, pa: 0, z: 0, r: 0 }, prefs)
      this.viewOf[e] = r.v / 100; this.kindOf[e] = r.kind === 'k' ? 1 : r.kind === 'w' ? 2 : r.kind === 'g' ? 3 : 0
    }
    this.baseView = this.viewOf.slice(); this.baseKind = this.kindOf.slice()   // 트인 구간 비율은 상황 가산 없이 센다
    this.boosted = new Uint8Array(this.E)
    if (this.boost && prefs.k) for (let e = 0; e < this.E; e++) {
      const b = this.boost[e] * 0.6
      if (b > this.viewOf[e]) { this.viewOf[e] = b; this.boosted[e] = 1 }
    }
    if (this.rain) for (let e = 0; e < this.E; e++) if (this.flags[e] & 3) { this.viewOf[e] = Math.max(this.viewOf[e], 0.75); this.boosted[e] = 1 }
  }
  setLambda(l: number) {
    if (this.cost.length !== this.E) this.cost = new Float64Array(this.E)
    for (let e = 0; e < this.E; e++) this.cost[e] = this.el[e] * (1 + l * (1 - Math.min(1, this.viewOf[e] / VIEW_FULL)))
  }
  /** A* (휴리스틱은 직선거리, 비용 ≥ 길이라 항상 허용 가능). 경로의 간선 번호 목록을 돌려준다. */
  astar(s: number, t: number): number[] | null {
    if (s === t) return []
    const N = this.N, g = new Float64Array(N).fill(Infinity), via = new Int32Array(N).fill(-1), done = new Uint8Array(N)
    const heap = new Heap(); g[s] = 0; heap.push(s, this.h(s, t))
    while (heap.size) {
      const u = heap.pop()
      if (done[u]) continue
      if (u === t) break
      done[u] = 1
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const v = this.adjNode[k], e = this.adjEdge[k], nd = g[u] + this.cost[e]
        if (nd < g[v]) { g[v] = nd; via[v] = e; heap.push(v, nd + this.h(v, t)) }
      }
    }
    if (g[t] === Infinity) return null
    const path: number[] = []
    for (let v = t; v !== s;) { const e = via[v]; path.push(e); v = this.ea[e] === v ? this.eb[e] : this.ea[e] }
    return path.reverse()
  }
  private h(a: number, b: number) { return Math.hypot(this.nx[a] - this.nx[b], this.ny[a] - this.ny[b]) }
  /** 한 점에서 모든 노드까지 거리(길이 기준 다익스트라) */
  dijkstra(s: number): Float64Array {
    const d = new Float64Array(this.N).fill(Infinity), heap = new Heap(); d[s] = 0; heap.push(s, 0)
    const done = new Uint8Array(this.N)
    while (heap.size) {
      const u = heap.pop(); if (done[u]) continue; done[u] = 1
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) { const v = this.adjNode[k], nd = d[u] + this.el[this.adjEdge[k]]; if (nd < d[v]) { d[v] = nd; heap.push(v, nd) } }
    }
    return d
  }
  /** 비용 기준 다익스트라. 비용과 실제 길이를 함께 돌려준다. maxLen(m)을 넘는 곳은 더 보지 않는다. */
  dijkstraCost(s: number, maxLen = 4000): { cost: Float64Array; len: Float64Array } {
    const d = new Float64Array(this.N).fill(Infinity), len = new Float64Array(this.N).fill(Infinity), heap = new Heap(); d[s] = 0; len[s] = 0; heap.push(s, 0)
    const done = new Uint8Array(this.N)
    while (heap.size) {
      const u = heap.pop(); if (done[u]) continue; done[u] = 1
      if (len[u] > maxLen) continue
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const v = this.adjNode[k], e = this.adjEdge[k], nd = d[u] + this.cost[e]
        if (nd < d[v]) { d[v] = nd; len[v] = len[u] + this.el[e]; heap.push(v, nd) }
      }
    }
    return { cost: d, len }
  }
  pathLen(p: number[]) { let s = 0; for (const e of p) s += this.el[e]; return s }
  /** 경로를 색칠용 조각으로. 같은 종류와 비슷한 값이 이어지면 합친다. */
  segs(p: number[], from: number): Seg[] {
    const out: Seg[] = []; let at = from
    for (const e of p) {
      const fwd = this.ea[e] === at, pts: [number, number][] = []
      for (let i = this.cs[e]; i < this.cs[e + 1]; i++) pts.push([this.co[2 * i] / 1e6, this.co[2 * i + 1] / 1e6])
      if (!fwd) pts.reverse()
      const kind = (['n', 'k', 'w', 'g'] as const)[this.kindOf[e]], v = Math.round(this.baseView[e] * 100)
      const last = out[out.length - 1]
      if (last && last.kind === kind && Math.abs(last.v - v) < 6) last.coords.push(...pts.slice(1))
      else out.push({ coords: pts, kind, v })
      at = fwd ? this.eb[e] : this.ea[e]
    }
    return out
  }
}

class Heap {
  k: number[] = []; p: number[] = []
  get size() { return this.k.length }
  push(key: number, pri: number) {
    const k = this.k, p = this.p; let i = k.length; k.push(key); p.push(pri)
    while (i > 0) { const j = (i - 1) >> 1; if (p[j] <= pri) break; k[i] = k[j]; p[i] = p[j]; i = j }
    k[i] = key; p[i] = pri
  }
  pop(): number {
    const k = this.k, p = this.p, top = k[0], lk = k.pop()!, lp = p.pop()!
    if (k.length) {
      let i = 0; const n = k.length
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && p[c + 1] < p[c]) c++; if (p[c] >= lp) break; k[i] = k[c]; p[i] = p[c]; i = c }
      k[i] = lk; p[i] = lp
    }
    return top
  }
}

/** 여러 곳을 순서대로 잇는다. 모드마다 λ를 두고, 최단 길이의 cap배를 넘으면 λ를 줄여 다시 찾는다. */
export function routeAll(G: Graph, stops: [number, number][], prefs: Prefs, view?: { lambda: number; cap: number }): RouteResult[] | { error: string } {
  G.setPrefs(prefs)
  const snapped = stops.map(([x, y]) => G.snap(x, y))
  if (snapped.some(([n, d]) => n < 0 || d > 300)) return { error: 'far' }
  const legsFor = (lambda: number) => {
    G.setLambda(lambda)
    const legs: { path: number[]; len: number }[] = []
    for (let i = 0; i + 1 < snapped.length; i++) {
      const p = G.astar(snapped[i][0], snapped[i + 1][0]); if (!p) return null
      legs.push({ path: p, len: G.pathLen(p) })
    }
    return legs
  }
  const fast = legsFor(0); if (!fast) return { error: 'nopath' }
  const out: RouteResult[] = []
  for (const m0 of MODES) {
    const m = m0.id === 'view' && view ? { ...m0, ...view } : m0
    let lambda = m.lambda, legs = fast
    if (lambda > 0) {
      for (let tries = 0; tries < 6; tries++) {
        const l = legsFor(lambda)
        if (l && l.every((x, i) => x.len <= fast[i].len * m.cap + 30)) { legs = l; break }
        lambda *= 0.55
      }
    }
    const share = { k: 0, w: 0, g: 0 }; let total = 0
    const L: Leg[] = legs.map((x, i) => {
      const segs = G.segs(x.path, snapped[i][0])
      const walkIn: Seg = { coords: [stops[i], [G.lon[snapped[i][0]], G.lat[snapped[i][0]]]], kind: 'n', v: 0, walk: true }
      const walkOut: Seg = { coords: [[G.lon[snapped[i + 1][0]], G.lat[snapped[i + 1][0]]], stops[i + 1]], kind: 'n', v: 0, walk: true }
      for (const e of x.path) { const k = G.baseKind[e]; if (G.baseView[e] >= 0.35) { if (k === 1) share.k += G.el[e]; else if (k === 2) share.w += G.el[e]; else if (k === 3) share.g += G.el[e] } }
      const len = x.len + snapped[i][1] + snapped[i + 1][1]; total += len
      return { len, segs: [walkIn, ...segs, walkOut] }
    })
    const all = legs.reduce((a, x) => a + x.len, 0) || 1
    let bo = 0; for (const x of legs) for (const e of x.path) if (G.boosted[e]) bo += G.el[e]
    out.push({ mode: m.id, len: total, legs: L, lambda, share: { k: share.k / all, w: share.w / all, g: share.g / all }, boost: bo / all })
  }
  return out
}

/** 첫 곳은 그대로 두고 나머지 순서를 가장 짧게 (Held-Karp, 8곳 이하 정확). fixEnd면 마지막 곳도 그대로 둔다. */
export function bestOrder(G: Graph, stops: [number, number][], fixEnd = false): number[] {
  const n = stops.length
  if (n <= 2 || (fixEnd && n <= 3)) return stops.map((_, i) => i)
  if (fixEnd) {
    const inner = bestOrderEnd(G, stops)
    return inner
  }
  const sn = stops.map(([x, y]) => G.snap(x, y)[0])
  const D = sn.map((s) => { const d = G.dijkstra(s); return sn.map((t) => d[t]) })
  const m = n - 1, FULL = 1 << m
  const dp = new Float64Array(FULL * m).fill(Infinity), par = new Int8Array(FULL * m).fill(-1)
  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = D[0][j + 1]
  for (let S = 1; S < FULL; S++) for (let j = 0; j < m; j++) {
    if (!(S & (1 << j))) continue
    const cur = dp[S * m + j]; if (cur === Infinity) continue
    for (let k = 0; k < m; k++) {
      if (S & (1 << k)) continue
      const T = S | (1 << k), nd = cur + D[j + 1][k + 1]
      if (nd < dp[T * m + k]) { dp[T * m + k] = nd; par[T * m + k] = j }
    }
  }
  let best = 0, bd = Infinity
  for (let j = 0; j < m; j++) if (dp[(FULL - 1) * m + j] < bd) { bd = dp[(FULL - 1) * m + j]; best = j }
  const seq: number[] = []; let S = FULL - 1, j = best
  while (j >= 0) { seq.push(j + 1); const pj = par[S * m + j]; S &= ~(1 << j); j = pj }
  return [0, ...seq.reverse()]
}

/** 구간마다 조금만 돌아가면 들를 수 있는 스팟 하나 (가장 짧게 돌아가는 곳) */
export function detours(G: Graph, stops: [number, number][], spots: { id: string; lon: number; lat: number }[], maxExtra = 250): ({ id: string; extra: number } | null)[] {
  const sn = stops.map(([x, y]) => G.snap(x, y)[0])
  const sp = spots.map((s) => ({ id: s.id, n: G.snap(s.lon, s.lat) }))
  const dist = sn.map((s) => G.dijkstra(s))
  return sn.slice(0, -1).map((_, i) => {
    const a = dist[i], b = dist[i + 1], base = a[sn[i + 1]]
    let best: { id: string; extra: number } | null = null
    for (const s of sp) {
      if (s.n[1] > 60) continue
      const extra = a[s.n[0]] + b[s.n[0]] - base
      if (extra > 20 && extra <= maxExtra && (!best || extra < best.extra)) best = { id: s.id, extra }
    }
    return best
  })
}

/** 처음과 끝을 고정하고 가운데 순서를 가장 짧게 */
function bestOrderEnd(G: Graph, stops: [number, number][]): number[] {
  const n = stops.length, sn = stops.map(([x, y]) => G.snap(x, y)[0])
  const D = sn.map((s) => { const d = G.dijkstra(s); return sn.map((t) => d[t]) })
  const mid = Array.from({ length: n - 2 }, (_, i) => i + 1), m = mid.length, FULL = 1 << m
  const dp = new Float64Array(FULL * m).fill(Infinity), par = new Int8Array(FULL * m).fill(-1)
  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = D[0][mid[j]]
  for (let S = 1; S < FULL; S++) for (let j = 0; j < m; j++) {
    if (!(S & (1 << j))) continue
    const cur = dp[S * m + j]; if (cur === Infinity) continue
    for (let k = 0; k < m; k++) {
      if (S & (1 << k)) continue
      const T = S | (1 << k), nd = cur + D[mid[j]][mid[k]]
      if (nd < dp[T * m + k]) { dp[T * m + k] = nd; par[T * m + k] = j }
    }
  }
  let best = 0, bd = Infinity
  for (let j = 0; j < m; j++) { const v = dp[(FULL - 1) * m + j] + D[mid[j]][n - 1]; if (v < bd) { bd = v; best = j } }
  const seq: number[] = []; let S = FULL - 1, j = best
  while (j >= 0) { seq.push(mid[j]); const pj = par[S * m + j]; S &= ~(1 << j); j = pj }
  return [0, ...seq.reverse(), n - 1]
}
