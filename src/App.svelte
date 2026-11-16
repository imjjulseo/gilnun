<script lang="ts">
  import { onMount } from 'svelte'
  import maplibregl from 'maplibre-gl'
  import type { GeoJSONSource, Map as MlMap, ExpressionSpecification } from 'maplibre-gl'
  import { THEMES, basemap, type ThemeName, type Kind } from './lib/theme'
  import { DEFAULT_PREFS, FLOOR, rate, type LinkProps, type Prefs } from './lib/score'

  interface Region { id: string; name: string; bbox: [number, number, number, number]; center: [number, number]; zoom: number; links: string; spots: string }
  type Shown = LinkProps & { kind: Kind | 'n'; v: number }
  type Fc = GeoJSON.FeatureCollection<GeoJSON.LineString, LinkProps>

  const store = {
    get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
    set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 저장 못 해도 동작 */ } },
  }
  const systemNight = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

  let themeName = $state<ThemeName>(store.get<ThemeName | null>('gn.theme', null) ?? (systemNight() ? 'night' : 'light'))
  let prefs = $state<Prefs>({ ...DEFAULT_PREFS, ...store.get<Partial<Prefs>>('gn.prefs', {}) })
  let region = $state<Region | null>(null)
  let picked = $state<Shown | null>(null)
  let toast = $state('')
  let locating = $state(false)
  let failed = $state<'' | 'load' | 'gl'>('')
  let sheetEl = $state<HTMLElement | null>(null)
  const theme = $derived(THEMES[themeName])

  let mapEl: HTMLDivElement
  let map: MlMap | null = null
  let raw: Fc | null = null
  let me: maplibregl.Marker | null = null
  let toastTimer = 0

  const CHIPS: { key: keyof Prefs; label: string; kind?: Kind }[] = [
    { key: 'k', label: '하늘', kind: 'k' }, { key: 'w', label: '물', kind: 'w' }, { key: 'g', label: '녹지', kind: 'g' }, { key: 'calm', label: '한적함' },
  ]

  function say(msg: string) { toast = msg; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (toast = ''), 3200) }

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
  }
  function repaint() {
    if (!map || !map.getSource('links')) return
    ;(map.getSource('links') as GeoJSONSource).setData(rated())
    if (picked) picked = null, (map.getSource('pick') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] })
  }
  function pick(f: maplibregl.MapGeoJSONFeature | null) {
    if (!map) return
    const src = map.getSource('pick') as GeoJSONSource
    if (!f) { picked = null; src.setData({ type: 'FeatureCollection', features: [] }); return }
    picked = f.properties as Shown
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: f.geometry, properties: f.properties }] })
  }

  async function restyle() {
    if (!map) return
    map.setStyle(await basemap(theme))
    map.once('styledata', () => { addOverlay() })
  }
  function toggle(key: keyof Prefs) {
    const next = { ...prefs, [key]: !prefs[key] }
    if (!next.k && !next.w && !next.g) { say('물, 하늘, 녹지 중 하나는 켜 두어야 해요.'); return }
    prefs = next; store.set('gn.prefs', next); repaint()
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
    const kind = picked.kind === 'n' ? null : picked.kind
    const title = kind === 'w' ? '물이 보이는 길이에요' : kind === 'g' ? '녹지가 보이는 길이에요' : kind === 'k' ? '하늘이 넓게 보이는 길이에요' : '뷰가 약한 길이에요'
    const calm = picked.c < 70 ? '큰길 옆이라 차가 많이 다녀요.' : picked.c >= 110 ? '공원이나 보행로라 걷기 편해요.' : ''
    return { kind, title, calm }
  })

  $effect(() => {
    const r = document.documentElement.style, t = theme
    r.setProperty('--bg', t.bg); r.setProperty('--surf', t.surf); r.setProperty('--line', t.line); r.setProperty('--ink', t.ink)
    r.setProperty('--sub', t.sub); r.setProperty('--acc', t.acc); r.setProperty('--on-acc', t.onAcc)
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.bg)
  })
  $effect(() => {
    if (!sheetEl) return
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--sheet-h', sheetEl!.offsetHeight + 'px'))
    ro.observe(sheetEl); return () => ro.disconnect()
  })

  onMount(() => {
    let dead = false
    ;(async () => {
      try {
        const man = await (await fetch('./data/manifest.json')).json()
        region = man.regions[0] as Region
        const [style, links] = await Promise.all([basemap(theme), fetch('./data/' + region.links).then((r) => r.json())])
        if (dead) return
        raw = links as Fc
        map = new maplibregl.Map({ container: mapEl, style, center: region.center, zoom: region.zoom, minZoom: 11, maxZoom: 19, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false })
        map.touchZoomRotate.disableRotation()
        map.on('load', addOverlay)
        map.on('click', (e) => {
          const hit = map!.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['links-hit'] })
          pick(hit[0] ?? null)
        })
      } catch (e) { failed = /webgl/i.test(String(e)) ? 'gl' : 'load' }
    })()
    return () => { dead = true; map?.remove() }
  })
