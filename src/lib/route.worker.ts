/// <reference lib="webworker" />
import { Graph, routeAll, bestOrder, detours } from './route'
import { planCourses } from './course'

let G: Graph | null = null
/** 길 조각(가운데 점)별 값을 가장 가까운 간선에 옮긴다. */
function boostFrom(mids: [number, number][], vals: number[]): Float32Array {
  const g = G!, grid = new Map<number, number[]>()
  const key = (x: number, y: number) => Math.floor(x / 40) * 100003 + Math.floor(y / 40)
  mids.forEach(([lon, lat], i) => { const [x, y] = g.xy(lon, lat), k = key(x, y); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i) })
  const out = new Float32Array(g.E)
  for (let e = 0; e < g.E; e++) {
    const a = g.ea[e], b = g.eb[e], x = (g.nx[a] + g.nx[b]) / 2, y = (g.ny[a] + g.ny[b]) / 2
    let best = -1, bd = 30
    const cx = Math.floor(x / 40), cy = Math.floor(y / 40)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const n of grid.get((cx + i) * 100003 + cy + j) ?? []) {
      const [px, py] = g.xy(mids[n][0], mids[n][1]), d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = n }
    }
    out[e] = best >= 0 ? vals[best] : 0
  }
  return out
}
self.onmessage = async (ev: MessageEvent) => {
  const { id, type, data } = ev.data
  try {
    if (type === 'init') {
      const buf = await (await fetch(data.url)).arrayBuffer()
      G = new Graph(buf)
      self.postMessage({ id, ok: true, data: { nodes: G.N, edges: G.E } })
      return
    }
    if (!G) throw new Error('graph not ready')
    const t0 = performance.now()
    let out: unknown
    if (type === 'route') out = routeAll(G, data.stops, data.prefs, data.view)
    else if (type === 'order') out = bestOrder(G, data.stops, data.fixEnd)
    else if (type === 'detours') out = detours(G, data.stops, data.spots)
    else if (type === 'course') out = planCourses(G, data)
    else if (type === 'boost') { G.boost = data ? boostFrom(data.mids, data.vals) : null; out = true }
    else if (type === 'rain') { G.rain = !!data; out = Array.from(G.flags).filter((f) => f & 3).length }
    self.postMessage({ id, ok: true, data: out, ms: performance.now() - t0 })
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e) })
  }
}
