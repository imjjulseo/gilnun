<script lang="ts">
  import { onMount, untrack, tick } from 'svelte'
  import maplibregl from 'maplibre-gl'
  import type { GeoJSONSource, Map as MlMap, ExpressionSpecification } from 'maplibre-gl'
  import { basemap, withSky, FONT, type ThemeName, type Kind } from './lib/theme'
  import { DEFAULT_PREFS, FLOOR, rate, type LinkProps, type Prefs } from './lib/score'
  import { skyAt, sunTimes, sunsetAz, sunsetWindow, hhmm } from './lib/sun'
  import { Places, CAT_LABEL, meters, floorText, type Place, type PoiData, type AddrData } from './lib/places'
  import { MODES, openness, type ModeId, type RouteResult } from './lib/route'
  import { saved, store, samePlace, WALKS } from './lib/saved.svelte'
  import { readTripUrl, tripUrl, type ShareArt } from './lib/share'
    import RouteWorker from './lib/route.worker.ts?worker'
  import SearchPanel, { type SearchTarget } from './components/SearchPanel.svelte'
  import CourseTab from './components/CourseTab.svelte'
  import SavedTab from './components/SavedTab.svelte'
  import SettingsTab from './components/SettingsTab.svelte'
  import ShareSheet from './components/ShareSheet.svelte'

  interface Region { id: string; name: string; bbox: [number, number, number, number]; center: [number, number]; zoom: number; links: string; spots: string; poi?: string; addr?: string; graph?: string; horizon?: string }
  interface Spot { id: string; rank: number; lat: number; lon: number; dong: string; title: string; kind: Kind; sky: number; water: number; nat: number; pano: number; dir: string | null; west: number; elev: number; top: number; prom: number; calm: boolean }
  type Shown = LinkProps & { kind: Kind | 'n'; v: number }
  type Fc = GeoJSON.FeatureCollection<GeoJSON.LineString, LinkProps>
  type Near = { type: 'spot'; spot: Spot; d: number } | { type: 'link'; f: GeoJSON.Feature<GeoJSON.LineString, Shown>; d: number }
  type Mode = 'idle' | 'link' | 'spot' | 'near' | 'place' | 'route'
  type Tab = 'map' | 'course' | 'saved' | 'settings'
  type Stop = Place | null

  const MAX_STOPS = 8
  const ME: Place = { id: 'me', name: '내 위치', sub: '', lon: 0, lat: 0, addr: '', floor: null, cat: -2 }
  const canMe = typeof navigator !== 'undefined' && 'geolocation' in navigator
  const systemNight = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

  let tab = $state<Tab>('map')
  let sysNight = $state(systemNight())
  const themeName = $derived<ThemeName>(saved.settings.theme === 'system' ? (sysNight ? 'night' : 'light') : saved.settings.theme)
  let prefs = $state<Prefs>({ ...DEFAULT_PREFS, ...store.get<Partial<Prefs>>('gn.prefs', {}) })
  let skyNow = $state(skyAt())
  let clock = $state(Date.now())
  const sky = $derived(saved.settings.sky === 'real' ? skyNow : { dusk: 0, night: 0 })
  const theme = $derived(withSky(themeName, sky))
  const walk = $derived(saved.settings.walk)
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
  let db = $state<Places | null>(null)
  let place = $state<Place | null>(null)
  let search = $state<{ target: SearchTarget; slot?: number } | null>(null)
  let folderPick = $state(false)
  let mapPick = $state<{ kind: 'set'; which: 'home' | 'work' } | { kind: 'slot'; slot: number } | null>(null)
  // 길 찾기
  let trip = $state<Stop[] | null>(null)
  let tripName = $state('')
  let routes = $state<RouteResult[] | null>(null)
  let routeMode = $state<ModeId>(store.get<ModeId>('gn.mode', 'balance'))
  let routeBusy = $state(false)
  let routeErr = $state('')
  let sugs = $state<({ id: string; extra: number } | null)[]>([])
  let dragFrom = $state(-1)
  let dragTo = $state(-1)
  let shareArt = $state<{ art: ShareArt; url: string } | null>(null)
  let horizon: { bins: number; data: Uint8Array } | null = null
  let sunsetOn = $state(false)
  let spotEta = $state<{ id: string; min: number } | null>(null)

  let mapEl: HTMLDivElement
  let map: MlMap | null = null
  let raw: Fc | null = null
  let mids: [number, number][] = []
  let me: maplibregl.Marker | null = null
  let meAt = $state.raw<[number, number] | null>(null)
  let tmp: maplibregl.Marker | null = null
  const pins = new Map<string, HTMLElement>()
  const stopPins: maplibregl.Marker[] = []
  let toastTimer = 0, nearTimer = 0, quietClick = 0, starTimer = 0

  const CHIPS: { key: keyof Prefs; label: string; kind?: Kind }[] = [
    { key: 'k', label: '하늘', kind: 'k' }, { key: 'w', label: '물', kind: 'w' }, { key: 'g', label: '녹지', kind: 'g' }, { key: 'calm', label: '조용한 길' },
  ]
  const KIND_W: Record<Kind | 'n', number> = { k: 1, w: 0.95, g: 0.85, n: 0 }
  const KIND_LINE: Record<Kind | 'n', string> = { k: '하늘이 넓게 보이는 길', w: '물이 보이는 길', g: '녹지가 보이는 길', n: '뷰가 약한 길' }
  const CAT_COLOR = ['#E07B39', '#9B6B43', '#9A5BB5', '#7D8A96', '#D9548A']

  function say(msg: string) { toast = msg; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (toast = ''), 3200) }
  const distText = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)
  const mins = (m: number) => Math.max(1, Math.round(m / walk))
  const timeText = (m: number) => { const t = mins(m); return t < 60 ? `${t}분` : `${Math.floor(t / 60)}시간${t % 60 ? ` ${t % 60}분` : ''}` }
  const walkText = (m: number) => `걸어서 ${timeText(m)}`
  const origin = (): [number, number] => { const c = map?.getCenter(); return meAt ?? (c ? [c.lng, c.lat] : region?.center ?? [0, 0]) }
  const inRegion = (x: number, y: number) => { const b = region?.bbox; return !!b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] }
  const kindOfPlace = (p: Place) => (p.id === 'me' ? '내 위치' : p.cat >= 0 ? CAT_LABEL[p.cat] : p.sub === '트인 자리' || p.sub === '스팟' ? '트인 자리' : '지도에서 고른 곳')

  // ---- 길 색칠
  function rated(): GeoJSON.FeatureCollection<GeoJSON.LineString, Shown> {
    return { type: 'FeatureCollection', features: raw!.features.map((f) => ({ ...f, properties: { ...f.properties, ...rate(f.properties, prefs) } })) }
  }
  function colorExpr(): ExpressionSpecification {
    const ramp = (k: Kind) => ['interpolate', ['linear'], ['get', 'v'], FLOOR, theme.none, 30, theme.ramp[k][0], 50, theme.ramp[k][1], 72, theme.ramp[k][2], 95, theme.ramp[k][3]]
    return ['match', ['get', 'kind'], 'k', ramp('k'), 'w', ramp('w'), 'g', ramp('g'), theme.none] as unknown as ExpressionSpecification
  }
  /** 밤에 하늘 길을 따라 반짝이는 별. 세 무리로 나눠 번갈아 밝아진다. */
  function starData(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    const feats: GeoJSON.Feature<GeoJSON.Point>[] = []
    if (!raw) return { type: 'FeatureCollection', features: feats }
    for (const f of raw.features) {
      const r = rate(f.properties, prefs); if (r.kind !== 'k' || r.v < 38) continue
      const id = Number(f.id ?? 0), h = (id * 2654435761) >>> 0
      if (h % 100 > 18 + r.v * 0.4) continue
      const co = f.geometry.coordinates, c = co[Math.floor(co.length / 2)]
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c[0] + ((h % 7) - 3) * 0.00003, c[1] + (((h >> 3) % 7) - 3) * 0.00002] }, properties: { g: h % 3, s: r.v } })
    }
    return { type: 'FeatureCollection', features: feats }
  }
  function poiData(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    const PRI = [1, 0, 2, 4, 3]
    return { type: 'FeatureCollection', features: (db?.list ?? []).map((p, i) => ({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { i, n: p.name, c: p.cat, k: PRI[p.cat] ?? 5 } })) }
  }
  function savedData(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    const seen = new Set<string>(), feats: GeoJSON.Feature<GeoJSON.Point>[] = []
    saved.folders.forEach((f) => f.items.forEach((p) => {
      const k = `${p.lon},${p.lat},${p.name}`; if (seen.has(k)) return; seen.add(k)
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { k, n: p.name } })
    }))
    return { type: 'FeatureCollection', features: feats }
  }
  function addOverlay() {
    if (!map || !raw) return
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
    const src = (id: string, data: GeoJSON.FeatureCollection) => { if (!map!.getSource(id)) map!.addSource(id, { type: 'geojson', data }) }
    src('links', rated()); src('pick', { type: 'FeatureCollection', features: [] }); src('stars', starData()); src('poi', poiData()); src('savedpts', savedData())
    src('route', { type: 'FeatureCollection', features: [] })
    const grow = ['+', 0.55, ['*', 0.011, ['get', 'v']]]
    const width = (a: number, b: number, scaled = true) => ['interpolate', ['linear'], ['zoom'], 12, ['*', a * 0.5, scaled ? grow : 1], 15, ['*', a, scaled ? grow : 1], 18, ['*', b, scaled ? grow : 1]] as unknown as ExpressionSpecification
    const add = (layer: maplibregl.LayerSpecification, top = false) => { if (!map!.getLayer(layer.id)) map!.addLayer(layer, top ? undefined : before) }
    add({ id: 'links', type: 'line', source: 'links', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'v'] }, paint: { 'line-color': colorExpr(), 'line-width': width(3, 7.5) } })
    for (let g = 0; g < 3; g++) add({ id: `stars-${g}`, type: 'circle', source: 'stars', filter: ['==', ['get', 'g'], g], paint: { 'circle-color': theme.starry.star, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.4, 16, 2.8, 18, 4.2], 'circle-blur': 0.45, 'circle-opacity': 0 } })
    add({ id: 'pick-halo', type: 'line', source: 'pick', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': theme.ink, 'line-width': width(8, 15, false), 'line-opacity': 0.9 } })
    add({ id: 'pick-line', type: 'line', source: 'pick', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colorExpr(), 'line-width': width(4.5, 10, false) } })
    add({ id: 'links-hit', type: 'line', source: 'links', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 } })
    const W = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 12, a * 0.6, 15, a, 18, b] as unknown as ExpressionSpecification
    add({ id: 'route-case', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': theme.ink, 'line-width': W(9, 16) } })
    add({ id: 'route-line', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': routeColor(), 'line-width': W(5.5, 11) } })
    add({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'walk'], 1], layout: { 'line-cap': 'round' }, paint: { 'line-color': theme.ink, 'line-width': 2.5, 'line-dasharray': [1, 2] } })
    // 가게 이름. 확대할수록 늘어나고 겹치면 덜 중요한 것부터 숨는다.
    add({ id: 'poi-dot', type: 'circle', source: 'poi', minzoom: 15.3, paint: { 'circle-color': ['match', ['get', 'c'], 0, CAT_COLOR[0], 1, CAT_COLOR[1], 2, CAT_COLOR[2], 3, CAT_COLOR[3], CAT_COLOR[4]], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15.3, 2, 17, 3.2, 19, 4.5], 'circle-stroke-color': theme.bg, 'circle-stroke-width': 1, 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 15.3, 0, 15.8, 0.9] } }, true)
    const label = (id: string, filter: ExpressionSpecification, minzoom: number) => add({ id, type: 'symbol', source: 'poi', minzoom, filter,
      layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 16, 11, 19, 13.5], 'text-anchor': 'top', 'text-offset': [0, 0.45], 'text-max-width': 7, 'symbol-sort-key': ['get', 'k'], 'text-padding': 3 },
      paint: { 'text-color': theme.sub, 'text-halo-color': theme.land, 'text-halo-width': 1.4 } }, true)
    label('poi-label-a', ['in', ['get', 'c'], ['literal', [0, 1, 4]]] as ExpressionSpecification, 16.2)
    label('poi-label-b', ['in', ['get', 'c'], ['literal', [2, 3]]] as ExpressionSpecification, 17.2)
    add({ id: 'saved-dot', type: 'circle', source: 'savedpts', paint: { 'circle-color': theme.acc, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 5.5, 19, 7], 'circle-stroke-color': theme.bg, 'circle-stroke-width': 2 } }, true)
    add({ id: 'saved-label', type: 'symbol', source: 'savedpts', minzoom: 14.5, layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 11.5, 19, 14], 'text-anchor': 'top', 'text-offset': [0, 0.7], 'text-max-width': 7, 'text-allow-overlap': false }, paint: { 'text-color': theme.ink, 'text-halo-color': theme.land, 'text-halo-width': 1.6 } }, true)
    ready = true
  }
  function recolor() {
    if (!map || !map.getLayer('links')) return
    const set = (l: string, k: string, v: unknown) => { if (map!.getLayer(l)) map!.setPaintProperty(l, k, v) }
    set('links', 'line-color', colorExpr()); set('pick-line', 'line-color', colorExpr()); set('pick-halo', 'line-color', theme.ink)
    set('route-line', 'line-color', routeColor()); set('route-case', 'line-color', theme.ink); set('route-walk', 'line-color', theme.ink)
    for (let g = 0; g < 3; g++) set(`stars-${g}`, 'circle-color', theme.starry.star)
    set('poi-dot', 'circle-stroke-color', theme.bg); set('saved-dot', 'circle-color', theme.acc); set('saved-dot', 'circle-stroke-color', theme.bg)
    for (const l of ['poi-label-a', 'poi-label-b']) { set(l, 'text-color', theme.sub); set(l, 'text-halo-color', theme.land) }
    set('saved-label', 'text-color', theme.ink); set('saved-label', 'text-halo-color', theme.land)
  }
  function routeColor(): ExpressionSpecification {
    const ramp = (k: Kind) => ['interpolate', ['linear'], ['get', 'v'], FLOOR, theme.sub, 30, theme.ramp[k][1], 60, theme.ramp[k][2], 90, theme.ramp[k][3]]
    return ['match', ['get', 'kind'], 'k', ramp('k'), 'w', ramp('w'), 'g', ramp('g'), theme.sub] as unknown as ExpressionSpecification
  }
  // 별빛: 밤 하늘 비중만큼, 세 무리가 번갈아 반짝인다
  let starClock = 0
  function twinkle() {
    if (!map || !map.getLayer('stars-0')) return
    const n = prefs.k && tab === 'map' && !document.hidden ? sky.night : 0
    starClock += 0.12
    for (let g = 0; g < 3; g++) map.setPaintProperty(`stars-${g}`, 'circle-opacity', n * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(starClock * 1.6 + g * 2.1))))
  }

  function clearPick() { picked = null; (map?.getSource('pick') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] }) }
  function selectPin(id: string | null) { for (const [k, el] of pins) el.classList.toggle('sel', k === id) }
  function clearSel() { clearPick(); spot = null; selectPin(null); place = null; folderPick = false; tmp?.remove() }
  function repaint() {
    if (!map || !map.getSource('links')) return
    ;(map.getSource('links') as GeoJSONSource).setData(rated())
    ;(map.getSource('stars') as GeoJSONSource).setData(starData())
    if (mode === 'link') { clearPick(); mode = baseMode() }
  }
  const tripReady = $derived(!!trip && trip.length >= 2 && trip.every(Boolean))
  function baseMode(): Mode { return trip && tripReady ? 'route' : nearOn ? 'near' : 'idle' }
  function showLink(geometry: GeoJSON.Geometry, props: Shown) {
    clearSel(); picked = props; mode = 'link'
    ;(map!.getSource('pick') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: props }] })
  }
  function showSpot(s: Spot, fly = true) {
    clearSel(); spot = s; mode = 'spot'; selectPin(s.id); spotEta = null
    if (fly && map) map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16), duration: 500 })
    if (sunsetWindow() && s.west < 6 && meAt && region?.graph) {
      call<RouteResult[] | { error: string }>('route', { stops: [[meAt[0], meAt[1]], [s.lon, s.lat]], prefs: $state.snapshot(prefs) }).then((r) => { if (!('error' in r) && spot?.id === s.id) spotEta = { id: s.id, min: mins(r[0].len) } }).catch(() => {})
    }
  }
  function closeSheet() {
    const back = baseMode(); clearSel(); mode = back
    if (back === 'near') computeNear()
    if (back === 'route') drawRoute()
  }
  function toggleNear() {
    nearOn = !nearOn; mapEl.classList.toggle('pins-on', nearOn); clearSel()
    if (nearOn) { computeNear(); mode = 'near' } else mode = baseMode()
  }
  function nearLater() { if (!nearOn) return; clearTimeout(nearTimer); nearTimer = window.setTimeout(computeNear, 250) }
  function addPins() {
    if (!map) return
    for (const s of spots) {
      const el = document.createElement('button')
      el.type = 'button'; el.className = `pin ${s.kind}`; el.setAttribute('aria-label', `트인 자리 ${s.title}`)
      el.innerHTML = '<span class="core" aria-hidden="true"></span>'
      el.addEventListener('click', (e) => { e.stopPropagation(); showSpot(s) })
      new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(map)
      pins.set(s.id, el)
    }
  }
  /** 화면 안의 트인 자리와 트인 길. 해 질 무렵에는 서쪽이 트여 노을이 보이는 자리를 먼저 보여 준다. */
  function computeNear() {
    if (!map || !raw) return
    const b = map.getBounds(), c = map.getCenter(), dusk = sunsetWindow()
    const inView = (x: number, y: number) => x >= b.getWest() && x <= b.getEast() && y >= b.getSouth() && y <= b.getNorth()
    const from: [number, number] = meAt && inView(...meAt) ? meAt : [c.lng, c.lat]
    nearFrom = meAt && from === meAt ? 'me' : 'center'
    const S: Near[] = spots.filter((s) => inView(s.lon, s.lat)).map((s) => ({ type: 'spot' as const, spot: s, d: meters(from, [s.lon, s.lat]) }))
      .sort((a, b) => (dusk ? Number(b.spot.west < 6) - Number(a.spot.west < 6) : 0) || a.spot.rank - b.spot.rank).slice(0, 3)
    const cand = rated().features.filter((f) => f.properties.kind !== 'n' && f.properties.v >= 60)
      .map((f) => ({ f, m: f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)] as [number, number] }))
      .filter(({ m }) => inView(...m)).sort((a, b) => b.f.properties.v * KIND_W[b.f.properties.kind] - a.f.properties.v * KIND_W[a.f.properties.kind])
    const L: Near[] = [], kinds = new Set<string>(), taken = S.map((s) => (s.type === 'spot' ? [s.spot.lon, s.spot.lat] : [0, 0]) as [number, number])
    for (const { f, m } of cand) {
      if (kinds.has(f.properties.kind) || taken.some((t) => meters(t, m) < 220)) continue
      L.push({ type: 'link', f, d: meters(from, m) }); taken.push(m); kinds.add(f.properties.kind)
      if (L.length === 2) break
    }
    near = dusk ? [...S, ...L] : [...S, ...L].sort((a, b) => a.d - b.d)
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
    if (dbWait) return dbWait
    dbWait = Promise.all([fetch('./data/' + region.poi).then((r) => r.json()), fetch('./data/' + region.addr).then((r) => r.json())])
      .then(([p, a]) => { db = new Places(p as PoiData, a as AddrData); (map?.getSource('poi') as GeoJSONSource | undefined)?.setData(poiData()); return db })
      .catch(() => { dbWait = null; say('가게 정보를 불러오지 못했어요. 잠시 뒤에 다시 해 주세요.'); return null })
    return dbWait
  }
  function frontOf(p: { lon: number; lat: number }): Shown | null {
    if (!raw) return null
    let bi = -1, bd = 60
    for (let i = 0; i < mids.length; i++) { const d = meters([p.lon, p.lat], mids[i]); if (d < bd) { bd = d; bi = i } }
    return bi < 0 ? null : { ...raw.features[bi].properties, ...rate(raw.features[bi].properties, prefs) }
  }
  function showPlace(p: Place, fly = true) {
    clearSel(); place = p; mode = 'place'
    if (!tmp) { const el = document.createElement('div'); el.className = 'tmp'; tmp = new maplibregl.Marker({ element: el, anchor: 'bottom' }) }
    tmp.setLngLat([p.lon, p.lat]).addTo(map!)
    if (fly && map) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 500 })
  }
  /** 지도에서 고르기: 누른 자리의 가게, 없으면 주소, 없으면 좌표 */
  async function placeAt(ll: maplibregl.LngLat): Promise<Place> {
    const d = await loadPlaces()
    const shop = d?.nearest(ll.lng, ll.lat, 15); if (shop) return shop
    const a = d?.nearestAddr(ll.lng, ll.lat, 25)
    return { id: `m${ll.lng.toFixed(6)},${ll.lat.toFixed(6)}`, name: a ? `${a} 근처` : '고른 위치', sub: '', lon: ll.lng, lat: ll.lat, addr: a ?? '', floor: null, cat: -1 }
  }
  async function pickAt(ll: maplibregl.LngLat) {
    const t = mapPick; if (!t) return
    const p = await placeAt(ll); mapPick = null
    if (t.kind === 'set') { saved.setPlace(t.which, p); say(`${t.which === 'home' ? '집' : '회사'} 위치를 정했어요.`) }
    else setStop(t.slot, p)
  }
  async function onLongPress(ll: maplibregl.LngLat) {
    if (mapPick) { pickAt(ll); return }
    quietClick = Date.now() + 800
    const d = await loadPlaces()
    const shop = d?.nearest(ll.lng, ll.lat, 15)
    if (shop) { showPlace(shop, false); return }
    const a = d?.nearestAddr(ll.lng, ll.lat, 25)
    showPlace({ id: `m${ll.lng.toFixed(6)},${ll.lat.toFixed(6)}`, name: a ? `${a} 근처` : '고른 위치', sub: '', lon: ll.lng, lat: ll.lat, addr: '', floor: null, cat: -1 }, false)
  }
  const spotPlace = (s: Spot): Place => ({ id: s.id, name: s.title, sub: '트인 자리', lon: s.lon, lat: s.lat, addr: '', floor: null, cat: -1 })
  function toggleStar(p: Place) {
    if (saved.isStarred(p)) { saved.unstarAll(p); folderPick = false; say('저장을 지웠어요.') }
    else { saved.star(p, 'f0'); folderPick = saved.folders.length > 1; say(`${saved.folders[0].name}에 저장했어요.`) }
    refreshSaved()
  }
  function refreshSaved() { (map?.getSource('savedpts') as GeoJSONSource | undefined)?.setData(savedData()) }

  // ---- 길 찾기 엔진(별도 스레드)
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

  // ---- 노을: 길 조각별 서쪽 지평선(Mac에서 내보낸 horizon.bin)이 있으면 해 지는 모습이 보이는 길을 판정한다
  async function loadHorizon() {
    if (!region?.horizon || horizon) return
    try {
      const buf = await (await fetch('./data/' + region.horizon)).arrayBuffer(), h = new Uint32Array(buf, 0, 4)
      if (h[0] !== 0x5a48_4e47 || h[1] !== raw?.features.length) return
      horizon = { bins: h[2], data: new Uint8Array(buf, 16) }
    } catch { /* 없으면 트인 자리만으로 노을을 판정 */ }
  }
  /** 오늘 해 지는 방위에서 지평선이 낮은 정도(0~1). 5도 아래면 해가 지는 모습이 보인다. */
  function sunsetScores(): number[] | null {
    if (!horizon || !raw) return null
    const az = sunsetAz(), step = 360 / horizon.bins, f = az / step, i0 = Math.floor(f) % horizon.bins, i1 = (i0 + 1) % horizon.bins, t = f - Math.floor(f)
    return raw.features.map((_, k) => {
      const a = horizon!.data[k * horizon!.bins + i0] / 4 - 10, b = horizon!.data[k * horizon!.bins + i1] / 4 - 10, hz = a + (b - a) * t
      return Math.max(0, Math.min(1, (5 - hz) / 5))
    })
  }
  async function updateSunset() {
    const on = !!horizon && sunsetWindow() && saved.settings.sky === 'real'
    if (on === sunsetOn || !region?.graph) return
    sunsetOn = on
    await call('boost', on ? { mids, vals: sunsetScores() } : null)
    if (tripReady) makeRoute(false)
  }

  // ---- 길 찾기
  const realStops = (): [number, number][] => trip!.map((p) => (p!.id === 'me' ? [meAt![0], meAt![1]] : [p!.lon, p!.lat]))
  async function ensureMe(): Promise<boolean> {
    if (meAt && inRegion(...meAt)) return true
    const ok = await new Promise<boolean>((res) => locate(res, false))
    if (!ok) return false
    if (!inRegion(...meAt!)) { say(`내 위치가 ${region!.name} 밖이라 출발을 직접 골라 주세요.`); return false }
    return true
  }
  async function startTrip(stops: Stop[], name = '') {
    clearSel(); nearOn = false; mapEl.classList.remove('pins-on')
    trip = stops; tripName = name; routes = null; routeErr = ''; sugs = []; tab = 'map'
    if (trip.some((p) => p?.id === 'me') && !(await ensureMe())) trip = trip.map((p) => (p?.id === 'me' ? null : p))
    await tick(); drawStops()
    if (tripReady) makeRoute()
    else { mode = 'idle'; const i = trip.findIndex((p) => !p); if (i >= 0) openSlot(i) }
  }
  function closeTrip() { trip = null; routes = null; tripName = ''; mode = nearOn ? 'near' : 'idle'; drawRoute(); drawStops() }
  function setStop(i: number, p: Place) {
    if (!trip) return
    const t = [...trip]; t[i] = p.id === 'me' ? ME : p; trip = t; tripName = ''
    drawStops(); if (tripReady) makeRoute()
  }
  function openSlot(i: number) {
    const label = i === 0 ? '출발' : i === trip!.length - 1 ? '도착' : '경유지'
    search = { target: { kind: 'slot', label }, slot: i }; loadPlaces()
  }
  function addVia() {
    if (!trip || trip.length >= MAX_STOPS) { say(`${MAX_STOPS}곳까지 이을 수 있어요.`); return }
    const t = [...trip]; t.splice(t.length - 1, 0, null); trip = t; openSlot(t.length - 2)
  }
  function removeStop(i: number) {
    if (!trip) return
    const t = trip.filter((_, k) => k !== i); if (t.length < 2) t.push(null)
    trip = t; drawStops(); if (tripReady) makeRoute(false); else { routes = null; mode = 'idle'; drawRoute() }
  }
  function reverseTrip() { if (!trip) return; trip = [...trip].reverse(); drawStops(); if (tripReady) makeRoute(false) }
  function moveStop(from: number, to: number) {
    if (!trip || from === to || to < 0 || to >= trip.length) return
    const a = [...trip]; const [x] = a.splice(from, 1); a.splice(to, 0, x); trip = a; drawStops(); if (tripReady) makeRoute(false)
  }
  function dragStart(e: PointerEvent, i: number) {
    const row = (e.currentTarget as HTMLElement).closest('li')!, list = row.parentElement!
    const rows = [...list.children] as HTMLElement[], tops = rows.map((r) => r.getBoundingClientRect())
    dragFrom = i; dragTo = i
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId); e.preventDefault()
    const move = (ev: PointerEvent) => { let t = rows.length - 1; for (let k = 0; k < tops.length; k++) if (ev.clientY < tops[k].top + tops[k].height / 2) { t = k; break } dragTo = t }
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); moveStop(dragFrom, dragTo); dragFrom = dragTo = -1 }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  }
  function drawStops() {
    if (!map) return
    stopPins.splice(0).forEach((m) => m.remove())
    trip?.forEach((p, i) => {
      if (!p || p.id === 'me') return
      const el = document.createElement('button')
      el.type = 'button'; el.className = 'gopin'; el.textContent = String(i + 1); el.setAttribute('aria-label', `${i + 1}번 ${p.name}`)
      el.addEventListener('click', (e) => { e.stopPropagation(); showPlace(p) })
      stopPins.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map!))
    })
  }
  let routeSeq = 0
  async function makeRoute(fit = true) {
    if (!trip || !tripReady || !region?.graph) return
    if (trip.some((p) => p!.id === 'me') && !meAt) { if (!(await ensureMe())) return }
    const seq = ++routeSeq
    mode = 'route'; routeBusy = true; routeErr = ''
    try {
      const st = realStops()
      if (st.some(([x, y]) => !inRegion(x, y))) { routes = null; routeErr = `${region.name} 밖에 있는 곳이 있어 이을 수 없어요.`; drawRoute(); return }
      const r = await call<RouteResult[] | { error: string }>('route', { stops: st, prefs: $state.snapshot(prefs), view: openness(saved.settings.open) })
      if (seq !== routeSeq) return
      if ('error' in r) { routes = null; routeErr = r.error === 'far' ? '걷는 길에서 300m 넘게 떨어진 곳이 있어요.' : '걸어서 이어지는 길을 찾지 못했어요.'; drawRoute(); return }
      routes = r; await tick(); drawRoute(fit)
      const inTrip = new Set(trip.map((g) => g!.id))
      const sg = await call<({ id: string; extra: number } | null)[]>('detours', { stops: st, spots: spots.filter((s) => !inTrip.has(s.id)).map((s) => ({ id: s.id, lon: s.lon, lat: s.lat })) })
      const once = new Set<string>(); sugs = sg.map((x) => (x && !once.has(x.id) ? (once.add(x.id), x) : null))   // 같은 곳은 한 번만 제안
    } catch { routeErr = '길을 계산하지 못했어요. 잠시 뒤에 다시 해 주세요.' }
    finally { if (seq === routeSeq) routeBusy = false }
  }
  const current = $derived(routes?.find((r) => r.mode === routeMode) ?? null)
  const fastest = $derived(routes?.find((r) => r.mode === 'fast') ?? null)
  function drawRoute(fit = false) {
    if (!map || !map.getSource('route')) return
    const r = trip && (mode === 'route' || mode === 'place' || mode === 'spot' || mode === 'link') ? routes?.find((x) => x.mode === routeMode) : null
    const feats = r ? r.legs.flatMap((l) => l.segs.map((sg) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: sg.coords }, properties: { kind: sg.kind, v: sg.v, walk: sg.walk ? 1 : 0 } }))) : []
    ;(map.getSource('route') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats })
    map.setPaintProperty('links', 'line-opacity', r ? 0.3 : 1)
    if (r && fit) {
      const b = new maplibregl.LngLatBounds()
      for (const f of feats) for (const c of f.geometry.coordinates) b.extend(c as [number, number])
      const sh = sheetEl?.offsetHeight ?? 300, top = (document.querySelector('.planner') as HTMLElement | null)?.offsetHeight ?? 150
      map.fitBounds(b, { padding: { top: top + 40, bottom: sh + 30, left: 40, right: 40 }, duration: 600, maxZoom: 17 })
    }
  }
  function pickMode(m: ModeId) { routeMode = m; store.set('gn.mode', m); drawRoute() }
  let openTimer = 0
  function setOpen(v: number) { saved.settings.open = v; saved.saveSettings(); clearTimeout(openTimer); openTimer = window.setTimeout(() => makeRoute(false), 120) }
  async function tidyOrder() {
    if (!trip || trip.length < 4) return
    const ord = await call<number[]>('order', { stops: realStops(), fixEnd: true })
    if (ord.every((v, i) => v === i)) { say('지금 순서가 가장 짧아요.'); return }
    trip = ord.map((i) => trip![i]); drawStops(); say('가장 짧은 순서로 바꿨어요.'); makeRoute(false)
  }
  function addDetour(i: number, id: string) {
    const s = spots.find((x) => x.id === id); if (!s || !trip) return
    if (trip.length >= MAX_STOPS) { say(`${MAX_STOPS}곳까지 이을 수 있어요.`); return }
    trip = [...trip.slice(0, i + 1), spotPlace(s), ...trip.slice(i + 1)]; drawStops()
    say(`${s.title}에 들르도록 넣었어요.`); makeRoute(false)
  }
  function saveTrip() {
    if (!trip || !current) return
    const stops = trip.filter((p) => p && p.id !== 'me') as Place[]
    if (stops.length < 2) { say('내 위치를 뺀 곳이 두 곳 이상이어야 저장할 수 있어요.'); return }
    saved.addTrip({ name: tripName || `${stops[0].name}에서 ${stops[stops.length - 1].name}까지`, stops, mode: routeMode, open: saved.settings.open, len: current.len, view: current.share.k + current.share.w + current.share.g, kind: 'route' })
    say('저장 탭에 길을 저장했어요.')
  }
  function openShare() {
    if (!trip || !current || !raw) return
    const stops = trip.map((p) => (p!.id === 'me' ? { name: '출발', lon: meAt![0], lat: meAt![1] } : { name: p!.name, lon: p!.lon, lat: p!.lat }))
    const path = current.legs.flatMap((l, i) => (trip![i]!.id === 'me' ? [] : l.segs.filter((s) => !s.walk).map((s) => s.coords)))  // 내 위치에서 나오는 구간은 그리지 않는다
    const xs = (path.length ? path : current.legs.flatMap((l) => l.segs.map((s) => s.coords))).flat(), x0 = Math.min(...xs.map((c) => c[0])) - 0.004, x1 = Math.max(...xs.map((c) => c[0])) + 0.004, y0 = Math.min(...xs.map((c) => c[1])) - 0.003, y1 = Math.max(...xs.map((c) => c[1])) + 0.003
    const context = rated().features.filter((f) => { const c = f.geometry.coordinates[0]; return c[0] > x0 && c[0] < x1 && c[1] > y0 && c[1] < y1 }).map((f) => ({ coords: f.geometry.coordinates as [number, number][], kind: f.properties.kind }))
    const named = trip.filter((p) => p && p.id !== 'me') as Place[]
    const title = tripName || (named.length >= 2 ? `${named[0].name}에서 ${named[named.length - 1].name}까지` : `${named[0]?.name ?? ''}까지`)
    shareArt = { art: { title, stops: stops.filter((_, i) => trip![i]!.id !== 'me'), path, context, minutes: mins(current.len), meters: current.len, view: current.share.k + current.share.w + current.share.g }, url: tripUrl({ mode: routeMode, open: saved.settings.open, name: tripName, stops: named }) }
  }

  // ---- 화면 설정과 칩
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
  function locate(done?: (ok: boolean) => void, fly = true) {
    if (!map) { done?.(false); return }
    if (!canMe) { say('이 기기에서는 현재 위치를 쓸 수 없어요.'); done?.(false); return }
    locating = true
    navigator.geolocation.getCurrentPosition((pos) => {
      locating = false
      const { longitude: x, latitude: y } = pos.coords
      meAt = [x, y]
      if (!me) { const el = document.createElement('div'); el.className = 'me'; me = new maplibregl.Marker({ element: el }) }
      me.setLngLat([x, y]).addTo(map!)
      if (fly) {
        if (!inRegion(x, y)) say(`지금은 ${region!.name}만 볼 수 있어요.`)
        map!.flyTo({ center: [x, y], zoom: Math.max(map!.getZoom(), 15.5), essential: true })
      }
      done?.(true)
    }, (err) => {
      locating = false
      say(err.code === err.PERMISSION_DENIED ? '위치 권한을 허용하면 현재 위치를 쓸 수 있어요.' : '현재 위치를 찾지 못했어요. 잠시 뒤에 다시 해 주세요.')
      done?.(false)
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 })
  }

  // ---- 검색에서 고른 것
  function onSearchPick(p: Place, how: string) {
    const s = search; if (!s) return
    if (s.target.kind === 'slot' && s.slot !== undefined) {
      search = null
      if (p.id === 'me') { ensureMe().then((ok) => { if (ok) setStop(s.slot!, ME) }); return }
      setStop(s.slot, p); return
    }
    if (s.target.kind === 'collect') { saved.star(p, s.target.folder); refreshSaved(); say(`${saved.folders.find((f) => f.id === (s.target as any).folder)?.name ?? ''}에 넣었어요.`); return }
    search = null; tab = 'map'; showPlace(p)
    void how
  }
  function onShortcut(which: 'home' | 'work') {
    const p = saved[which]; if (!p) return
    search = null; startTrip([canMe ? ME : null, p])
  }

  // ---- 지도 탭 바깥에서 여는 것
  function openPlaceFromTab(p: Place) { tab = 'map'; tick().then(() => { if (p.sub === '트인 자리') { const s = spots.find((x) => samePlace(spotPlace(x), p) || x.title === p.name); if (s) { showSpot(s); return } } showPlace(p) }) }
  function openTrip(stops: Place[], m: ModeId, open: number, name: string) {
    routeMode = m; store.set('gn.mode', m); saved.settings.open = open; saved.saveSettings()
    startTrip(stops.slice(0, MAX_STOPS), name)
  }

  // ---- 문장
  const lead = $derived.by(() => {
    if (!picked) return null
    const calm = picked.c < 70 ? '큰길 옆이라 차가 많이 다녀요.' : picked.c >= 110 ? '공원이나 보행로라 걷기 편해요.' : ''
    return { kind: picked.kind === 'n' ? null : picked.kind, title: KIND_LINE[picked.kind] + '이에요', calm }
  })
  const sun = $derived.by(() => { clock; return sunTimes() })
  const duskTime = $derived.by(() => { clock; return sunsetWindow() })
  const spotLines = $derived.by(() => {
    if (!spot) return [] as string[]
    const s = spot, out: string[] = []
    if (s.dir && !s.title.includes(s.dir + '쪽')) out.push(`${s.dir}쪽으로 멀리 트여 있어요.`)
    if (s.water >= 0.5) out.push('강이 보여요.')
    else if (s.nat >= 15) out.push(`시야의 ${s.nat}%가 나무와 풀이에요.`)
    if (s.elev >= 45) out.push(`해발 ${s.elev}m 언덕이라 내려다보는 뷰예요.`)
    if (s.calm) out.push('큰길에서 떨어져 있어 조용해요.')
    if (s.west < 6) {
      if (spotEta?.id === s.id && duskTime) {
        const gap = Math.round((sun.set.getTime() - Date.now()) / 6e4) - spotEta.min
        out.push(gap > 0 ? `지금 출발하면 해 지기 ${gap}분 전에 도착해요.` : gap === 0 ? '지금 출발하면 해 질 때 도착해요.' : `지금 출발하면 해 진 뒤 ${-gap}분에 도착해요.`)
      } else out.push(`서쪽이 트여 노을이 보여요. 오늘은 ${hhmm(sun.set)}에 해가 져요.`)
    }
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
  const reason = $derived.by(() => {
    if (!current || current.mode === 'fast') return ''
    if (sunsetOn && current.boost > 0.08) return '해 질 무렵이라 해 지는 쪽이 트인 길로 골랐어요.'
    return ''
  })
  const openLabel = $derived(saved.settings.open < 20 ? '조금' : saved.settings.open < 45 ? '보통' : saved.settings.open < 75 ? '많이' : '산책처럼')
  const showTabs = $derived(!search && !(tab === 'map' && trip))
  const stopLabel = (i: number) => (i === 0 ? '출발' : i === (trip?.length ?? 0) - 1 ? '도착' : '경유지')

  $effect(() => {
    const r = document.documentElement.style, t = theme
    r.setProperty('--bg', t.bg); r.setProperty('--surf', t.surf); r.setProperty('--line', t.line); r.setProperty('--ink', t.ink)
    r.setProperty('--sub', t.sub); r.setProperty('--acc', t.acc); r.setProperty('--on-acc', t.onAcc)
    r.setProperty('--dot-k', t.dot.k); r.setProperty('--dot-w', t.dot.w); r.setProperty('--dot-g', t.dot.g)
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.bg)
    untrack(recolor)
  })
  let lastTheme = ''
  $effect(() => { const n = themeName; if (lastTheme && lastTheme !== n) untrack(restyle); lastTheme = n })
  $effect(() => { mode; if (ready) untrack(() => drawRoute()) })
  $effect(() => { document.documentElement.style.setProperty('--tab-h', showTabs ? 'calc(58px + env(safe-area-inset-bottom))' : '0px') })
  $effect(() => {
    if (!sheetEl) { document.documentElement.style.setProperty('--sheet-h', '0px'); return }
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--sheet-h', (sheetEl!.classList.contains('hidden') ? 0 : sheetEl!.offsetHeight) + 'px'))
    ro.observe(sheetEl); return () => ro.disconnect()
  })
  $effect(() => { saved.folders; if (ready) untrack(refreshSaved) })
  $effect(() => { if (tab === 'map' && map) untrack(() => map!.resize()) })

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
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)'), onMq = () => (sysNight = systemNight())
    mq?.addEventListener?.('change', onMq)
    const timer = window.setInterval(() => { skyNow = skyAt(); clock = Date.now(); updateSunset() }, 60_000)
    starTimer = window.setInterval(() => { if (sky.night > 0.02) twinkle() }, 120)
    ;(async () => {
      try {
        const man = await (await fetch('./data/manifest.json')).json()
        region = man.regions[0] as Region
        const [style, links, sp] = await Promise.all([basemap(theme), fetch('./data/' + region.links).then((r) => r.json()), fetch('./data/' + region.spots).then((r) => r.json()).catch(() => [])])
        if (dead) return
        raw = links as Fc; spots = sp as Spot[]
        mids = raw.features.map((f) => f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)] as [number, number])
        map = new maplibregl.Map({ container: mapEl, style, center: region.center, zoom: region.zoom, minZoom: 11, maxZoom: 19, attributionControl: { compact: true, customAttribution: '서울시, 국토지리정보원, 소상공인시장진흥공단' }, dragRotate: false, pitchWithRotate: false, localIdeographFontFamily: "'Noto Sans KR', sans-serif" })
        map.touchZoomRotate.disableRotation()
        if (import.meta.env.DEV || location.hostname === 'localhost') (window as any).__tg = { map: () => map, sky: (v: { dusk: number; night: number }) => (skyNow = v) }
        map.on('load', () => {
          addOverlay(); addPins(); loadPlaces(); loadHorizon().then(updateSunset)
          const sh = readTripUrl()
          if (sh) { history.replaceState(null, '', location.pathname); openTrip(sh.stops, sh.mode, sh.open, sh.name); say('공유받은 길을 열었어요.') }
        })
        map.on('moveend', nearLater)
        map.on('click', (e) => {
          if (Date.now() < quietClick) return
          if (mapPick) { pickAt(e.lngLat); return }
          const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]]
          const sp = map!.queryRenderedFeatures(box, { layers: ['saved-dot', 'saved-label'].filter((l) => map!.getLayer(l)) })[0]
          if (sp) { const k = sp.properties.k as string; for (const f of saved.folders) { const p = f.items.find((x) => `${x.lon},${x.lat},${x.name}` === k); if (p) { showPlace(p); return } } }
          const po = map!.queryRenderedFeatures(box, { layers: ['poi-label-a', 'poi-label-b', 'poi-dot'].filter((l) => map!.getLayer(l)) })[0]
          if (po && db) { showPlace(db.list[po.properties.i as number]); return }
          const hit = map!.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['links-hit'] })
          if (hit[0] && mode !== 'route') showLink(hit[0].geometry, hit[0].properties as Shown)
          else closeSheet()
        })
        bindLongPress()
      } catch (e) { failed = /webgl/i.test(String(e)) ? 'gl' : 'load' }
    })()
    return () => { dead = true; clearInterval(timer); clearInterval(starTimer); mq?.removeEventListener?.('change', onMq); map?.remove() }
  })
