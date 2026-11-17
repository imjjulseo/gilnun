<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { meters, type Place, type Places } from '../lib/places'
  import { saved, store, samePlace, type CourseStyle, type SavedTrip } from '../lib/saved.svelte'
  import type { ModeId } from '../lib/route'
  import type { Prefs } from '../lib/score'
  import type { CCand, CourseOut } from '../lib/course'
  import { sunsetWindow } from '../lib/sun'
  import Compare from './Compare.svelte'

  type SlotType = 'food' | 'cafe' | 'bar' | 'walk' | 'play'
  interface Slot { type: SlotType; pin: Place | null }
  interface SpotInfo { id: string; rank: number; west: number; title: string; lon: number; lat: number }
  interface Props {
    db: Places | null; spots: Place[]; spotInfo: SpotInfo[]
    call: <T>(type: string, data: unknown) => Promise<T>
    meAt: [number, number] | null; frontOf: (p: { lon: number; lat: number }) => { v: number } | null
    walk: number; prefs: Prefs; open: number; say: (m: string) => void
    inRegion: (x: number, y: number) => boolean
    ensureDb: () => Promise<Places | null>; ensureMe: () => Promise<boolean>; origin: () => [number, number]
    onOpen: (stops: Place[], mode: ModeId, open: number, name: string) => void
    onCollect: (folder: string) => void; onPlace: (p: Place) => void
  }
  let { db, spots, spotInfo, call, meAt, frontOf, walk, prefs, open, say, inRegion, ensureDb, ensureMe, origin, onOpen, onCollect, onPlace }: Props = $props()

  const TYPES: { id: SlotType; label: string; cat: number }[] = [
    { id: 'food', label: '식당', cat: 0 }, { id: 'walk', label: '산책', cat: -1 }, { id: 'cafe', label: '카페', cat: 1 }, { id: 'play', label: '놀거리', cat: 4 }, { id: 'bar', label: '술집', cat: 2 },
  ]
  const T = (t: SlotType) => TYPES.find((x) => x.id === t)!
  const STYLES: { id: CourseStyle; label: string; mode: ModeId }[] = [{ id: 'fast', label: '효율', mode: 'fast' }, { id: 'fit', label: '적절', mode: 'balance' }, { id: 'view', label: '트인 코스', mode: 'view' }]

  const keep = store.get<{ slots: Slot[]; folders: string[]; fromMe: boolean }>('gn.course', { slots: [{ type: 'food', pin: null }, { type: 'walk', pin: null }, { type: 'cafe', pin: null }], folders: ['f0'], fromMe: false })
  let slots = $state<Slot[]>(keep.slots)
  let folders = $state<string[]>(keep.folders.filter((f) => saved.folders.some((x) => x.id === f)).length ? keep.folders : ['f0'])
  let fromMe = $state(keep.fromMe)
  let editing = $state(-1)
  let adding = $state(false)
  let busy = $state(false)
  type Shown = CourseOut & { stops: Place[]; auto: boolean[]; gaps: number[] }
  let results = $state<Shown[] | null>(null)
  let styleTab = $state<CourseStyle>('fit')
  let filled = $state<Shown | null>(null)
  let fillSeen: string[] = []
  let resEl = $state<HTMLElement | null>(null)
  let compare = $state<string[]>([])
  let comparing = $state(false)

  $effect(() => { store.set('gn.course', { slots: $state.snapshot(slots), folders: $state.snapshot(folders), fromMe }) })
  onMount(() => { ensureDb() })

  const hasPlay = $derived(!!db && db.cats.includes(4))
  const types = $derived(TYPES.filter((t) => t.id !== 'play' || hasPlay))
  const pool = $derived(saved.folders.filter((f) => folders.includes(f.id)).flatMap((f) => f.items))
  const dusk = sunsetWindow()
  function known(t: SlotType): Place[] {
    const c = T(t).cat
    const list = t === 'walk' ? pool.filter((p) => p.sub === '트인 자리') : pool.filter((p) => p.cat === c)
    return list.filter((p, i) => list.findIndex((q) => samePlace(p, q)) === i)
  }
  const counts = $derived(types.map((t) => ({ t, n: known(t.id).length })))
  const minsOf = (m: number) => Math.max(1, Math.round(m / walk))
  const timeText = (m: number) => { const t = minsOf(m); return t < 60 ? `${t}분` : `${Math.floor(t / 60)}시간${t % 60 ? ` ${t % 60}분` : ''}` }
  const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)

  function spotBonus(p: Place) {
    const s = spotInfo.find((x) => Math.abs(x.lon - p.lon) < 1e-6 && Math.abs(x.lat - p.lat) < 1e-6)
    if (!s) return 0.5
    return Math.min(1, 0.45 + 0.5 * (1 - s.rank / 20) + (dusk && s.west < 6 ? 0.4 : 0))
  }
  const bonus = (p: Place) => (p.sub === '트인 자리' ? spotBonus(p) : Math.min(1, (frontOf(p)?.v ?? 0) / 80))
  const cand = (p: Place): CCand => ({ key: `${p.name}@${p.lon.toFixed(5)},${p.lat.toFixed(5)}`, lon: p.lon, lat: p.lat, bonus: bonus(p) })

  /** 후보가 없는 칸은 근처에서 모르는 곳을 찾아 채운다. 가게 앞이 트인 곳을 먼저 고른다. */
  function unknownFor(t: SlotType, anchor: [number, number], n: number, rand: () => number, skip: Place[] = []): Place[] {
    if (t === 'walk') return spots.filter((p) => !skip.some((q) => samePlace(p, q))).map((p) => ({ p, s: spotBonus(p) - meters(anchor, [p.lon, p.lat]) / 1500 + rand() * 0.3 })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p)
    if (!db) return []
    const c = T(t).cat
    const near = db.list.filter((p) => p.cat === c && !skip.some((q) => samePlace(p, q))).map((p) => ({ p, d: meters(anchor, [p.lon, p.lat]) })).filter((x) => x.d < 900)
    return near.map((x) => ({ p: x.p, s: bonus(x.p) * 0.8 - x.d / 900 + rand() * 0.6 })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p)
  }
  function anchorOf(): [number, number] {
    const pts = [...slots.filter((s) => s.pin).map((s) => s.pin!), ...pool].map((p) => [p.lon, p.lat] as [number, number])
    if (fromMe && meAt && inRegion(...meAt)) pts.push(meAt)
    if (!pts.length) return origin()
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
  }

  async function run(fill = false) {
    if (!slots.length) return
    busy = true
    try {
      if (!(await ensureDb())) { say('가게 정보를 불러오지 못했어요.'); return }
      let start: [number, number] | null = null
      if (fromMe) { if (await ensureMe() && meAt) start = [meAt[0], meAt[1]]; else fromMe = false }
      const seed = (Date.now() % 100000) + 1, rand = (() => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) })()
      const anchor = start ?? anchorOf()
      const lists: { places: Place[]; auto: boolean }[] = slots.map((s) => {
        if (s.pin) return { places: [s.pin], auto: false }
        if (fill) return { places: unknownFor(s.type, anchor, 8, rand, pool), auto: true }
        const k = known(s.type)
        return k.length ? { places: k.slice(0, 14), auto: false } : { places: unknownFor(s.type, anchor, 8, rand), auto: true }
      })
      if (lists.some((l) => !l.places.length)) { say('근처에서 채울 곳을 찾지 못했어요.'); return }
      const req = { slots: lists.map((l, i) => ({ cands: l.places.map(cand), pin: slots[i].pin ? 0 : -1 })), start, prefs: $state.snapshot(prefs), open, styles: fill ? ['fit'] : ['fast', 'fit', 'view'], want: fill ? 1 : 3, jitter: fill ? 0.12 : 0, seed, exclude: fill ? fillSeen : [] }
      const out = await call<CourseOut[] | { error: string }>('course', req)
      if ('error' in out || !out.length) { say('걸어서 이어지는 코스를 찾지 못했어요.'); return }
      const dress = (o: CourseOut): Shown => ({ ...o, stops: o.pick.map((j, i) => lists[i].places[j]), auto: lists.map((l) => l.auto), gaps: start ? o.legs.slice(1) : o.legs })
      if (fill) { filled = dress(out[0]); fillSeen = [...fillSeen, out[0].key].slice(-30) }
      else { results = out.map(dress); filled = null }
      await tick(); resEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch { say('코스를 짜지 못했어요. 잠시 뒤에 다시 해 주세요.') }
    finally { busy = false }
  }
  function togglePin(i: number, p: Place) {
    slots[i].pin = slots[i].pin && samePlace(slots[i].pin!, p) ? null : p
    say(slots[i].pin ? `${T(slots[i].type).label} 칸을 ${p.name}에 고정했어요.` : '고정을 풀었어요.')
    if (results) run()
  }
  function moveSlot(i: number, d: number) { const j = i + d; if (j < 0 || j >= slots.length) return; const a = [...slots]; [a[i], a[j]] = [a[j], a[i]]; slots = a; editing = j; results = null }
  function nameOf(stops: Place[]) { return `${stops[0].name}에서 시작하는 코스` }
  function openCourse(c: { stops: Place[]; style: CourseStyle }) {
    const st = STYLES.find((s) => s.id === c.style)!
    onOpen(fromMe ? [{ id: 'me', name: '내 위치', sub: '', lon: 0, lat: 0, addr: '', floor: null, cat: -2 }, ...c.stops] : c.stops, st.mode, open, nameOf(c.stops))
  }
  function saveCourse(c: { stops: Place[]; style: CourseStyle; len: number; view: number }) {
    saved.addTrip({ name: nameOf(c.stops), stops: c.stops, mode: STYLES.find((s) => s.id === c.style)!.mode, open, len: c.len, view: c.view, kind: 'course', style: c.style })
    say('코스를 저장했어요. 아래에서 다른 코스와 나란히 볼 수 있어요.')
  }
  const isSaved = (c: { stops: Place[] }) => saved.trips.some((t) => t.kind === 'course' && t.stops.length === c.stops.length && t.stops.every((p, i) => samePlace(p, c.stops[i])))
  const courses = $derived(saved.trips.filter((t) => t.kind === 'course'))
  const shown = $derived(results?.filter((r) => r.style === styleTab) ?? [])
  const typeLabel = (i: number) => T(slots[i]?.type ?? 'food').label
