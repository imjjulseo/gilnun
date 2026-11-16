<script lang="ts">
  import { onMount, untrack, tick } from 'svelte'
  import maplibregl from 'maplibre-gl'
  import type { GeoJSONSource, Map as MlMap, ExpressionSpecification } from 'maplibre-gl'
  import { basemap, withDusk, type ThemeName, type Kind } from './lib/theme'
  import { DEFAULT_PREFS, FLOOR, rate, type LinkProps, type Prefs } from './lib/score'
  import { duskMix, sunTimes, hhmm } from './lib/sun'
  import { Places, CAT_LABEL, looksShared, meters, floorText, type Place, type PoiData, type AddrData } from './lib/places'
  import { MODES, WALK, type ModeId, type RouteResult } from './lib/route'
  import RouteWorker from './lib/route.worker.ts?worker'

  interface Region { id: string; name: string; bbox: [number, number, number, number]; center: [number, number]; zoom: number; links: string; spots: string; poi?: string; addr?: string; graph?: string }
  interface Spot { id: string; rank: number; lat: number; lon: number; dong: string; title: string; kind: Kind; sky: number; water: number; nat: number; pano: number; dir: string | null; west: number; elev: number; top: number; prom: number; calm: boolean }
  type Shown = LinkProps & { kind: Kind | 'n'; v: number }
  type Fc = GeoJSON.FeatureCollection<GeoJSON.LineString, LinkProps>
  type Near = { type: 'spot'; spot: Spot; d: number } | { type: 'link'; f: GeoJSON.Feature<GeoJSON.LineString, Shown>; d: number }
  type Mode = 'idle' | 'link' | 'spot' | 'near' | 'place' | 'go' | 'route'

  const store = {
    get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
    set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 저장 못 해도 동작 */ } },
  }
  const systemNight = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  const MAX_GO = 8

  let themeName = $state<ThemeName>(store.get<ThemeName | null>('gn.theme', null) ?? (systemNight() ? 'night' : 'light'))
  let prefs = $state<Prefs>({ ...DEFAULT_PREFS, ...store.get<Partial<Prefs>>('gn.prefs', {}) })
  let dusk = $state(duskMix())
  let region = $state<Region | null>(null)
  let spots = $state<Spot[]>([])
  let mode = $state<Mode>('idle')
  let picked = $state<Shown | null>(null)
  let spot = $state<Spot | null>(null)
  let near = $state<Near[]>([])
  let nearFrom = $state<'me' | 'center'>('center')
  let nearOn = $state(false)
  let ready = $state(false)
  let toast = $state('')
  let locating = $state(false)
  let failed = $state<'' | 'load' | 'gl'>('')
  let sheetEl = $state<HTMLElement | null>(null)
  // 3단계: 장소
  let db = $state<Places | null>(null)
  let dbLoading = false
  let go = $state<Place[]>(store.get<Place[]>('gn.go', []))
  let place = $state<Place | null>(null)
  let placeFrom = $state<'search' | 'press' | 'share' | 'go'>('search')
  let searchOpen = $state(false)
  let query = $state('')
  let cat = $state<number | null>(null)
  let searchEl = $state<HTMLTextAreaElement | null>(null)
  let viewTick = $state(0)
  // 4단계: 동선
  let routes = $state<RouteResult[] | null>(null)
  let routeMode = $state<ModeId>(store.get<ModeId>('gn.mode', 'balance'))
  let routeBusy = $state(false)
  let routeErr = $state('')
  let sugs = $state<({ id: string; extra: number } | null)[]>([])
  let dragFrom = $state(-1)
  let dragTo = $state(-1)
  // 5단계: 공유
  let incoming = $state<Place[] | null>(null)
  const theme = $derived(withDusk(themeName, dusk))

  let mapEl: HTMLDivElement
  let map: MlMap | null = null
  let raw: Fc | null = null
  let mids: [number, number][] = []
  let me: maplibregl.Marker | null = null
  let meAt = $state<[number, number] | null>(null)
  let tmp: maplibregl.Marker | null = null
  const pins = new Map<string, HTMLElement>()
  const goPins: maplibregl.Marker[] = []
  let toastTimer = 0, nearTimer = 0, quietClick = 0

  const CHIPS: { key: keyof Prefs; label: string; kind?: Kind }[] = [
    { key: 'k', label: '하늘', kind: 'k' }, { key: 'w', label: '물', kind: 'w' }, { key: 'g', label: '녹지', kind: 'g' }, { key: 'calm', label: '조용한 길' },
  ]
  const KIND_W: Record<Kind | 'n', number> = { k: 1, w: 0.95, g: 0.85, n: 0 }     // 추천 순서는 하늘을 먼저
  const KIND_LINE: Record<Kind | 'n', string> = { k: '하늘이 넓게 보이는 길', w: '물이 보이는 길', g: '녹지가 보이는 길', n: '뷰가 약한 길' }

  function say(msg: string) { toast = msg; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (toast = ''), 3200) }
  const distText = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)
  const walkText = (m: number) => `걸어서 ${Math.max(1, Math.round(m / 67))}분`
  const origin = (): [number, number] => { const c = map?.getCenter(); return meAt ?? (c ? [c.lng, c.lat] : region?.center ?? [0, 0]) }
  const samePlace = (a: Place, b: Place) => a.id === b.id || (Math.abs(a.lon - b.lon) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6)

  function rated(): GeoJSON.FeatureCollection<GeoJSON.LineString, Shown> {
    return { type: 'FeatureCollection', features: raw!.features.map((f) => ({ ...f, properties: { ...f.properties, ...rate(f.properties, prefs) } })) }
  }
  /** 종류별로 값(0~100)에 따라 색이 이어서 변한다. */
  function colorExpr(): ExpressionSpecification {
    const ramp = (k: Kind) => ['interpolate', ['linear'], ['get', 'v'], FLOOR, theme.none, 30, theme.ramp[k][0], 50, theme.ramp[k][1], 72, theme.ramp[k][2], 95, theme.ramp[k][3]]
    return ['match', ['get', 'kind'], 'k', ramp('k'), 'w', ramp('w'), 'g', ramp('g'), theme.none] as unknown as ExpressionSpecification
  }
  function addOverlay() {
    if (!map || !raw) return
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
    if (!map.getSource('links')) map.addSource('links', { type: 'geojson', data: rated() })
    if (!map.getSource('pick')) map.addSource('pick', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    const grow = ['+', 0.55, ['*', 0.011, ['get', 'v']]]                       // 값이 클수록 굵게
    const width = (a: number, b: number, scaled = true) => ['interpolate', ['linear'], ['zoom'], 12, ['*', a * 0.5, scaled ? grow : 1], 15, ['*', a, scaled ? grow : 1], 18, ['*', b, scaled ? grow : 1]] as unknown as ExpressionSpecification
    const add = (layer: maplibregl.LayerSpecification) => { if (!map!.getLayer(layer.id)) map!.addLayer(layer, before) }
    add({ id: 'links', type: 'line', source: 'links', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'v'] }, paint: { 'line-color': colorExpr(), 'line-width': width(3, 7.5) } })
    add({ id: 'pick-halo', type: 'line', source: 'pick', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': theme.ink, 'line-width': width(8, 15, false), 'line-opacity': 0.9 } })
    add({ id: 'pick-line', type: 'line', source: 'pick', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colorExpr(), 'line-width': width(4.5, 10, false) } })
    add({ id: 'links-hit', type: 'line', source: 'links', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 } })
    ready = true
  }
  function recolor() {
    if (!map || !map.getLayer('links')) return
    map.setPaintProperty('links', 'line-color', colorExpr()); map.setPaintProperty('pick-line', 'line-color', colorExpr())
    map.setPaintProperty('pick-halo', 'line-color', theme.ink)
    if (map.getLayer('route-line')) { map.setPaintProperty('route-line', 'line-color', routeColor()); map.setPaintProperty('route-case', 'line-color', theme.ink); map.setPaintProperty('route-walk', 'line-color', theme.ink) }
  }
  function clearPick() { picked = null; (map?.getSource('pick') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] }) }
  function selectPin(id: string | null) { for (const [k, el] of pins) el.classList.toggle('sel', k === id) }
  function clearSel() { clearPick(); spot = null; selectPin(null); place = null; tmp?.remove() }
  function repaint() {
    if (!map || !map.getSource('links')) return
    ;(map.getSource('links') as GeoJSONSource).setData(rated())
    if (mode === 'link') { clearPick(); mode = nearOn ? 'near' : 'idle' }
  }
  function showLink(geometry: GeoJSON.Geometry, props: Shown) {
    clearSel()
    picked = props; mode = 'link'
    ;(map!.getSource('pick') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: props }] })
  }
  function showSpot(s: Spot, fly = true) {
    clearSel(); spot = s; mode = 'spot'; selectPin(s.id)
    if (fly && map) map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16), duration: 500 })
  }
  /** 닫기: 갈 곳에서 열었으면 갈 곳 목록으로, 주변 목록을 켜 둔 상태면 주변 목록으로 돌아간다. */
  function closeSheet() {
    const back: Mode = mode === 'place' && placeFrom === 'go' && go.length ? 'go' : nearOn ? 'near' : 'idle'
    clearSel(); mode = back; if (back === 'near') computeNear()
  }
  function toggleNear() {
    nearOn = !nearOn
    mapEl.classList.toggle('pins-on', nearOn)
    clearSel()
    if (nearOn) { computeNear(); mode = 'near' } else mode = 'idle'
  }
  function nearLater() { if (!nearOn) return; clearTimeout(nearTimer); nearTimer = window.setTimeout(computeNear, 250) }

  function addPins() {
    if (!map) return
    for (const s of spots) {
      const el = document.createElement('button')
      el.type = 'button'; el.className = `pin ${s.kind}`; el.setAttribute('aria-label', `스팟 ${s.title}`)
      el.innerHTML = '<span class="core" aria-hidden="true"></span>'
      el.addEventListener('click', (e) => { e.stopPropagation(); showSpot(s) })
      new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(map)
      pins.set(s.id, el)
    }
  }

  /** 지금 보이는 화면 안에서 뷰 좋은 스팟과 길을 고른다. 지도를 옮기면 다시 고른다. */
  function computeNear() {
    if (!map || !raw) return
    const b = map.getBounds(), c = map.getCenter()
    const inView = (x: number, y: number) => x >= b.getWest() && x <= b.getEast() && y >= b.getSouth() && y <= b.getNorth()
    const from: [number, number] = meAt && inView(...meAt) ? meAt : [c.lng, c.lat]
    nearFrom = meAt && from === meAt ? 'me' : 'center'
    const S: Near[] = spots.filter((s) => inView(s.lon, s.lat)).map((s) => ({ type: 'spot' as const, spot: s, d: meters(from, [s.lon, s.lat]) }))
      .sort((a, b) => a.spot.rank - b.spot.rank).slice(0, 3)
    const cand = rated().features.filter((f) => f.properties.kind !== 'n' && f.properties.v >= 60)
      .map((f) => { const m = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)] as [number, number]; return { f, m } })
      .filter(({ m }) => inView(...m)).sort((a, b) => b.f.properties.v * KIND_W[b.f.properties.kind] - a.f.properties.v * KIND_W[a.f.properties.kind])
    const L: Near[] = [], kinds = new Set<string>()
    const taken = S.map((s) => [s.type === 'spot' ? s.spot.lon : 0, s.type === 'spot' ? s.spot.lat : 0] as [number, number])
    for (const { f, m } of cand) {
      if (kinds.has(f.properties.kind) || taken.some((t) => meters(t, m) < 220)) continue    // 길은 종류마다 하나씩
      L.push({ type: 'link', f, d: meters(from, m) }); taken.push(m); kinds.add(f.properties.kind)
      if (L.length === 2) break
    }
    near = [...S, ...L].sort((a, b) => a.d - b.d)
  }
  function openNear(n: Near) {
    if (n.type === 'spot') { showSpot(n.spot); return }
    const co = n.f.geometry.coordinates, m = co[Math.floor(co.length / 2)] as [number, number]
    showLink(n.f.geometry, n.f.properties)
    map!.easeTo({ center: m, zoom: Math.max(map!.getZoom(), 16.5), duration: 500 })
  }

  // ---- 장소
  let dbWait: Promise<Places | null> | null = null
  function loadPlaces(): Promise<Places | null> {
    if (db) return Promise.resolve(db)
    if (!region?.poi || !region.addr) return Promise.resolve(null)
    if (dbLoading && dbWait) return dbWait
    dbLoading = true
    dbWait = Promise.all([fetch('./data/' + region.poi).then((r) => r.json()), fetch('./data/' + region.addr).then((r) => r.json())])
      .then(([p, a]) => (db = new Places(p as PoiData, a as AddrData)))
      .catch(() => { say('가게 정보를 불러오지 못했어요. 잠시 뒤에 다시 해 주세요.'); return null })
      .finally(() => { dbLoading = false })
    return dbWait
  }
  /** 장소 앞 길(60m 이내 가장 가까운 길 조각)의 뷰 */
  function frontOf(p: { lon: number; lat: number }): Shown | null {
    if (!raw) return null
    let bi = -1, bd = 60
    for (let i = 0; i < mids.length; i++) { const d = meters([p.lon, p.lat], mids[i]); if (d < bd) { bd = d; bi = i } }
    return bi < 0 ? null : { ...raw.features[bi].properties, ...rate(raw.features[bi].properties, prefs) }
  }
  const isGo = (p: Place) => go.some((g) => samePlace(g, p))
  function showPlace(p: Place, from: typeof placeFrom, fly = true) {
    clearSel(); place = p; placeFrom = from; mode = 'place'
    if (!isGo(p)) {
      if (!tmp) { const el = document.createElement('div'); el.className = 'tmp'; tmp = new maplibregl.Marker({ element: el, anchor: 'bottom' }) }
      tmp.setLngLat([p.lon, p.lat]).addTo(map!)
    }
    if (fly && map) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 500 })
  }
  function addGo(p: Place) {
    if (isGo(p)) return
    if (go.length >= MAX_GO) { say(`갈 곳은 ${MAX_GO}곳까지 넣을 수 있어요.`); return }
    go = [...go, { ...p }]; store.set('gn.go', go); tmp?.remove()
    say(`갈 곳에 넣었어요. 지금 ${go.length}곳이에요.`)
  }
  function removeGo(p: Place) {
    go = go.filter((g) => !samePlace(g, p)); store.set('gn.go', go)
    if (mode === 'go' && !go.length) mode = 'idle'
    if (mode === 'place' && place && samePlace(place, p)) tmp?.setLngLat([p.lon, p.lat]).addTo(map!)
  }
  function drawGo() {
    if (!map) return
    goPins.splice(0).forEach((m) => m.remove())
    go.forEach((p, i) => {
      const el = document.createElement('button')
      el.type = 'button'; el.className = 'gopin'; el.textContent = String(i + 1); el.setAttribute('aria-label', `갈 곳 ${i + 1}번 ${p.name}`)
      el.addEventListener('click', (e) => { e.stopPropagation(); showPlace(p, 'go') })
      goPins.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map!))
    })
  }
  async function onLongPress(ll: maplibregl.LngLat) {
    quietClick = Date.now() + 800
    const d = await loadPlaces()
    const shop = d?.nearest(ll.lng, ll.lat, 15)
    if (shop) { showPlace(shop, 'press', false); return }
    const a = d?.nearestAddr(ll.lng, ll.lat, 25)
    showPlace({ id: `m${ll.lng.toFixed(6)},${ll.lat.toFixed(6)}`, name: a ? `${a} 근처` : '고른 위치', sub: '', lon: ll.lng, lat: ll.lat, addr: '', floor: null, cat: -1 }, 'press', false)
  }

  // ---- 동선
  let worker: Worker | null = null, wid = 0, wready: Promise<unknown> | null = null
  const waiting = new Map<number, (v: { ok: boolean; data?: any; error?: string }) => void>()
  function call<T>(type: string, data: unknown): Promise<T> {
    if (!worker) {
      worker = new RouteWorker()
      worker.onmessage = (e) => { const f = waiting.get(e.data.id); waiting.delete(e.data.id); f?.(e.data) }
      const url = new URL('./data/' + region!.graph, location.href).href
      wready = new Promise((res, rej) => { const id = ++wid; waiting.set(id, (r) => (r.ok ? res(r.data) : rej(r.error))); worker!.postMessage({ id, type: 'init', data: { url } }) })
    }
    return wready!.then(() => new Promise<T>((res, rej) => { const id = ++wid; waiting.set(id, (r) => (r.ok ? res(r.data as T) : rej(r.error))); worker!.postMessage({ id, type, data }) }))
  }
  const stopsOf = () => go.map((g) => [g.lon, g.lat] as [number, number])
  async function makeRoute(fit = true) {
    if (go.length < 2 || !region?.graph) return
    mode = 'route'; routeBusy = true; routeErr = ''
    try {
      const r = await call<RouteResult[] | { error: string }>('route', { stops: stopsOf(), prefs: $state.snapshot(prefs) })
      if ('error' in r) { routes = null; routeErr = r.error === 'far' ? '갈 곳 중에 걷는 길에서 300m 넘게 떨어진 곳이 있어요.' : '걸어서 이어지는 길을 찾지 못했어요.'; drawRoute(); return }
      routes = r; await tick(); drawRoute(fit)
      const inGo = new Set(go.map((g) => g.id))
      sugs = await call('detours', { stops: stopsOf(), spots: spots.filter((s) => !inGo.has(s.id)).map((s) => ({ id: s.id, lon: s.lon, lat: s.lat })) })
    } catch { routeErr = '동선을 계산하지 못했어요. 잠시 뒤에 다시 해 주세요.' }
    finally { routeBusy = false }
  }
  const current = $derived(routes?.find((r) => r.mode === routeMode) ?? null)
  const fastest = $derived(routes?.find((r) => r.mode === 'fast') ?? null)
  function drawRoute(fit = false) {
    if (!map) return
    const src = map.getSource('route') as GeoJSONSource | undefined
    const r = mode === 'route' ? routes?.find((x) => x.mode === routeMode) : null
    const feats = r ? r.legs.flatMap((l) => l.segs.map((sg) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: sg.coords }, properties: { kind: sg.kind, v: sg.v, walk: sg.walk ? 1 : 0 } }))) : []
    const data = { type: 'FeatureCollection' as const, features: feats }
    if (src) src.setData(data)
    else {
      map.addSource('route', { type: 'geojson', data })
      const W = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 12, a * 0.6, 15, a, 18, b] as unknown as ExpressionSpecification
      map.addLayer({ id: 'route-case', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': theme.ink, 'line-width': W(9, 16) } })
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': routeColor(), 'line-width': W(5.5, 11) } })
      map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 1], layout: { 'line-cap': 'round' }, paint: { 'line-color': theme.ink, 'line-width': 2.5, 'line-dasharray': [1, 2] } })
    }
    map.setPaintProperty('links', 'line-opacity', r ? 0.3 : 1)          // 동선을 볼 때는 바탕 길을 흐리게
    map.triggerRepaint()
    if (r && fit) {
      const b = new maplibregl.LngLatBounds()
      for (const f of feats) for (const c of f.geometry.coordinates) b.extend(c as [number, number])
      const sh = sheetEl?.offsetHeight ?? 300
      map.fitBounds(b, { padding: { top: 150, bottom: sh + 30, left: 40, right: 40 }, duration: 600, maxZoom: 17 })
    }
  }
  /** 동선 선은 뷰가 약한 구간도 보이게 회색 대신 보조 글자색을 쓴다. */
  function routeColor(): ExpressionSpecification {
    const ramp = (k: Kind) => ['interpolate', ['linear'], ['get', 'v'], FLOOR, theme.sub, 30, theme.ramp[k][1], 60, theme.ramp[k][2], 90, theme.ramp[k][3]]
    return ['match', ['get', 'kind'], 'k', ramp('k'), 'w', ramp('w'), 'g', ramp('g'), theme.sub] as unknown as ExpressionSpecification
  }
  function leaveRoute() { mode = 'go'; drawRoute() }
  function pickMode(m: ModeId) { routeMode = m; store.set('gn.mode', m); drawRoute() }
  async function tidyOrder() {
    if (go.length < 3) return
    const ord = await call<number[]>('order', { stops: stopsOf() })
    if (ord.every((v, i) => v === i)) { say('지금 순서가 가장 짧아요.'); return }
    go = ord.map((i) => go[i]); store.set('gn.go', go); say('가장 짧은 순서로 바꿨어요.')
    makeRoute(false)
  }
  function addDetour(i: number, id: string) {
    const s = spots.find((x) => x.id === id); if (!s) return
    if (go.length >= MAX_GO) { say(`갈 곳은 ${MAX_GO}곳까지 넣을 수 있어요.`); return }
    go = [...go.slice(0, i + 1), { id: s.id, name: s.title, sub: '스팟', lon: s.lon, lat: s.lat, addr: '', floor: null, cat: -1 }, ...go.slice(i + 1)]; store.set('gn.go', go)
    say(`${s.title}에 들르도록 넣었어요.`); makeRoute(false)
  }
  /** 갈 곳 순서 바꾸기: 손잡이를 끌거나 키보드 위아래 화살표 */
  function moveGo(from: number, to: number) {
    if (from === to || to < 0 || to >= go.length) return
    const a = [...go]; const [x] = a.splice(from, 1); a.splice(to, 0, x); go = a; store.set('gn.go', go)
  }
  function dragStart(e: PointerEvent, i: number) {
    const row = (e.currentTarget as HTMLElement).closest('li')!, list = row.parentElement!
    const rows = [...list.children] as HTMLElement[], tops = rows.map((r) => r.getBoundingClientRect())
    dragFrom = i; dragTo = i
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      let t = rows.length - 1
      for (let k = 0; k < tops.length; k++) if (ev.clientY < tops[k].top + tops[k].height / 2) { t = k; break }
      dragTo = t
    }
    const up = () => { (e.target as HTMLElement).removeEventListener('pointermove', move); moveGo(dragFrom, dragTo); dragFrom = dragTo = -1 }
    ;(e.target as HTMLElement).addEventListener('pointermove', move)
    ;(e.target as HTMLElement).addEventListener('pointerup', up, { once: true })
    ;(e.target as HTMLElement).addEventListener('pointercancel', up, { once: true })
  }
  /** 갈 곳과 길 고르기를 주소에 담는다: ?c=<base64url(JSON)> */
  function shareUrl(): string {
    const rows = go.map((g) => [g.name, +g.lon.toFixed(6), +g.lat.toFixed(6), g.cat, g.sub === '스팟' ? 's' : ''])
    const b = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ v: 1, m: routeMode, g: rows })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${location.origin}${location.pathname}?c=${b}`
  }
  function readShared(): { m: ModeId; g: Place[] } | null {
    const c = new URLSearchParams(location.search).get('c'); if (!c) return null
    try {
      const bin = atob(c.replace(/-/g, '+').replace(/_/g, '/'))
      const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))))
      const g: Place[] = (j.g as [string, number, number, number, string][]).slice(0, MAX_GO).map((r, i) => ({ id: `sh${i}-${r[1]},${r[2]}`, name: String(r[0]).slice(0, 60), lon: +r[1], lat: +r[2], cat: Number.isInteger(r[3]) ? r[3] : -1, sub: r[4] === 's' ? '스팟' : '', addr: '', floor: null }))
      return g.every((p) => isFinite(p.lon) && isFinite(p.lat)) && g.length ? { m: MODES.some((x) => x.id === j.m) ? j.m : 'balance', g } : null
    } catch { return null }
  }
  async function share() {
    const url = shareUrl(), title = `트이길 동선 ${go.length}곳`
    try {
      if (navigator.share) { await navigator.share({ title, text: go.map((g, i) => `${i + 1}. ${g.name}`).join('\n'), url }); return }
      await navigator.clipboard.writeText(url); say('동선 링크를 복사했어요.')
    } catch (e) { if ((e as Error)?.name !== 'AbortError') say('링크를 만들지 못했어요. 잠시 뒤에 다시 해 주세요.') }
  }
  function takeShared(replace: boolean) {
    if (replace && incoming) { go = incoming; store.set('gn.go', go); incoming = null; history.replaceState(null, '', location.pathname); makeRoute() }
    else { incoming = null; history.replaceState(null, '', location.pathname); mode = 'idle' }
  }
  const mins = (m: number) => Math.max(1, Math.round(m / WALK))
  const timeText = (m: number) => { const t = mins(m); return t < 60 ? `${t}분` : `${Math.floor(t / 60)}시간${t % 60 ? ` ${t % 60}분` : ''}` }
  const kmText = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)

  // ---- 검색
  async function openSearch() {
    searchOpen = true; viewTick++
    await tick(); searchEl?.focus()
    loadPlaces()
  }
  function closeSearch() { searchOpen = false }
  const shared = $derived(db && looksShared(query) ? db.fromShare(query) : null)
  const results = $derived.by(() => {
    viewTick
    if (!db || looksShared(query) || (!query.trim() && cat === null)) return [] as { p: Place; d: number }[]
    const o = origin()
    return db.search(query, cat).map((p) => ({ p, d: meters(o, [p.lon, p.lat]) })).sort((a, b) => a.d - b.d).slice(0, 40)
  })
  function pickResult(p: Place, from: typeof placeFrom = 'search') { closeSearch(); showPlace(p, from) }

  async function restyle() {
    if (!map) return
    map.setStyle(await basemap(theme))
    map.once('styledata', () => { addOverlay(); drawRoute() })
  }
  function toggle(key: keyof Prefs) {
    const next = { ...prefs, [key]: !prefs[key] }
    if (!next.k && !next.w && !next.g) { say('하늘, 물, 녹지 중 하나는 켜 두어야 해요.'); return }
    prefs = next; store.set('gn.prefs', next); repaint()
    if (nearOn) computeNear()
    if (mode === 'route') makeRoute(false)
  }
  function switchTheme() {
    themeName = themeName === 'light' ? 'night' : 'light'; store.set('gn.theme', themeName); restyle()
  }
  function locate() {
    if (!map || locating) return
    if (!('geolocation' in navigator)) { say('이 기기에서는 현재 위치를 쓸 수 없어요.'); return }
    locating = true
    navigator.geolocation.getCurrentPosition((pos) => {
      locating = false
      const { longitude: x, latitude: y } = pos.coords
      meAt = [x, y]
      if (!me) { const el = document.createElement('div'); el.className = 'me'; me = new maplibregl.Marker({ element: el }) }
      me.setLngLat([x, y]).addTo(map!)
      const b = region?.bbox
      if (b && (x < b[0] || x > b[2] || y < b[1] || y > b[3])) say(`지금은 ${region!.name}만 볼 수 있어요.`)
      map!.flyTo({ center: [x, y], zoom: Math.max(map!.getZoom(), 15.5), essential: true })
    }, (err) => {
      locating = false
      say(err.code === err.PERMISSION_DENIED ? '위치 권한을 허용하면 현재 위치로 갈 수 있어요.' : '현재 위치를 찾지 못했어요. 잠시 뒤에 다시 눌러 주세요.')
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 })
  }

  const lead = $derived.by(() => {
    if (!picked) return null
    const calm = picked.c < 70 ? '큰길 옆이라 차가 많이 다녀요.' : picked.c >= 110 ? '공원이나 보행로라 걷기 편해요.' : ''
    return { kind: picked.kind === 'n' ? null : picked.kind, title: KIND_LINE[picked.kind] + '이에요', calm }
  })
  const sun = $derived(sunTimes())
  const spotLines = $derived.by(() => {
    if (!spot) return [] as string[]
    const s = spot, out: string[] = []
    if (s.dir && !s.title.includes(s.dir + '쪽')) out.push(`${s.dir}쪽으로 멀리 트여 있어요.`)
    if (s.water >= 0.5) out.push('강이 보여요.')
    else if (s.nat >= 15) out.push(`시야의 ${s.nat}%가 나무와 풀이에요.`)
    if (s.elev >= 45) out.push(`해발 ${s.elev}m 언덕이라 내려다보는 뷰예요.`)
    if (s.calm) out.push('큰길에서 떨어져 있어 조용해요.')
    if (s.west < 6) out.push(`서쪽이 트여 노을이 보여요. 오늘은 ${hhmm(sun.set)}에 해가 져요.`)
    return out
  })
  const frontLines = $derived.by(() => {
    if (!place) return [] as string[]
    const f = frontOf(place), out: string[] = []
    const who = place.cat >= 0 ? '가게 앞 길' : '이 자리 앞 길'
    if (!f) { out.push(`${who}의 뷰 정보는 아직 없어요.`); return out }
    out.push(`${who}에서 하늘이 시야의 ${f.ps}% 보여요.`)
    if (f.pw >= 0.3) out.push('강이 보이는 길이에요.')
    else if (f.pg >= 15) out.push(`시야의 ${f.pg}%가 나무와 풀이에요.`)
    if (f.c < 70) out.push('큰길 옆이에요.')
    return out
  })
  const goSummary = $derived(go.length ? (go.length <= 2 ? go.map((g) => g.name).join(', ') : `${go[0].name}, ${go[1].name} 외 ${go.length - 2}곳`) : '')

  $effect(() => {
    const r = document.documentElement.style, t = theme
    r.setProperty('--bg', t.bg); r.setProperty('--surf', t.surf); r.setProperty('--line', t.line); r.setProperty('--ink', t.ink)
    r.setProperty('--sub', t.sub); r.setProperty('--acc', t.acc); r.setProperty('--on-acc', t.onAcc)
    r.setProperty('--dot-k', t.dot.k); r.setProperty('--dot-w', t.dot.w); r.setProperty('--dot-g', t.dot.g)
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.bg)
    untrack(recolor)
  })
  $effect(() => { go.length; go; if (ready) untrack(drawGo) })
  $effect(() => { if (mode !== 'route' && ready) untrack(() => drawRoute()) })
  $effect(() => {
    if (!sheetEl) return
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--sheet-h', sheetEl!.offsetHeight + 'px'))
    ro.observe(sheetEl); return () => ro.disconnect()
  })

  /** 지도를 길게 누르면 그 자리를 고른다. 손가락이 10px 넘게 움직이면 취소. */
  function bindLongPress() {
    let timer = 0, sx = 0, sy = 0
    const stop = () => clearTimeout(timer)
    mapEl.addEventListener('touchstart', (e) => {
      stop(); if (e.touches.length !== 1) return
      sx = e.touches[0].clientX; sy = e.touches[0].clientY
      timer = window.setTimeout(() => { const r = mapEl.getBoundingClientRect(); navigator.vibrate?.(12); onLongPress(map!.unproject([sx - r.left, sy - r.top])) }, 550)
    }, { passive: true })
    mapEl.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) stop() }, { passive: true })
    mapEl.addEventListener('touchend', stop); mapEl.addEventListener('touchcancel', stop)
    map!.on('contextmenu', (e) => { e.preventDefault(); onLongPress(e.lngLat) })
  }

  onMount(() => {
    let dead = false
    const timer = window.setInterval(() => (dusk = duskMix()), 60_000)
    ;(async () => {
      try {
        const man = await (await fetch('./data/manifest.json')).json()
        region = man.regions[0] as Region
        const [style, links, sp] = await Promise.all([basemap(theme), fetch('./data/' + region.links).then((r) => r.json()), fetch('./data/' + region.spots).then((r) => r.json()).catch(() => [])])
        if (dead) return
        raw = links as Fc; spots = sp as Spot[]
        mids = raw.features.map((f) => f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)] as [number, number])
        map = new maplibregl.Map({ container: mapEl, style, center: region.center, zoom: region.zoom, minZoom: 11, maxZoom: 19, attributionControl: { compact: true, customAttribution: '서울시, 국토지리정보원, 소상공인시장진흥공단' }, dragRotate: false, pitchWithRotate: false })
        map.touchZoomRotate.disableRotation()
        if (import.meta.env.DEV || location.hostname === 'localhost') (window as any).__tg = { map: () => map }
        map.on('load', () => {
          addOverlay(); addPins(); drawGo()
          const sh = readShared()
          if (sh) {
            routeMode = sh.m
            if (!go.length) { go = sh.g; store.set('gn.go', go); history.replaceState(null, '', location.pathname); makeRoute() }
            else { incoming = sh.g; mode = 'idle' }
          }
        })
        map.on('moveend', nearLater)
        map.on('click', (e) => {
          if (Date.now() < quietClick) return
          const hit = map!.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['links-hit'] })
          if (mode === 'route') return
          if (hit[0]) showLink(hit[0].geometry, hit[0].properties as Shown)
          else closeSheet()
        })
        bindLongPress()
      } catch (e) { failed = /webgl/i.test(String(e)) ? 'gl' : 'load' }
    })()
    return () => { dead = true; clearInterval(timer); map?.remove() }
  })
</script>

{#snippet x(label: string, back = false)}
  <button type="button" class="icon ghost" onclick={closeSheet} aria-label={label}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={back ? 'M15 5l-7 7 7 7' : 'M6 6l12 12M18 6L6 18'}/></svg>
  </button>
{/snippet}
{#snippet chevron()}
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
{/snippet}

<main class="shell">
  <div class="map" bind:this={mapEl} aria-label="뷰 점수로 길을 칠한 지도. 길게 누르면 그 자리를 고를 수 있어요."></div>
  {#if !ready && !failed}<div class="veil" aria-hidden="true"></div>{/if}

  <header class="top">
    <div class="bar">
      <span class="brand">트이길</span>
      <button type="button" class="find" onclick={openSearch} aria-haspopup="dialog">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <span>가게나 장소 찾기</span>
      </button>
      <button type="button" class="icon" onclick={switchTheme} aria-label={themeName === 'light' ? '밤 화면으로 바꾸기' : '낮 화면으로 바꾸기'}>
        {#if themeName === 'light'}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
        {:else}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>
        {/if}
      </button>
    </div>
    <div class="chips" role="group" aria-label="보고 싶은 것 고르기">
      {#each CHIPS as c (c.key)}
        <button type="button" class="chip" class:on={prefs[c.key]} aria-pressed={prefs[c.key]} onclick={() => toggle(c.key)}>
          {#if c.kind}<span class="dot" style:background={prefs[c.key] ? theme.dot[c.kind] : theme.none}></span>{/if}
          {c.label}
        </button>
      {/each}
    </div>
  </header>

  {#if ready && mode !== 'route'}
    <button type="button" class="pill nearby" onclick={toggleNear} aria-pressed={nearOn}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l5-6 4 4 3-3 6 5"/><circle cx="17" cy="6.5" r="2.5"/></svg>
      주변 뷰 좋은 곳
    </button>
  {/if}
  <button type="button" class="icon locate" onclick={locate} aria-label="현재 위치로 가기" aria-busy={locating}>
    <svg class:spin={locating} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/></svg>
  </button>

  <section class="sheet" bind:this={sheetEl} aria-live="polite">
    <div class="grip" aria-hidden="true"></div>
    {#if failed}
      <h1>{failed === 'gl' ? '이 브라우저에서는 지도를 그릴 수 없어요' : '지도를 불러오지 못했어요'}</h1>
      <p>{failed === 'gl' ? '크롬이나 사파리 최신 버전에서 열어 주세요.' : '인터넷 연결을 확인하고 화면을 새로 고쳐 주세요.'}</p>
    {:else if !ready}
      <div class="row start"><span class="loader" aria-hidden="true"></span><h1>지도를 그리고 있어요</h1></div>
      <p>길마다 보이는 것을 색으로 칠하는 중이에요.</p>
    {:else if mode === 'place' && place}
      {@const saved = isGo(place)}
      {@const backToGo = placeFrom === 'go' && go.length > 0}
      <div class="row">
        <span class="badge">{place.cat >= 0 ? CAT_LABEL[place.cat] : place.sub === '스팟' ? '스팟' : placeFrom === 'share' ? '공유한 주소' : '지도에서 고른 곳'}</span>
        {@render x(backToGo ? '갈 곳 목록으로 돌아가기' : nearOn ? '목록으로 돌아가기' : '장소 정보 닫기', backToGo || nearOn)}
      </div>
      <h1 class="big">{place.name}</h1>
      {#if (place.sub && place.sub !== '스팟') || place.floor !== null || place.addr}
        <p>{[place.sub === '스팟' ? '' : place.sub, place.addr, floorText(place.floor)].filter(Boolean).join(', ')}</p>
      {/if}
      <ul class="lines">{#each frontLines as l}<li>{l}</li>{/each}</ul>
      {#if saved}
        <button type="button" class="wide ghostbtn" onclick={() => removeGo(place!)}>갈 곳에서 빼기</button>
      {:else}
        <button type="button" class="wide primary" onclick={() => addGo(place!)}>갈 곳에 넣기</button>
      {/if}
    {:else if mode === 'go'}
      <div class="row">
        <h1>갈 곳 {go.length}곳</h1>
        {@render x('갈 곳 목록 닫기')}
      </div>
      {#if go.length > 1}<p>손잡이를 끌어서 순서를 바꿀 수 있어요.</p>{/if}
      <ol class="list">
        {#each go as g, i (g.id)}
          <li class="gorow" class:lift={dragFrom === i} class:gap-above={dragFrom >= 0 && dragTo === i && dragFrom > i} class:gap-below={dragFrom >= 0 && dragTo === i && dragFrom < i}>
            <button type="button" class="item" onclick={() => showPlace(g, 'go')}>
              <span class="num" aria-hidden="true">{i + 1}</span>
              <span class="txt"><strong>{g.name}</strong><span>{[g.cat >= 0 ? CAT_LABEL[g.cat] : g.sub === '스팟' ? '스팟' : '', g.addr].filter(Boolean).join(', ') || '지도에서 고른 곳'}</span></span>
            </button>
            {#if go.length > 1}
              <button type="button" class="icon handle" aria-label={`${g.name} 순서 바꾸기. 위아래 화살표로 옮겨요.`} onpointerdown={(e) => dragStart(e, i)}
                onkeydown={(e) => { if (e.key === 'ArrowUp') { e.preventDefault(); moveGo(i, i - 1) } else if (e.key === 'ArrowDown') { e.preventDefault(); moveGo(i, i + 1) } }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>
              </button>
            {/if}
            <button type="button" class="icon rm" onclick={() => removeGo(g)} aria-label={`${g.name} 빼기`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>
            </button>
          </li>
        {/each}
      </ol>
      {#if go.length >= 2}
        <button type="button" class="wide primary" onclick={() => makeRoute()}>동선 잇기</button>
      {:else}
        <p>두 곳 이상 넣으면 뷰 좋은 길로 이어 드려요.</p>
      {/if}
    {:else if mode === 'route'}
      <div class="row">
        <h1>동선</h1>
        <button type="button" class="icon ghost" onclick={leaveRoute} aria-label="갈 곳 목록으로 돌아가기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
        </button>
      </div>
      {#if routeErr}
        <p>{routeErr}</p>
      {:else if !routes}
        <div class="row start"><span class="loader" aria-hidden="true"></span><p>뷰 좋은 길을 찾고 있어요.</p></div>
      {:else}
        <div class="tabs" role="tablist" aria-label="길 고르기">
          {#each MODES as m (m.id)}
            {@const r = routes.find((x) => x.mode === m.id)!}
            <button type="button" role="tab" class="tab" aria-selected={routeMode === m.id} onclick={() => pickMode(m.id)}>
              <span>{m.label}</span><strong>{timeText(r.len)}</strong><span class="km">{kmText(r.len)}</span>
            </button>
          {/each}
        </div>
        {#if current && fastest}
          {@const extra = mins(current.len) - mins(fastest.len)}
          {@const good = Math.round((current.share.k + current.share.w + current.share.g) * 100)}
          {@const top = current.share.k >= current.share.w && current.share.k >= current.share.g ? '하늘이 트인' : current.share.w >= current.share.g ? '물이 보이는' : '녹지가 보이는'}
          <ul class="lines">
            <li>{good > 0 ? `뷰 좋은 구간이 전체의 ${good}%예요.` : '이 동선에는 뷰 좋은 구간이 거의 없어요.'}</li>
            {#if good > 0}<li>그중 {top} 길이 가장 길어요.</li>{/if}
            {#if current.mode !== 'fast'}<li>{extra > 0 ? `가장 빠른 길보다 ${extra}분 더 걸어요.` : '가장 빠른 길과 시간이 같아요.'}</li>{/if}
          </ul>
          <ol class="legs">
            {#each go as g, i (g.id)}
              <li><span class="num sm" aria-hidden="true">{i + 1}</span><span class="nm">{g.name}</span></li>
              {#if i < go.length - 1 && current.legs[i]}
                <li class="leg">걸어서 {timeText(current.legs[i].len)}, {kmText(current.legs[i].len)}</li>
                {#if sugs[i]}
                  {@const sp = spots.find((s) => s.id === sugs[i]!.id)}
                  {#if sp}
                    <li class="sug">
                      <span>{mins(sugs[i]!.extra)}분 더 걸으면 {sp.title}에 들를 수 있어요.</span>
                      <button type="button" class="mini" onclick={() => addDetour(i, sp.id)}>들르기</button>
                    </li>
                  {/if}
                {/if}
              {/if}
            {/each}
          </ol>
          <div class="two">
            {#if go.length >= 3}<button type="button" class="wide ghostbtn" onclick={tidyOrder} disabled={routeBusy}>순서 정리하기</button>{/if}
            <button type="button" class="wide primary" onclick={share}>공유하기</button>
          </div>
        {/if}
      {/if}
    {:else if mode === 'spot' && spot}
      {@const inGo = go.some((g) => g.id === spot!.id)}
      <div class="row">
        <span class="badge">이 동네 상위 {Math.max(1, Math.ceil(spot.top))}%</span>
        {@render x(nearOn ? '목록으로 돌아가기' : '스팟 정보 닫기', nearOn)}
      </div>
      <h1 class="big">{spot.title}</h1>
      {#if spotLines.length}<ul class="lines">{#each spotLines as l}<li>{l}</li>{/each}</ul>{/if}
      <dl class="facts three">
        <div><dt>하늘</dt><dd>시야의 {spot.sky}%</dd></div>
        <div><dt>트인 방향</dt><dd>{spot.pano}도</dd></div>
        <div><dt>해발</dt><dd>{spot.elev}m</dd></div>
      </dl>
      <button type="button" class="wide ghostbtn" disabled={inGo} onclick={() => addGo({ id: spot!.id, name: spot!.title, sub: '스팟', lon: spot!.lon, lat: spot!.lat, addr: '', floor: null, cat: -1 })}>
        {inGo ? '갈 곳에 있어요' : '갈 곳에 넣기'}
      </button>
    {:else if mode === 'near'}
      <div class="row">
        <h1>주변 뷰 좋은 곳</h1>
        <button type="button" class="icon ghost" onclick={toggleNear} aria-label="목록 닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      {#if near.length}
        <p>{nearFrom === 'me' ? '현재 위치에서 가까운 순서예요.' : '지도 가운데에서 가까운 순서예요.'}</p>
        <ul class="list">
          {#each near as n (n.type === 'spot' ? n.spot.id : 'l' + n.f.id)}
            {@const kind = n.type === 'spot' ? n.spot.kind : (n.f.properties.kind as Kind)}
            <li>
              <button type="button" class="item" onclick={() => openNear(n)}>
                <span class="mark" class:spotmark={n.type === 'spot'} style:background={theme.dot[kind]} aria-hidden="true"></span>
                <span class="txt">
                  <strong>{n.type === 'spot' ? n.spot.title : KIND_LINE[kind]}</strong>
                  <span>{n.type === 'spot' ? '스팟' : '길'}, {distText(n.d)}, {walkText(n.d)}</span>
                </span>
                {@render chevron()}
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p>이 화면에는 뷰 좋은 곳이 없어요. 지도를 옮기거나 넓혀 보세요.</p>
      {/if}
    {:else if mode === 'link' && picked && lead}
      <div class="row">
        <h1>{lead.title}</h1>
        {@render x(nearOn ? '목록으로 돌아가기' : '길 정보 닫기', nearOn)}
      </div>
      <dl class="facts">
        <div><dt>하늘</dt><dd>시야의 {picked.ps}%</dd></div>
        <div><dt>물</dt><dd>{picked.pw >= 0.3 ? '보여요' : '안 보여요'}</dd></div>
        <div><dt>트인 방향</dt><dd>{picked.pa}도</dd></div>
        <div><dt>해발</dt><dd>{picked.z}m</dd></div>
      </dl>
      {#if lead.calm}<p>{lead.calm}</p>{/if}
    {:else if incoming}
      <h1>공유받은 동선이에요</h1>
      <p>{incoming.map((g) => g.name).join(', ')}</p>
      <p>지금 갈 곳 {go.length}곳을 이 동선으로 바꿀까요?</p>
      <div class="two">
        <button type="button" class="wide ghostbtn" onclick={() => takeShared(false)}>그대로 두기</button>
        <button type="button" class="wide primary" onclick={() => takeShared(true)}>바꾸기</button>
      </div>
    {:else}
      <h1>색이 진한 길일수록 뷰가 좋아요</h1>
      <p>길을 누르면 그 길에서 무엇이 보이는지 알려 드려요. 지도를 길게 누르면 그 자리를 갈 곳에 넣을 수 있어요.</p>
      {#if go.length}
        <button type="button" class="item" onclick={() => (mode = 'go')}>
          <span class="num" aria-hidden="true">{go.length}</span>
          <span class="txt"><strong>갈 곳 {go.length}곳</strong><span>{goSummary}</span></span>
          {@render chevron()}
        </button>
      {/if}
    {/if}
  </section>

  {#if searchOpen}
    <div class="search" role="dialog" aria-modal="true" aria-label="가게나 장소 찾기">
      <div class="sbar">
        <button type="button" class="icon" onclick={closeSearch} aria-label="찾기 닫기">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
        </button>
        <label class="sr" for="q">가게 이름이나 공유한 글자</label>
        <textarea id="q" rows="1" bind:this={searchEl} bind:value={query} placeholder="가게 이름이나 공유한 글자를 넣어 주세요" autocomplete="off" enterkeyhint="search"
          onkeydown={(e) => { if (e.key === 'Escape') closeSearch(); else if (e.key === 'Enter' && !e.shiftKey && !looksShared(query)) { e.preventDefault(); (e.currentTarget as HTMLElement).blur() } }}></textarea>
        {#if query}
          <button type="button" class="icon" onclick={() => { query = ''; searchEl?.focus() }} aria-label="지우기">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        {/if}
      </div>
      <div class="chips cats" role="group" aria-label="업종 고르기">
        {#each CAT_LABEL as label, i}
          <button type="button" class="chip" class:on={cat === i} aria-pressed={cat === i} onclick={() => (cat = cat === i ? null : i)}>{label}</button>
        {/each}
      </div>
      <div class="sbody">
        {#if !db}
          <div class="row start"><span class="loader" aria-hidden="true"></span><p>가게 정보를 불러오고 있어요.</p></div>
        {:else if shared}
          {#if shared.place}
            <p>{shared.found === 'shop' ? '공유한 글자에서 가게를 찾았어요.' : '가게는 못 찾았지만 주소 위치를 찾았어요.'}</p>
            <button type="button" class="item" onclick={() => pickResult(shared!.place!, 'share')}>
              <span class="txt"><strong>{shared.place.name}</strong><span>{[shared.place.sub, shared.place.addr, floorText(shared.place.floor)].filter(Boolean).join(', ')}</span></span>
              {@render chevron()}
            </button>
          {:else}
            <p>{shared.addr} 주소를 찾지 못했어요. 지금은 {region?.name} 근처만 찾을 수 있어요. 지도를 길게 눌러 직접 고를 수도 있어요.</p>
          {/if}
        {:else if looksShared(query)}
          <p>공유한 글자에서 주소를 찾지 못했어요. 가게 이름만 넣어 보거나 지도를 길게 눌러 직접 골라 주세요.</p>
        {:else if !query.trim() && cat === null}
          <p>가게 이름을 쓰거나 업종을 골라 주세요. 네이버지도에서 공유한 글자를 그대로 붙여 넣어도 돼요.</p>
        {:else if !results.length}
          <p>찾는 가게가 없어요. 지금은 {region?.name} 근처만 찾을 수 있어요.</p>
        {:else}
          <p>{meAt ? '현재 위치에서' : '지도 가운데에서'} 가까운 순서예요.</p>
          <ul class="list">
            {#each results as r (r.p.id)}
              <li>
                <button type="button" class="item" onclick={() => pickResult(r.p)}>
                  <span class="txt"><strong>{r.p.name}</strong><span>{[r.p.sub, floorText(r.p.floor), distText(r.d)].filter(Boolean).join(', ')}</span></span>
                  {#if isGo(r.p)}<span class="tag">갈 곳</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}

  {#if toast}<div class="toast" class:high={searchOpen} role="status">{toast}</div>{/if}
</main>

<style>
  .shell { position: fixed; inset: 0; overflow: hidden; background: var(--bg); color: var(--ink) }
  .map { position: absolute; inset: 0; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }
  .veil { position: absolute; inset: 0; background: linear-gradient(100deg, var(--surf) 30%, var(--bg) 50%, var(--surf) 70%); background-size: 300% 100%; animation: shimmer 1.6s linear infinite }
  @keyframes shimmer { from { background-position: 100% 0 } to { background-position: -50% 0 } }
  .top { position: absolute; left: 0; right: 0; top: 0; padding: calc(12px + env(safe-area-inset-top)) 16px 0; display: flex; flex-direction: column; gap: 10px; pointer-events: none }
  .top > * { pointer-events: auto }
  .bar { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 6px 0 16px; border-radius: 16px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1) }
  .brand { font-family: 'Gowun Dodum', 'Noto Sans KR', sans-serif; font-size: 20px; letter-spacing: -0.01em; flex: none }
  .find { flex: 1; min-width: 0; height: 40px; padding: 0 12px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 12px; background: var(--surf); color: var(--sub); font-size: 15px; text-align: left }
  .find span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .icon { width: 44px; height: 44px; flex: none; display: grid; place-items: center; border-radius: 22px; border: 0; background: transparent }
  .icon.ghost { margin: -8px -10px -8px 0; color: var(--sub) }
  .chips { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding-bottom: 4px }
  .chips::-webkit-scrollbar { display: none }
  .chip { height: 44px; padding: 0 16px; display: flex; align-items: center; gap: 8px; border-radius: 22px; border: 1.5px solid var(--line); background: var(--bg); color: var(--sub); font-size: 14px; font-weight: 500; white-space: nowrap; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.08); transition: border-color 0.15s, color 0.15s }
  .chip.on { border-color: var(--ink); color: var(--ink); font-weight: 700 }
  .dot { width: 10px; height: 10px; border-radius: 5px; transition: background 0.15s }
  .locate { position: absolute; right: 16px; bottom: calc(var(--sheet-h, 150px) + 16px); width: 48px; height: 48px; border-radius: 24px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14) }
  .pill { height: 48px; padding: 0 18px 0 14px; display: flex; align-items: center; gap: 8px; border-radius: 24px; border: 1px solid var(--line); background: var(--bg); font-size: 15px; font-weight: 700; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14) }
  .nearby { position: absolute; left: 16px; bottom: calc(var(--sheet-h, 150px) + 16px) }
  .nearby[aria-pressed='true'] { background: var(--ink); color: var(--bg); border-color: var(--ink) }
  .spin { animation: spin 1.1s linear infinite }
  @keyframes spin { to { transform: rotate(360deg) } }
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; max-width: 520px; max-height: 50vh; overflow-y: auto; margin: 0 auto; padding: 10px 20px calc(20px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px; background: var(--bg); border-radius: 24px 24px 0 0; box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.14) }
  .grip { width: 40px; height: 4px; border-radius: 2px; background: var(--line); align-self: center; flex: none }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px }
  .row.start { justify-content: flex-start }
  h1 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3 }
  h1.big { font-size: 24px; margin-top: -2px }
  p { margin: 0; font-size: 14px; color: var(--sub) }
  .badge { font-size: 13px; font-weight: 700; padding: 6px 12px; border-radius: 14px; background: var(--surf); border: 1px solid var(--line) }
  .lines { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 15px }
  .facts { margin: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px }
  .facts.three { grid-template-columns: repeat(3, 1fr) }
  .facts div { padding: 10px 8px; border-radius: 12px; background: var(--surf); border: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px }
  dt { font-size: 12px; color: var(--sub) }
  dd { margin: 0; font-size: 15px; font-weight: 700; white-space: nowrap }
  .wide { width: 100%; height: 52px; border-radius: 16px; font-size: 16px; font-weight: 700; flex: none }
  .primary { border: 0; background: var(--acc); color: var(--on-acc) }
  .ghostbtn { border: 1.5px solid var(--line); background: var(--surf); color: var(--ink) }
  .ghostbtn:disabled { color: var(--sub); cursor: default }
  .list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px }
  .item { width: 100%; min-height: 60px; padding: 10px 12px; display: flex; align-items: center; gap: 12px; text-align: left; border-radius: 14px; border: 1px solid var(--line); background: var(--surf); color: var(--ink) }
  .mark { width: 14px; height: 6px; border-radius: 3px; flex: none }
  .mark.spotmark { width: 14px; height: 14px; border-radius: 7px; box-shadow: 0 0 0 3px var(--bg), 0 0 0 4.5px var(--ink) }
  .num { width: 28px; height: 28px; border-radius: 14px; flex: none; display: grid; place-items: center; background: var(--acc); color: var(--on-acc); font-size: 14px; font-weight: 700 }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px }
  .txt strong { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .txt span { font-size: 13px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .item :global(svg) { color: var(--sub); flex: none }
  .tag { font-size: 12px; font-weight: 700; padding: 4px 8px; border-radius: 10px; background: var(--acc); color: var(--on-acc); flex: none }
  .gorow { display: flex; align-items: center; gap: 6px; transition: transform 0.12s }
  .gorow.lift { opacity: 0.6 }
  .gorow.gap-above { box-shadow: 0 -3px 0 var(--acc) }
  .gorow.gap-below { box-shadow: 0 3px 0 var(--acc) }
  .handle { color: var(--sub); touch-action: none; cursor: grab }
  .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 4px; border-radius: 16px; background: var(--surf); border: 1px solid var(--line) }
  .tab { min-height: 64px; padding: 8px 4px; border: 0; border-radius: 12px; background: transparent; color: var(--sub); display: flex; flex-direction: column; align-items: center; gap: 1px; font-size: 13px }
  .tab strong { font-size: 17px; color: var(--ink) }
  .tab .km { font-size: 12px }
  .tab[aria-selected='true'] { background: var(--bg); box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12); color: var(--ink); font-weight: 700 }
  .legs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px }
  .legs li { display: flex; align-items: center; gap: 10px; font-size: 15px }
  .legs .nm { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .legs .leg { padding-left: 11px; margin-left: 11px; border-left: 2px dashed var(--line); color: var(--sub); font-size: 13px; min-height: 26px }
  .legs .sug { margin-left: 11px; padding: 10px 12px; border-radius: 12px; background: var(--surf); border: 1px solid var(--line); justify-content: space-between; font-size: 14px }
  .two { display: flex; gap: 8px }
  .two > * { flex: 1 }
  .num.sm { width: 24px; height: 24px; font-size: 13px }
  .mini { height: 44px; padding: 0 14px; border-radius: 12px; border: 0; background: var(--acc); color: var(--on-acc); font-weight: 700; flex: none }
  .rm { color: var(--sub); border: 1px solid var(--line); background: var(--surf) }
  .loader { width: 18px; height: 18px; border-radius: 9px; border: 2.5px solid var(--line); border-top-color: var(--ink); animation: spin 0.9s linear infinite; flex: none }
  .search { position: absolute; inset: 0; z-index: 5; background: var(--bg); display: flex; flex-direction: column; padding-top: env(safe-area-inset-top) }
  .sbar { display: flex; align-items: flex-start; gap: 4px; padding: 8px 8px 8px 6px; border-bottom: 1px solid var(--line) }
  .sbar textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 96px; padding: 11px 4px; border: 0; outline: 0; resize: none; background: transparent; color: var(--ink); font: inherit; font-size: 16px; line-height: 1.4; field-sizing: content }
  .sbar textarea::placeholder { color: var(--sub) }
  .cats { padding: 10px 16px 4px }
  .cats .chip { box-shadow: none }
  .sbody { flex: 1; overflow-y: auto; padding: 8px 16px calc(20px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }
  .toast { position: absolute; z-index: 6; left: 50%; bottom: calc(var(--sheet-h, 150px) + 76px); transform: translateX(-50%); max-width: calc(100% - 32px); padding: 12px 16px; border-radius: 14px; background: var(--ink); color: var(--bg); font-size: 14px; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25) }
  .toast.high { bottom: 40px }
  :global(.me) { width: 18px; height: 18px; border-radius: 9px; background: var(--acc); border: 3px solid var(--bg); box-shadow: 0 0 0 6px color-mix(in srgb, var(--acc) 25%, transparent) }
  :global(.pin) { display: none !important }
  :global(.pins-on .pin) { display: grid !important }
  :global(.pin) { width: 44px; height: 44px; padding: 0; border: 0; background: transparent; place-items: center }
  :global(.pin .core) { width: 18px; height: 18px; border-radius: 9px; border: 3px solid var(--bg); box-shadow: 0 0 0 1.5px var(--ink), 0 2px 6px rgba(0, 0, 0, 0.3); transition: transform 0.15s }
  :global(.pin.k .core) { background: var(--dot-k) }
  :global(.pin.w .core) { background: var(--dot-w) }
  :global(.pin.g .core) { background: var(--dot-g) }
  :global(.pin.sel .core) { transform: scale(1.45); box-shadow: 0 0 0 2px var(--ink), 0 3px 10px rgba(0, 0, 0, 0.35) }
  :global(.gopin) { width: 32px; height: 32px; padding: 0; border-radius: 16px; border: 2.5px solid var(--bg); background: var(--acc); color: var(--on-acc); font: 700 14px/1 'Noto Sans KR', sans-serif; box-shadow: 0 0 0 1.5px var(--ink), 0 2px 8px rgba(0, 0, 0, 0.3); display: grid; place-items: center }
  :global(.tmp) { width: 22px; height: 30px; position: relative }
  :global(.tmp)::before { content: ''; position: absolute; inset: 0; background: var(--ink); clip-path: path('M11 30C11 30 0 17 0 11a11 11 0 0 1 22 0c0 6-11 19-11 19z') }
  :global(.tmp)::after { content: ''; position: absolute; left: 6px; top: 5px; width: 10px; height: 10px; border-radius: 5px; background: var(--bg) }
</style>