</script>

{#snippet xbtn(label: string, back = false, fn = closeSheet)}
  <button type="button" class="icon ghost" onclick={fn} aria-label={label}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={back ? 'M15 5l-7 7 7 7' : 'M6 6l12 12M18 6L6 18'}/></svg>
  </button>
{/snippet}
{#snippet chevron()}
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
{/snippet}
{#snippet starIcon(on: boolean)}
  <svg width="20" height="20" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>
{/snippet}
{#snippet placeActions(p: Place)}
  {@const st = saved.isStarred(p)}
  <div class="acts">
    <button type="button" class="act" onclick={() => (trip ? setStop(0, p) : startTrip([p, null]))}>출발</button>
    {#if trip && tripReady}<button type="button" class="act" onclick={() => { const t = [...trip!]; if (t.length >= MAX_STOPS) { say(`${MAX_STOPS}곳까지 이을 수 있어요.`); return } t.splice(t.length - 1, 0, p); trip = t; drawStops(); makeRoute(false) }}>경유</button>{/if}
    <button type="button" class="act main" onclick={() => (trip ? setStop(trip.length - 1, p) : startTrip([canMe ? ME : null, p]))}>도착</button>
    <button type="button" class="act star" class:on={st} aria-pressed={st} onclick={() => toggleStar(p)} aria-label={st ? '저장 지우기' : '저장하기'}>{@render starIcon(st)}</button>
  </div>
  {#if st && (folderPick || saved.folders.length > 1)}
    <div class="chips" role="group" aria-label="저장할 폴더">
      {#each saved.folders as f (f.id)}
        {@const inF = f.items.some((x) => samePlace(x, p))}
        <button type="button" class="chip sm" class:on={inF} aria-pressed={inF} onclick={() => { saved.star(p, f.id, !inF); if (!saved.isStarred(p)) folderPick = false; refreshSaved() }}>{f.name}</button>
      {/each}
    </div>
  {/if}
{/snippet}

<main class="shell">
  <div class="map" class:off={tab !== 'map'} bind:this={mapEl} aria-label="뷰 점수로 길을 칠한 지도. 길게 누르면 그 자리를 고를 수 있어요."></div>
  {#if !ready && !failed}<div class="veil" aria-hidden="true"></div>{/if}

  {#if tab === 'map'}
    {#if trip}
      <header class="planner" aria-label="길 찾기">
        <div class="prow">
          {@render xbtn('길 찾기 닫기', true, closeTrip)}
          <ol class="stops">
            {#each trip as p, i (i + ':' + (p?.id ?? 'empty'))}
              <li class:lift={dragFrom === i} class:gap-above={dragFrom >= 0 && dragTo === i && dragFrom > i} class:gap-below={dragFrom >= 0 && dragTo === i && dragFrom < i}>
                <span class="sdot" class:me={p?.id === 'me'} class:end={i === trip.length - 1 && i > 0} aria-hidden="true">{i > 0 && i < trip.length - 1 ? i : ''}</span>
                <button type="button" class="slot" class:empty={!p} onclick={() => openSlot(i)} aria-label={`${stopLabel(i)} ${p ? p.name : '고르기'}`}>{p ? p.name : `${stopLabel(i)} 고르기`}</button>
                {#if trip.length > 2}
                  <button type="button" class="icon sm handle" aria-label={`${p?.name ?? stopLabel(i)} 순서 바꾸기. 위아래 화살표로 옮겨요.`} onpointerdown={(e) => dragStart(e, i)}
                    onkeydown={(e) => { if (e.key === 'ArrowUp') { e.preventDefault(); moveStop(i, i - 1) } else if (e.key === 'ArrowDown') { e.preventDefault(); moveStop(i, i + 1) } }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>
                  </button>
                  <button type="button" class="icon sm" onclick={() => removeStop(i)} aria-label={`${p?.name ?? stopLabel(i)} 빼기`}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>
                  </button>
                {/if}
              </li>
            {/each}
          </ol>
          <div class="pside">
            <button type="button" class="icon sm" onclick={reverseTrip} aria-label="순서 뒤집기">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4v15M8 4L4.5 7.5M8 4l3.5 3.5M16 20V5M16 20l-3.5-3.5M16 20l3.5-3.5"/></svg>
            </button>
            <button type="button" class="icon sm" onclick={addVia} aria-label="경유지 넣기" disabled={trip.length >= MAX_STOPS}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
            </button>
          </div>
        </div>
      </header>
    {:else}
      <header class="top">
        <div class="bar">
          <span class="brand">트이길</span>
          <button type="button" class="find" onclick={() => { search = { target: { kind: 'browse' } }; loadPlaces() }} aria-haspopup="dialog">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
            <span>장소, 주소 검색</span>
          </button>
        </div>
        <div class="chips" role="group" aria-label="보고 싶은 것 고르기">
          {#each CHIPS as c (c.key)}
            <button type="button" class="chip float" class:on={prefs[c.key]} aria-pressed={prefs[c.key]} onclick={() => toggle(c.key)}>
              {#if c.kind}<span class="dot" style:background={prefs[c.key] ? theme.dot[c.kind] : theme.none}></span>{/if}
              {c.label}
            </button>
          {/each}
        </div>
      </header>
    {/if}

    {#if mapPick}
      <div class="pickbar" role="status">
        <span>{mapPick.kind === 'set' ? (mapPick.which === 'home' ? '집' : '회사') : stopLabel(mapPick.slot)} 위치를 지도에서 눌러 주세요</span>
        <button type="button" class="mini ghost" onclick={() => (mapPick = null)}>그만두기</button>
      </div>
    {/if}
    {#if ready && mode !== 'route' && !trip}
      <button type="button" class="pill nearby" onclick={toggleNear} aria-pressed={nearOn}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l5-6 4 4 3-3 6 5"/><circle cx="17" cy="6.5" r="2.5"/></svg>
        주변 트인 길
      </button>
    {/if}
    <button type="button" class="icon locate" onclick={() => locate()} aria-label="현재 위치로 가기" aria-busy={locating}>
      <svg class:spin={locating} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/></svg>
    </button>

    <section class="sheet" class:hidden={ready && !failed && mode === 'idle' && saved.seen} bind:this={sheetEl} aria-live="polite">
      <div class="grip" aria-hidden="true"></div>
      {#if failed}
        <h1>{failed === 'gl' ? '이 브라우저에서는 지도를 그릴 수 없어요' : '지도를 불러오지 못했어요'}</h1>
        <p>{failed === 'gl' ? '크롬이나 사파리 최신 버전에서 열어 주세요.' : '인터넷 연결을 확인하고 화면을 새로 고쳐 주세요.'}</p>
      {:else if !ready}
        <div class="row start"><span class="loader" aria-hidden="true"></span><h1>지도를 그리고 있어요</h1></div>
      {:else if mode === 'place' && place}
        <div class="row">
          <span class="badge">{kindOfPlace(place)}</span>
          {@render xbtn(trip && tripReady ? '길 찾기로 돌아가기' : nearOn ? '목록으로 돌아가기' : '장소 정보 닫기', !!(trip && tripReady) || nearOn)}
        </div>
        <h1 class="big">{place.name}</h1>
        {#if (place.sub && place.sub !== '트인 자리') || place.floor !== null || place.addr}
          <p>{[place.sub === '트인 자리' ? '' : place.sub, place.addr, floorText(place.floor)].filter(Boolean).join(', ')}</p>
        {/if}
        <ul class="lines">{#each frontLines as l}<li>{l}</li>{/each}</ul>
        {@render placeActions(place)}
      {:else if mode === 'route' && trip}
        {#if routeErr}
          <p>{routeErr}</p>
        {:else if !routes}
          <div class="row start"><span class="loader" aria-hidden="true"></span><p>트인 길을 찾고 있어요.</p></div>
        {:else}
          <div class="tabs" role="tablist" aria-label="길 고르기">
            {#each MODES as m (m.id)}
              {@const r = routes.find((x) => x.mode === m.id)!}
              <button type="button" role="tab" class="tab" aria-selected={routeMode === m.id} onclick={() => pickMode(m.id)}>
                <span>{m.label}</span><strong>{timeText(r.len)}</strong><span class="km">{distText(r.len)}</span>
              </button>
            {/each}
          </div>
          {#if routeMode === 'view'}
            <div class="openness">
              <label for="open">트인 정도 <strong>{openLabel}</strong></label>
              <input id="open" class="range" type="range" min="0" max="100" step="5" value={saved.settings.open} oninput={(e) => setOpen(+(e.currentTarget as HTMLInputElement).value)} aria-valuetext={openLabel} />
            </div>
          {/if}
          {#if current && fastest}
            {@const extra = mins(current.len) - mins(fastest.len)}
            {@const good = Math.round((current.share.k + current.share.w + current.share.g) * 100)}
            {@const top = current.share.k >= current.share.w && current.share.k >= current.share.g ? '하늘이 트인' : current.share.w >= current.share.g ? '물이 보이는' : '녹지가 보이는'}
            <ul class="lines">
              {#if reason}<li>{reason}</li>{/if}
              <li>{good > 0 ? `트인 구간이 전체의 ${good}%예요.` : '이 길에는 트인 구간이 거의 없어요.'}</li>
              {#if good > 0}<li>그중 {top} 길이 가장 길어요.</li>{/if}
              {#if current.mode !== 'fast'}<li>{extra > 0 ? `빠른 길보다 ${extra}분 더 걸어요.` : '빠른 길과 시간이 같아요.'}</li>{/if}
            </ul>
            <ol class="legs">
              {#each trip as g, i}
                <li><span class="num sm" class:hollow={g?.id === 'me'} aria-hidden="true">{i + 1}</span><span class="nm">{g?.name}</span></li>
                {#if i < trip.length - 1 && current.legs[i]}
                  <li class="leg">걸어서 {timeText(current.legs[i].len)}, {distText(current.legs[i].len)}</li>
                  {#if sugs[i]}
                    {@const sp = spots.find((s) => s.id === sugs[i]!.id)}
                    {#if sp}
                      <li class="sug"><span>{mins(sugs[i]!.extra)}분 더 걸으면 {sp.title}에 들를 수 있어요.</span><button type="button" class="mini" onclick={() => addDetour(i, sp.id)}>들르기</button></li>
                    {/if}
                  {/if}
                {/if}
              {/each}
            </ol>
            <div class="two">
              {#if trip.length >= 4}<button type="button" class="wide ghostbtn" onclick={tidyOrder} disabled={routeBusy}>순서 정리하기</button>{/if}
              <button type="button" class="wide ghostbtn" onclick={saveTrip}>저장하기</button>
              <button type="button" class="wide primary" onclick={openShare}>공유하기</button>
            </div>
          {/if}
        {/if}
      {:else if mode === 'spot' && spot}
        {@const sp = spotPlace(spot)}
        <div class="row">
          <span class="badge">이 동네 상위 {Math.max(1, Math.ceil(spot.top))}%</span>
          {@render xbtn(nearOn ? '목록으로 돌아가기' : '트인 자리 정보 닫기', nearOn)}
        </div>
        <h1 class="big">{spot.title}</h1>
        {#if spotLines.length}<ul class="lines">{#each spotLines as l}<li>{l}</li>{/each}</ul>{/if}
        <dl class="facts three">
          <div><dt>하늘</dt><dd>시야의 {spot.sky}%</dd></div>
          <div><dt>트인 방향</dt><dd>{spot.pano}도</dd></div>
          <div><dt>해발</dt><dd>{spot.elev}m</dd></div>
        </dl>
        {@render placeActions(sp)}
      {:else if mode === 'near'}
        <div class="row">
          <h1>주변 트인 길</h1>
          {@render xbtn('목록 닫기', false, toggleNear)}
        </div>
        {#if near.length}
          <ul class="list">
            {#each near as n (n.type === 'spot' ? n.spot.id : 'l' + n.f.id)}
              {@const kind = n.type === 'spot' ? n.spot.kind : (n.f.properties.kind as Kind)}
              <li>
                <button type="button" class="item" onclick={() => openNear(n)}>
                  <span class="mark" class:spotmark={n.type === 'spot'} style:background={theme.dot[kind]} aria-hidden="true"></span>
                  <span class="txt">
                    <strong>{n.type === 'spot' ? n.spot.title : KIND_LINE[kind]}</strong>
                    <span>{n.type === 'spot' ? '트인 자리' : '길'}, {distText(n.d)}, {walkText(n.d * 1.25)}</span>
                  </span>
                  {#if n.type === 'spot' && n.spot.west < 6 && duskTime}<span class="tag soft">노을</span>{/if}
                  {@render chevron()}
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p>이 화면에는 트인 길이 없어요.</p>
        {/if}
      {:else if mode === 'link' && picked && lead}
        <div class="row">
          <h1>{lead.title}</h1>
          {@render xbtn(trip ? '길 찾기로 돌아가기' : nearOn ? '목록으로 돌아가기' : '길 정보 닫기', !!trip || nearOn)}
        </div>
        <dl class="facts">
          <div><dt>하늘</dt><dd>시야의 {picked.ps}%</dd></div>
          <div><dt>물</dt><dd>{picked.pw >= 0.3 ? '보여요' : '안 보여요'}</dd></div>
          <div><dt>트인 방향</dt><dd>{picked.pa}도</dd></div>
          <div><dt>해발</dt><dd>{picked.z}m</dd></div>
        </dl>
        {#if lead.calm}<p>{lead.calm}</p>{/if}
      {:else if !saved.seen}
        <h1>색이 진한 길일수록 트여 있어요</h1>
        <button type="button" class="wide ghostbtn" onclick={() => saved.setSeen(true)}>알겠어요</button>
      {/if}
    </section>
  {:else if tab === 'course'}
    <CourseTab {db} spots={spots.map(spotPlace)} spotInfo={spots} {call} {meAt} {frontOf} {walk} {prefs} {say} open={saved.settings.open} {inRegion}
      ensureDb={loadPlaces} {ensureMe} {origin} onOpen={openTrip} onCollect={(folder) => { search = { target: { kind: 'collect', folder } }; loadPlaces() }} onPlace={openPlaceFromTab} />
  {:else if tab === 'saved'}
    <SavedTab onPlace={openPlaceFromTab} onTrip={(t) => openTrip(t.stops, t.mode, t.open, t.name)} {walk} {say} />
  {:else}
    <SettingsTab {say} />
  {/if}

  {#if showTabs}
    <nav class="tabbar" aria-label="화면 바꾸기">
      {#each [{ id: 'map', label: '지도', d: 'M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20' }, { id: 'course', label: '코스', d: 'M6 19a2.5 2.5 0 1 0 0-.01M18 7a2.5 2.5 0 1 0 0-.01M8.3 18H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.6' }, { id: 'saved', label: '저장', d: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z' }, { id: 'settings', label: '설정', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2.1a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.4L4.6 10.3l2-3.4 1.9.7a7 7 0 0 1 2-1.2L10.8 4h4l.3 2.1a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.4z' }] as t (t.id)}
        <button type="button" class="tb" aria-current={tab === t.id ? 'page' : undefined} onclick={() => { tab = t.id as Tab; if (t.id !== 'map') clearSel() }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill={tab === t.id && t.id === 'saved' ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={t.d}/></svg>
          <span>{t.label}</span>
        </button>
      {/each}
    </nav>
  {/if}

  {#if search}
    <SearchPanel {db} target={search?.target ?? { kind: 'browse' }} regionName={region?.name ?? ''} {origin} {canMe} onPick={onSearchPick} {onShortcut} {say}
      onMapPick={(t) => { mapPick = t.kind === 'set' ? t : { kind: 'slot', slot: search?.slot ?? 0 }; search = null; tab = 'map'; clearSel() }} onClose={() => (search = null)} />
  {/if}
  {#if shareArt}
    <ShareSheet art={shareArt.art} url={shareArt.url} {sky} onClose={() => (shareArt = null)} {say} />
  {/if}
  {#if toast}<div class="toast" class:high={!!search || tab !== 'map'} role="status">{toast}</div>{/if}
</main>

<style>
  .shell { position: fixed; inset: 0; overflow: hidden; background: var(--bg); color: var(--ink) }
  .map { position: absolute; inset: 0; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }
  .map.off :global(.maplibregl-control-container) { display: none }
  .veil { position: absolute; inset: 0; background: linear-gradient(100deg, var(--surf) 30%, var(--bg) 50%, var(--surf) 70%); background-size: 300% 100%; animation: shimmer 1.6s linear infinite }
  @keyframes shimmer { from { background-position: 100% 0 } to { background-position: -50% 0 } }
  .top { position: absolute; left: 0; right: 0; top: 0; padding: calc(12px + env(safe-area-inset-top)) 16px 0; display: flex; flex-direction: column; gap: 10px; pointer-events: none }
  .top > * { pointer-events: auto }
  .bar { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 6px 0 16px; border-radius: 16px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1) }
  .brand { font-family: 'Gowun Dodum', 'Noto Sans KR', sans-serif; font-size: 20px; letter-spacing: -0.01em; flex: none }
  .find { flex: 1; min-width: 0; height: 40px; padding: 0 12px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 12px; background: var(--surf); color: var(--sub); font-size: 15px; text-align: left }
  .find span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .chip.float { box-shadow: 0 1px 6px rgba(0, 0, 0, 0.08) }
  .planner { position: absolute; left: 0; right: 0; top: 0; z-index: 3; padding: calc(8px + env(safe-area-inset-top)) 8px 10px; background: var(--bg); border-bottom: 1px solid var(--line); box-shadow: 0 2px 14px rgba(0, 0, 0, 0.1) }
  .prow { display: flex; align-items: flex-start; gap: 2px; max-width: 560px; margin: 0 auto }
  .prow > :global(.icon.ghost) { margin: 2px 0 0 }
  .stops { flex: 1; min-width: 0; margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px }
  .stops li { display: flex; align-items: center; gap: 8px; border-radius: 12px }
  .stops li.lift { opacity: 0.6 }
  .stops li.gap-above { box-shadow: 0 -3px 0 var(--acc) }
  .stops li.gap-below { box-shadow: 0 3px 0 var(--acc) }
  .sdot { width: 22px; height: 22px; border-radius: 11px; flex: none; display: grid; place-items: center; font-size: 11px; font-weight: 700; background: var(--surf); border: 2px solid var(--sub); color: var(--ink) }
  .sdot.me { background: var(--acc); border-color: var(--bg); box-shadow: 0 0 0 2px var(--acc) }
  .sdot.end { background: var(--ink); border-color: var(--ink) }
  .slot { flex: 1; min-width: 0; height: 44px; padding: 0 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--surf); text-align: left; font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .slot.empty { color: var(--sub); font-weight: 400 }
  .icon.sm { width: 40px; height: 44px; color: var(--sub) }
  .icon.sm:disabled { opacity: 0.4 }
  .handle { touch-action: none; cursor: grab }
  .pside { display: flex; flex-direction: column; justify-content: space-between; align-self: stretch }
  .locate { position: absolute; right: 16px; bottom: calc(var(--sheet-h, 0px) + var(--tab-h, 0px) + 16px); width: 48px; height: 48px; border-radius: 24px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14) }
  .pill { height: 48px; padding: 0 18px 0 14px; display: flex; align-items: center; gap: 8px; border-radius: 24px; border: 1px solid var(--line); background: var(--bg); font-size: 15px; font-weight: 700; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14) }
  .nearby { position: absolute; left: 16px; bottom: calc(var(--sheet-h, 0px) + var(--tab-h, 0px) + 16px) }
  .nearby[aria-pressed='true'] { background: var(--ink); color: var(--bg); border-color: var(--ink) }
  .sheet { position: absolute; left: 0; right: 0; bottom: var(--tab-h, 0px); max-width: 520px; max-height: 52vh; overflow-y: auto; margin: 0 auto; padding: 10px 20px 20px; display: flex; flex-direction: column; gap: 10px; background: var(--bg); border-radius: 24px 24px 0 0; box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.14) }
  .sheet.hidden { display: none }
  .grip { width: 40px; height: 4px; border-radius: 2px; background: var(--line); align-self: center; flex: none }
  .acts { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 8px }
  .acts:has(.act:nth-child(5)) { grid-template-columns: 1fr 1fr 1fr 1fr auto }
  .act { height: 52px; border-radius: 16px; border: 1.5px solid var(--line); background: var(--surf); font-size: 16px; font-weight: 700 }
  .act.main { border: 0; background: var(--acc); color: var(--on-acc) }
  .act.star { width: 52px; display: grid; place-items: center; color: var(--sub) }
  .act.star.on { color: var(--acc); border-color: var(--acc) }
  .mark { width: 14px; height: 6px; border-radius: 3px; flex: none }
  .mark.spotmark { width: 14px; height: 14px; border-radius: 7px; box-shadow: 0 0 0 3px var(--bg), 0 0 0 4.5px var(--ink) }
  .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 4px; border-radius: 16px; background: var(--surf); border: 1px solid var(--line) }
  .tab { min-height: 64px; padding: 8px 4px; border: 0; border-radius: 12px; background: transparent; color: var(--sub); display: flex; flex-direction: column; align-items: center; gap: 1px; font-size: 13px }
  .tab strong { font-size: 17px; color: var(--ink) }
  .tab .km { font-size: 12px }
  .tab[aria-selected='true'] { background: var(--bg); box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12); color: var(--ink); font-weight: 700 }
  .openness { display: flex; flex-direction: column; gap: 0; padding: 2px 4px 0 }
  .openness label { font-size: 14px; color: var(--sub) }
  .openness strong { color: var(--ink); margin-left: 4px }
  .legs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px }
  .legs li { display: flex; align-items: center; gap: 10px; font-size: 15px }
  .legs .nm { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .legs .leg { padding-left: 11px; margin-left: 11px; border-left: 2px dashed var(--line); color: var(--sub); font-size: 13px; min-height: 26px }
  .legs .sug { margin-left: 11px; padding: 10px 12px; border-radius: 12px; background: var(--surf); border: 1px solid var(--line); justify-content: space-between; font-size: 14px }
  .pickbar { position: absolute; left: 16px; right: 16px; top: calc(12px + env(safe-area-inset-top)); z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 8px 8px 16px; border-radius: 16px; background: var(--ink); color: var(--bg); font-size: 15px; font-weight: 500; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25) }
  .tabbar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; height: calc(58px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); display: grid; grid-template-columns: repeat(4, 1fr); background: var(--bg); border-top: 1px solid var(--line) }
  .tb { border: 0; background: transparent; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: var(--sub); font-size: 11.5px; font-weight: 500 }
  .tb[aria-current='page'] { color: var(--ink); font-weight: 700 }
  .toast { position: absolute; z-index: 9; left: 50%; bottom: calc(var(--sheet-h, 0px) + var(--tab-h, 0px) + 76px); transform: translateX(-50%); max-width: calc(100% - 32px); padding: 12px 16px; border-radius: 14px; background: var(--ink); color: var(--bg); font-size: 14px; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25) }
  .toast.high { bottom: calc(var(--tab-h, 0px) + 24px) }
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
