/// <reference lib="webworker" />
import { Graph, routeAll, bestOrder, detours } from './route'

let G: Graph | null = null
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
    if (type === 'route') out = routeAll(G, data.stops, data.prefs)
    else if (type === 'order') out = bestOrder(G, data.stops)
    else if (type === 'detours') out = detours(G, data.stops, data.spots)
    self.postMessage({ id, ok: true, data: out, ms: performance.now() - t0 })
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e) })
  }
}