</script>

<main class="shell">
  <div class="map" bind:this={mapEl} aria-label="뷰 점수로 길을 칠한 지도"></div>

  <header class="top">
    <div class="bar">
      <span class="brand">길눈</span>
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

  <button type="button" class="icon locate" onclick={locate} aria-label="현재 위치로 가기" aria-busy={locating}>
    <svg class:spin={locating} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/></svg>
  </button>

  <section class="sheet" bind:this={sheetEl} aria-live="polite">
    <div class="grip" aria-hidden="true"></div>
    {#if failed}
      <h1>{failed === 'gl' ? '이 브라우저에서는 지도를 그릴 수 없어요' : '지도를 불러오지 못했어요'}</h1>
      <p>{failed === 'gl' ? '크롬이나 사파리 최신 버전에서 열어 주세요.' : '인터넷 연결을 확인하고 화면을 새로 고쳐 주세요.'}</p>
    {:else if picked && lead}
      <div class="row">
        <h1>{lead.title}</h1>
        <button type="button" class="icon ghost" onclick={() => pick(null)} aria-label="길 정보 닫기">
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
      <p>길을 누르면 그 길에서 무엇이 보이는지 알려 드려요.</p>
    {/if}
  </section>

  {#if toast}<div class="toast" role="status">{toast}</div>{/if}
</main>

<style>
  .shell { position: fixed; inset: 0; overflow: hidden; background: var(--bg); color: var(--ink) }
  .map { position: absolute; inset: 0 }
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
  .spin { animation: spin 1.1s linear infinite }
  @keyframes spin { to { transform: rotate(360deg) } }
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; max-width: 520px; margin: 0 auto; padding: 10px 20px calc(20px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px; background: var(--bg); border-radius: 24px 24px 0 0; box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.14) }
  .grip { width: 40px; height: 4px; border-radius: 2px; background: var(--line); align-self: center }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px }
  h1 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3 }
  p { margin: 0; font-size: 14px; color: var(--sub) }
  .facts { margin: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px }
  .facts div { padding: 10px 8px; border-radius: 12px; background: var(--surf); border: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px }
  dt { font-size: 12px; color: var(--sub) }
  dd { margin: 0; font-size: 15px; font-weight: 700; white-space: nowrap }
  .toast { position: absolute; left: 50%; bottom: calc(var(--sheet-h, 150px) + 76px); transform: translateX(-50%); max-width: calc(100% - 32px); padding: 12px 16px; border-radius: 14px; background: var(--ink); color: var(--bg); font-size: 14px; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25) }
  :global(.me) { width: 18px; height: 18px; border-radius: 9px; background: var(--acc); border: 3px solid var(--bg); box-shadow: 0 0 0 6px color-mix(in srgb, var(--acc) 25%, transparent) }
</style>
