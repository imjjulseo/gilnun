<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import maplibregl from 'maplibre-gl'
  import type { GeoJSONSource, Map as MlMap, ExpressionSpecification } from 'maplibre-gl'
  import { basemap, withDusk, type ThemeName, type Kind } from './lib/theme'
  import { DEFAULT_PREFS, FLOOR, rate, type LinkProps, type Prefs } from './lib/score'
  import { duskMix, sunTimes, hhmm } from './lib/sun'

  interface Region { id: string; name: string; bbox: [number, number, number, number]; center: [number, number]; zoom: number; links: string; spots: string }
  interface Spot { id: string; rank: number; lat: number; lon: number; dong: string; title: string; kind: Kind; sky: number; water: number; nat: number; pano: number; dir: string | null; west: number; elev: number; top: number; prom: number; calm: boolean }
  type Shown = LinkProps & { kind: Kind | 'n'; v: number }
  type Fc = GeoJSON.FeatureCollection<GeoJSON.LineString, LinkProps>
  type Near = { type: 'spot'; spot: Spot; d: number } | { type: 'link'; f: GeoJSON.Feature<GeoJSON.LineString, Shown>; d: number }

  const store = {
    get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
    set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 저장 못 해도 동작 */ } },
  }
  const systemNight = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

  let themeName = $state<ThemeName>(store.get<ThemeName | null>('gn.theme', null) ?? (systemNight() ? 'night' : 'light'))
  let prefs = $state<Prefs>({ ...DEFAULT_PREFS, ...store.get<Partial<Prefs>>('gn.prefs', {}) })
  let dusk = $state(duskMix())
  let region = $state<Region | null>(null)
  let spots = $state<Spot[]>([])
  let mode = $state<'idle' | 'link' | 'spot' | 'near'>('idle')
  let picked = $state<Shown | null>(null)
  let spot = $state<Spot | null>(null)
  let near = $state<Near[]>([])
  let nearFrom = $state<'me' | 'center'>('center')
  let ready = $state(false)
  let toast = $state('')
  let locating = $state(false)
  let failed = $state<'' | 'load' | 'gl'>('')
  let sheetEl = $state<HTMLElement | null>(null)
  const theme = $derived(withDusk(themeName, dusk))

  let mapEl: HTMLDivElement
  let map: MlMap | null = null
  let raw: Fc | null = null
  let me: maplibregl.Marker | null = null
  let meAt: [number, number] | null = null
  const pins = new Map<string, HTMLElement>()
  let toastTimer = 0

  const CHIPS: { key: keyof Prefs; label: string; kind?: Kind }[] = [
    { key: 'k', label: '하늘', kind: 'k' }, { key: 'w', label: '물', kind: 'w' }, { key: 'g', label: '녹지', kind: 'g' }, { key: 'calm', label: '한적함' },
  ]
  const KIND_W: Record<Kind | 'n', number> = { k: 1, w: 0.95, g: 0.85, n: 0 }     // 추천 순서는 하늘을 먼저
  const KIND_LINE: Record<Kind | 'n', string> = { k: '하늘이 넓게 보이는 길', w: '물이 보이는 길', g: '녹지가 보이는 길', n: '뷰가 약한 길' }

  function say(msg: string) { toast = msg; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (toast = ''), 3200) }
  const meters = (a: [number, number], b: [number, number]) => {
    const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)
  }
  const distText = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)
  const walkText = (m: number) => `걸어서 ${Math.max(1, Math.round(m / 67))}분`

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
  }
  function clearPick() { picked = null; (map?.getSource('pick') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] }) }
  function selectPin(id: string | null) { for (const [k, el] of pins) el.classList.toggle('sel', k === id) }
  function repaint() {
    if (!map || !map.getSource('links')) return
    ;(map.getSource('links') as GeoJSONSource).setData(rated())
    if (mode === 'link') { clearPick(); mode = 'idle' }
  }
  function showLink(geometry: GeoJSON.Geometry, props: Shown) {
    selectPin(null); spot = null
    picked = props; mode = 'link'
    ;(map!.getSource('pick') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: props }] })
  }
  function showSpot(s: Spot, fly = true) {
    clearPick(); spot = s; mode = 'spot'; selectPin(s.id)
    if (fly && map) map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16), duration: 500 })
  }
  function closeSheet() { clearPick(); spot = null; selectPin(null); mode = 'idle' }

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

  /** 지금 보이는 화면 안에서 뷰 좋은 스팟과 길을 고른다. */
  function findNear() {
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
    clearPick(); spot = null; selectPin(null); mode = 'near'
  }
  function openNear(n: Near) {
    if (n.type === 'spot') { showSpot(n.spot); return }
    const co = n.f.geometry.coordinates, m = co[Math.floor(co.length / 2)] as [number, number]
    showLink(n.f.geometry, n.f.properties)
    map!.easeTo({ center: m, zoom: Math.max(map!.getZoom(), 16.5), duration: 500 })
  }

  async function restyle() {
    if (!map) return
    map.setStyle(await basemap(theme))
    map.once('styledata', () => { addOverlay() })
  }
  function toggle(key: keyof Prefs) {
    const next = { ...prefs, [key]: !prefs[key] }
    if (!next.k && !next.w && !next.g) { say('하늘, 물, 녹지 중 하나는 켜 두어야 해요.'); return }
    prefs = next; store.set('gn.prefs', next); repaint()
    if (mode === 'near') findNear()
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

  $effect(() => {
    const r = document.documentElement.style, t = theme
    r.setProperty('--bg', t.bg); r.setProperty('--surf', t.surf); r.setProperty('--line', t.line); r.setProperty('--ink', t.ink)
    r.setProperty('--sub', t.sub); r.setProperty('--acc', t.acc); r.setProperty('--on-acc', t.onAcc)
    r.setProperty('--dot-k', t.dot.k); r.setProperty('--dot-w', t.dot.w); r.setProperty('--dot-g', t.dot.g)
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.bg)
    untrack(recolor)
  })
  $effect(() => {
    if (!sheetEl) return
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--sheet-h', sheetEl!.offsetHeight + 'px'))
    ro.observe(sheetEl); return () => ro.disconnect()
  })

  onMount(() => {
    let dead = false
    const tick = window.setInterval(() => (dusk = duskMix()), 60_000)
    ;(async () => {
      try {
        const man = await (await fetch('./data/manifest.json')).json()
        region = man.regions[0] as Region
        const [style, links, sp] = await Promise.all([basemap(theme), fetch('./data/' + region.links).then((r) => r.json()), fetch('./data/' + region.spots).then((r) => r.json()).catch(() => [])])
        if (dead) return
        raw = links as Fc; spots = sp as Spot[]
        map = new maplibregl.Map({ container: mapEl, style, center: region.center, zoom: region.zoom, minZoom: 11, maxZoom: 19, attributionControl: { compact: true, customAttribution: '서울시, 국토지리정보원' }, dragRotate: false, pitchWithRotate: false })
        map.touchZoomRotate.disableRotation()
        map.on('load', () => { addOverlay(); addPins() })
        map.on('click', (e) => {
          const hit = map!.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['links-hit'] })
          if (hit[0]) showLink(hit[0].geometry, hit[0].properties as Shown)
          else closeSheet()
        })
      } catch (e) { failed = /webgl/i.test(String(e)) ? 'gl' : 'load' }
    })()
    return () => { dead = true; clearInterval(tick); map?.remove() }
  })