</script>

{#snippet pinIcon(on: boolean)}
  <svg width="16" height="16" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8"/></svg>
{/snippet}
{#snippet courseCard(c: Shown)}
  <article class="card course">
    <div class="row"><strong class="sum">{timeText(c.len)}, {km(c.len)}</strong>{#if c.view > 0.03}<span class="badge">트인 구간 {Math.round(c.view * 100)}%</span>{/if}</div>
    <ol class="cstops">
      {#each c.stops as p, i}
        {@const pinned = !!slots[i]?.pin && samePlace(slots[i].pin!, p)}
        <li>
          <span class="num sm" aria-hidden="true">{i + 1}</span>
          <button type="button" class="cname" onclick={() => onPlace(p)}><span class="ty">{typeLabel(i)}</span>{p.name}</button>
          {#if c.auto[i] && !pinned}<span class="tag soft">새로 찾은 곳</span>{/if}
          <button type="button" class="icon pinb" class:on={pinned} aria-pressed={pinned} onclick={() => togglePin(i, p)} aria-label={pinned ? `${p.name} 고정 풀기` : `${typeLabel(i)} 칸을 ${p.name}에 고정하기`}>{@render pinIcon(pinned)}</button>
        </li>
        {#if i < c.stops.length - 1 && c.gaps[i] !== undefined}
          <li class="cleg">걸어서 {timeText(c.gaps[i])}</li>
        {/if}
      {/each}
    </ol>
    <div class="two">
      <button type="button" class="wide ghostbtn" disabled={isSaved(c)} onclick={() => saveCourse(c)}>{isSaved(c) ? '저장했어요' : '저장하기'}</button>
      <button type="button" class="wide primary" onclick={() => openCourse(c)}>지도에서 보기</button>
    </div>
  </article>
{/snippet}

<div class="page">
  <header><h1>코스</h1></header>

  <section class="card">
    <div class="row"><h2>순서</h2>{#if slots.length < 5}<button type="button" class="chip sm" onclick={() => (adding = !adding)} aria-expanded={adding}>칸 넣기</button>{/if}</div>
    <ol class="slots">
      {#each slots as s, i (i + s.type)}
        <li>
          <button type="button" class="slot" class:on={editing === i} aria-expanded={editing === i} onclick={() => (editing = editing === i ? -1 : i)}>
            <span class="num sm" aria-hidden="true">{i + 1}</span>
            <span class="txt"><strong>{T(s.type).label}</strong>{#if s.pin}<span>{s.pin.name}</span>{/if}</span>
            {#if s.pin}<span class="pinmark">{@render pinIcon(true)}</span>{/if}
          </button>
        </li>
      {/each}
    </ol>
    {#if editing >= 0 && slots[editing]}
      {@const s = slots[editing]}
      <div class="edit">
        <div class="chips">
          <button type="button" class="chip sm" disabled={editing === 0} onclick={() => moveSlot(editing, -1)}>앞으로 옮기기</button>
          <button type="button" class="chip sm" disabled={editing === slots.length - 1} onclick={() => moveSlot(editing, 1)}>뒤로 옮기기</button>
          {#if s.pin}<button type="button" class="chip sm" onclick={() => { s.pin = null }}>고정 풀기</button>{/if}
          {#if slots.length > 1}<button type="button" class="chip sm" onclick={() => { slots = slots.filter((_, k) => k !== editing); editing = -1; results = null }}>빼기</button>{/if}
        </div>
        {#if known(s.type).length}
          <p>고정할 곳을 골라요</p>
          <div class="chips wrap">
            {#each known(s.type) as p}
              {@const on = !!s.pin && samePlace(s.pin, p)}
              <button type="button" class="chip sm" class:on aria-pressed={on} onclick={() => { s.pin = on ? null : p }}>{p.name}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    {#if adding}
      <div class="chips wrap" role="group" aria-label="넣을 칸">
        {#each types as t}<button type="button" class="chip sm solid" onclick={() => { slots = [...slots, { type: t.id, pin: null }]; adding = false; results = null }}>{t.label}</button>{/each}
      </div>
    {/if}
  </section>

  <section class="card">
    <div class="row"><h2>후보</h2><button type="button" class="chip sm" onclick={() => onCollect(folders[0] ?? 'f0')}>가게 넣기</button></div>
    <div class="chips wrap" role="group" aria-label="후보로 쓸 폴더">
      {#each saved.folders as f (f.id)}
        {@const on = folders.includes(f.id)}
        <button type="button" class="chip sm" class:on aria-pressed={on} onclick={() => { folders = on ? folders.filter((x) => x !== f.id) : [...folders, f.id]; results = null }}>{f.name} {f.items.length}</button>
      {/each}
    </div>
    <p>{counts.filter((c) => slots.some((s) => s.type === c.t.id)).map((c) => `${c.t.label} ${c.n}곳`).join(', ')}</p>
    <label class="toggle"><input type="checkbox" bind:checked={fromMe} /> 내 위치에서 출발</label>
  </section>

  <button type="button" class="wide primary" onclick={() => run()} disabled={busy}>{busy && !filled ? '코스를 짜고 있어요' : '코스 짜기'}</button>

  <div bind:this={resEl} class="anchor"></div>
  {#if filled}
    <h2>모르는 곳으로 채운 코스</h2>
    {@render courseCard(filled)}
  {/if}
  {#if results}
    <div class="seg" role="tablist" aria-label="코스 종류">
      {#each STYLES as st}<button type="button" role="tab" aria-selected={styleTab === st.id} onclick={() => (styleTab = st.id)}>{st.label}</button>{/each}
    </div>
    {#each shown as c (c.key)}{@render courseCard(c)}{/each}
    {#if !shown.length}<p>이 종류로는 코스를 찾지 못했어요.</p>{/if}
  {/if}

  <button type="button" class="wide ghostbtn" onclick={() => run(true)} disabled={busy}>모르는 곳으로 채우기</button>

  {#if courses.length}
    <section class="card">
      <div class="row"><h2>저장한 코스</h2>{#if compare.length >= 2}<button type="button" class="chip sm on" onclick={() => (comparing = true)}>{compare.length}개 나란히 보기</button>{/if}</div>
      <ul class="list">
        {#each courses as t (t.id)}
          {@const on = compare.includes(t.id)}
          <li class="crow">
            <label class="check"><input type="checkbox" checked={on} onchange={() => (compare = on ? compare.filter((x) => x !== t.id) : [...compare, t.id].slice(-3))} /><span class="sr">{t.name} 비교에 넣기</span></label>
            <button type="button" class="item flat" onclick={() => onOpen(t.stops, t.mode, t.open, t.name)}>
              <span class="txt"><strong>{t.name}</strong><span>{t.stops.map((p) => p.name).join(', ')}</span></span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

{#if comparing}
  <Compare trips={compare.map((id) => saved.trips.find((t) => t.id === id)).filter(Boolean) as SavedTrip[]} {walk} onClose={() => (comparing = false)} onOpen={(t) => onOpen(t.stops, t.mode, t.open, t.name)} />
{/if}

<style>
  .anchor { scroll-margin-top: 12px; height: 0; margin-top: -14px }
  .slots { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px }
  .slot { width: 100%; min-height: 52px; padding: 6px 12px; display: flex; align-items: center; gap: 10px; border-radius: 12px; border: 1.5px solid var(--line); background: var(--bg); text-align: left }
  .slot.on { border-color: var(--ink) }
  .pinmark { color: var(--acc); display: grid }
  .edit { display: flex; flex-direction: column; gap: 8px }
  .toggle { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 15px }
  .toggle input, .check input { width: 22px; height: 22px; accent-color: var(--acc) }
  .course { background: var(--bg) }
  .sum { font-size: 18px }
  .cstops { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px }
  .cstops li { display: flex; align-items: center; gap: 8px; min-height: 44px }
  .cname { flex: 1; min-width: 0; border: 0; background: none; text-align: left; font-size: 15px; font-weight: 700; padding: 8px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .ty { font-weight: 500; color: var(--sub); font-size: 13px; margin-right: 8px }
  .cleg { padding-left: 11px; margin-left: 11px; border-left: 2px dashed var(--line); color: var(--sub); font-size: 13px; min-height: 22px !important }
  .pinb { color: var(--sub) }
  .pinb.on { color: var(--acc) }
  .crow { display: flex; align-items: center; gap: 6px }
  .check { width: 44px; height: 44px; display: grid; place-items: center; flex: none }
</style>