</script>

<main class="shell">
  <div class="map" bind:this={mapEl} aria-label="뷰 점수로 길을 칠한 지도"></div>
  {#if !ready && !failed}<div class="veil" aria-hidden="true"></div>{/if}

  <header class="top">
    <div class="bar">
      <span class="brand">트이길</span>
      <span class="where">{region?.name ?? ''}</span>
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

  {#if ready}
    <button type="button" class="pill nearby" onclick={findNear} aria-pressed={mode === 'near'}>
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
    {:else if mode === 'spot' && spot}
      <div class="row">
        <span class="badge">이 동네 상위 {Math.max(1, Math.ceil(spot.top))}%</span>
        <button type="button" class="icon ghost" onclick={closeSheet} aria-label="스팟 정보 닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <h1 class="big">{spot.title}</h1>
      {#if spotLines.length}<ul class="lines">{#each spotLines as l}<li>{l}</li>{/each}</ul>{/if}
      <dl class="facts three">
        <div><dt>하늘</dt><dd>시야의 {spot.sky}%</dd></div>
        <div><dt>트인 방향</dt><dd>{spot.pano}도</dd></div>
        <div><dt>해발</dt><dd>{spot.elev}m</dd></div>
      </dl>
    {:else if mode === 'near'}
      <div class="row">
        <h1>주변 뷰 좋은 곳</h1>
        <button type="button" class="icon ghost" onclick={closeSheet} aria-label="목록 닫기">
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
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p>이 화면에는 뷰 좋은 곳이 없어요. 지도를 넓혀서 다시 눌러 주세요.</p>
      {/if}
    {:else if mode === 'link' && picked && lead}
      <div class="row">
        <h1>{lead.title}</h1>
        <button type="button" class="icon ghost" onclick={closeSheet} aria-label="길 정보 닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <dl class="facts">
        <div><dt>하늘</dt><dd>시야의 {picked.ps}%</dd></div>
        <div><dt>물</dt><dd>{picked.pw >= 0.3 ? '보여요' : '안 보여요'}</dd></div>
        <div><dt>트인 방향</dt><dd>{picked.pa}도</dd></div>
        <div><dt>해발</dt><dd>{picked.z}m</dd></div>
      </dl>
      {#if lead.calm}<p>{lead.calm}</p>{/if}
    {:else}
      <h1>색이 진한 길일수록 뷰가 좋아요</h1>
      <p>길이나 동그란 스팟을 누르면 무엇이 보이는지 알려 드려요.</p>
    {/if}
  </section>

  {#if toast}<div class="toast" role="status">{toast}</div>{/if}
</main>

<style>
  .shell { position: fixed; inset: 0; overflow: hidden; background: var(--bg); color: var(--ink) }
  .map { position: absolute; inset: 0 }
  .veil { position: absolute; inset: 0; background: linear-gradient(100deg, var(--surf) 30%, var(--bg) 50%, var(--surf) 70%); background-size: 300% 100%; animation: shimmer 1.6s linear infinite }
  @keyframes shimmer { from { background-position: 100% 0 } to { background-position: -50% 0 } }
  .top { position: absolute; left: 0; right: 0; top: 0; padding: calc(12px + env(safe-area-inset-top)) 16px 0; display: flex; flex-direction: column; gap: 10px; pointer-events: none }
  .top > * { pointer-events: auto }
  .bar { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 6px 0 16px; border-radius: 16px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1) }
  .brand { font-family: 'Gowun Dodum', 'Noto Sans KR', sans-serif; font-size: 20px; letter-spacing: -0.01em }
  .where { flex: 1; min-width: 0; font-size: 15px; font-weight: 500; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
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
  .list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px }
  .item { width: 100%; min-height: 60px; padding: 10px 12px; display: flex; align-items: center; gap: 12px; text-align: left; border-radius: 14px; border: 1px solid var(--line); background: var(--surf); color: var(--ink) }
  .mark { width: 14px; height: 6px; border-radius: 3px; flex: none }
  .mark.spotmark { width: 14px; height: 14px; border-radius: 7px; box-shadow: 0 0 0 3px var(--bg), 0 0 0 4.5px var(--ink) }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px }
  .txt strong { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .txt span { font-size: 13px; color: var(--sub) }
  .item svg { color: var(--sub); flex: none }
  .loader { width: 18px; height: 18px; border-radius: 9px; border: 2.5px solid var(--line); border-top-color: var(--ink); animation: spin 0.9s linear infinite; flex: none }
  .toast { position: absolute; left: 50%; bottom: calc(var(--sheet-h, 150px) + 76px); transform: translateX(-50%); max-width: calc(100% - 32px); padding: 12px 16px; border-radius: 14px; background: var(--ink); color: var(--bg); font-size: 14px; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25) }
  :global(.me) { width: 18px; height: 18px; border-radius: 9px; background: var(--acc); border: 3px solid var(--bg); box-shadow: 0 0 0 6px color-mix(in srgb, var(--acc) 25%, transparent) }
  :global(.pin) { width: 44px; height: 44px; padding: 0; border: 0; background: transparent; display: grid; place-items: center }
  :global(.pin .core) { width: 18px; height: 18px; border-radius: 9px; border: 3px solid var(--bg); box-shadow: 0 0 0 1.5px var(--ink), 0 2px 6px rgba(0, 0, 0, 0.3); transition: transform 0.15s }
  :global(.pin.k .core) { background: var(--dot-k) }
  :global(.pin.w .core) { background: var(--dot-w) }
  :global(.pin.g .core) { background: var(--dot-g) }
  :global(.pin.sel .core) { transform: scale(1.45); box-shadow: 0 0 0 2px var(--ink), 0 3px 10px rgba(0, 0, 0, 0.35) }
</style>
