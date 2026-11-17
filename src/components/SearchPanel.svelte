<script lang="ts" module>
  export type SearchTarget =
    | { kind: 'browse' }
    | { kind: 'slot'; label: string }
    | { kind: 'set'; which: 'home' | 'work' }
    | { kind: 'collect'; folder: string }
</script>
<script lang="ts">
  import { tick, onMount, untrack } from 'svelte'
  import { CAT_LABEL, looksShared, meters, floorText, norm, type Place, type Places } from '../lib/places'
  import { saved, samePlace } from '../lib/saved.svelte'
  import { eul, ro } from '../lib/ko'

  interface Props {
    db: Places | null
    target: SearchTarget
    regionName: string
    origin: () => [number, number]
    canMe: boolean
    onPick: (p: Place, how: 'search' | 'share' | 'recent' | 'me' | 'home' | 'work') => void
    onShortcut: (which: 'home' | 'work') => void
    onMapPick: (target: { kind: 'set'; which: 'home' | 'work' } | { kind: 'slot' }) => void
    onClose: () => void
    say: (m: string) => void
  }
  let { db, target, regionName, origin, canMe, onPick, onShortcut, onMapPick, onClose, say }: Props = $props()

  let query = $state('')
  let cat = $state<number | null>(null)
  let sub = $state<string | null>(null)
  let el = $state<HTMLTextAreaElement | null>(null)
  let setting = $state<'home' | 'work' | null>(untrack(() => (target.kind === 'set' ? target.which : null)))
  let editing = $state(false)
  const NAME = { home: '집', work: '회사' }

  const collecting = $derived(target.kind === 'collect')
  const folderName = $derived(target.kind === 'collect' ? saved.folders.find((f) => f.id === target.folder)?.name ?? '' : '')
  const title = $derived(setting ? `${NAME[setting]} 찾기` : target.kind === 'slot' ? `${target.label} 찾기` : collecting ? `${folderName}에 넣을 곳 찾기` : '장소 찾기')
  const placeholder = $derived(setting ? `${NAME[setting]} 근처 건물이나 가게 이름` : '장소, 주소 검색')
  const shared = $derived(db && looksShared(query) ? db.fromShare(query) : null)
  const sugs = $derived(db && !looksShared(query) && query.trim().length >= 1 && !sub ? db.suggest(query).filter((s) => norm(s) !== norm(query)) : [])
  const results = $derived.by(() => {
    if (!db || looksShared(query) || (!query.trim() && cat === null && !sub)) return [] as { p: Place; d: number }[]
    const o = origin()
    return db.search(sub ? '' : query, cat, sub).map((r) => ({ p: r.p, rank: r.rank, d: meters(o, [r.p.lon, r.p.lat]) }))
      .sort((a, b) => a.rank - b.rank || a.d - b.d).slice(0, 50)
  })
  const cats = $derived(db ? db.cats : [0, 1, 2, 3])
  const addrs = $derived(db && !looksShared(query) && !sub && cat === null ? db.searchAddr(query) : [])

  onMount(async () => { await tick(); el?.focus() })

  function choose(p: Place, how: Parameters<Props['onPick']>[1] = 'search') {
    if (setting) {
      saved.setPlace(setting, p); say(`${eul(NAME[setting])} ${ro(p.name)} 정했어요.`)
      if (target.kind === 'set') { onClose(); return }
      setting = null; query = ''; sub = null; cat = null; return
    }
    if (how === 'search' || how === 'share') saved.pushRecent(p)
    onPick(p, how)
    if (collecting) { query = ''; sub = null; el?.focus() }
  }
  function hl(name: string): { a: string; b: string; c: string } {
    const n = norm(query); if (!n || sub) return { a: name, b: '', c: '' }
    const raw = name.toLowerCase(); let i = raw.indexOf(query.trim().toLowerCase())
    if (i < 0) return { a: name, b: '', c: '' }
    const len = query.trim().length; return { a: name.slice(0, i), b: name.slice(i, i + len), c: name.slice(i + len) }
  }
  const distText = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)
  const inFolder = (p: Place) => target.kind === 'collect' && saved.folders.find((f) => f.id === target.folder)?.items.some((x) => samePlace(x, p))
</script>

{#snippet back()}
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
{/snippet}
{#snippet xmark(s = 18)}
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
{/snippet}
{#snippet pinIcon(which: 'home' | 'work' | 'me')}
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if which === 'home'}<path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/>{:else if which === 'work'}<rect x="4" y="7" width="16" height="12" rx="2"/><path d="M9 7V5h6v2M4 12h16"/>{:else}<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/>{/if}
  </svg>
{/snippet}

<div class="search" role="dialog" aria-modal="true" aria-label={title}>
  <div class="sbar">
    <button type="button" class="icon" onclick={() => (setting && target.kind !== 'set' ? (setting = null) : onClose())} aria-label="찾기 닫기">{@render back()}</button>
    <label class="sr" for="q">{title}</label>
    <textarea id="q" rows="1" bind:this={el} bind:value={query} {placeholder} autocomplete="off" enterkeyhint="search"
      oninput={() => (sub = null)}
      onkeydown={(e) => { if (e.key === 'Escape') onClose(); else if (e.key === 'Enter' && !e.shiftKey && !looksShared(query)) { e.preventDefault(); (e.currentTarget as HTMLElement).blur() } }}></textarea>
    {#if query || sub}
      <button type="button" class="icon" onclick={() => { query = ''; sub = null; el?.focus() }} aria-label="지우기">{@render xmark()}</button>
    {/if}
  </div>
  {#if setting || target.kind !== 'browse'}<p class="ctx">{title}</p>{/if}
  <div class="chips cats" role="group" aria-label="업종 고르기">
    {#if sub}
      <button type="button" class="chip on" onclick={() => (sub = null)} aria-label={`${sub} 조건 빼기`}>{sub}<span class="x">{@render xmark(14)}</span></button>
    {/if}
    {#each cats as i}
      <button type="button" class="chip" class:on={cat === i} aria-pressed={cat === i} onclick={() => (cat = cat === i ? null : i)}>{CAT_LABEL[i]}</button>
    {/each}
  </div>
  <div class="sbody">
    {#if setting || target.kind === 'slot'}
        <ul class="list">
          <li><button type="button" class="item flat" onclick={() => onMapPick(setting ? { kind: 'set', which: setting } : { kind: 'slot' })}>
            <span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg></span>
            <span class="txt"><strong>지도에서 고르기</strong></span></button></li>
        </ul>
      {/if}
    {#if !query.trim() && cat === null && !sub}
      {#if target.kind === 'slot'}
        <ul class="list">
          {#if canMe}
            <li><button type="button" class="item flat" onclick={() => onPick({ id: 'me', name: '내 위치', sub: '', lon: 0, lat: 0, addr: '', floor: null, cat: -2 }, 'me')}>
              <span class="ic">{@render pinIcon('me')}</span><span class="txt"><strong>내 위치</strong></span></button></li>
          {/if}
          {#each (['home', 'work'] as const) as w}
            {#if saved[w]}
              <li><button type="button" class="item flat" onclick={() => onPick(saved[w]!, w)}>
                <span class="ic">{@render pinIcon(w)}</span><span class="txt"><strong>{NAME[w]}</strong><span>{saved[w]!.name}</span></span></button></li>
            {/if}
          {/each}
        </ul>
      {:else if target.kind === 'browse' && !setting}
        <div class="short">
          {#each (['home', 'work'] as const) as w}
            {@const p = saved[w]}
            <div class="sc">
              <button type="button" class="chip solid" onclick={() => (editing || !p ? (setting = w, el?.focus()) : onShortcut(w))} aria-label={p ? (editing ? `${NAME[w]} 다시 정하기` : `${ro(NAME[w])} 길 찾기`) : `${NAME[w]} 추가하기`}>
                {@render pinIcon(w)}{NAME[w]}{#if !p}<span class="plus" aria-hidden="true">+</span>{:else if editing}<span class="plus">다시 정하기</span>{/if}
              </button>
              {#if editing && p}
                <button type="button" class="icon" onclick={() => saved.setPlace(w, null)} aria-label={`${NAME[w]} 지우기`}>{@render xmark(16)}</button>
              {/if}
            </div>
          {/each}
          {#if saved.home || saved.work}
            <button type="button" class="chip sm edit" aria-pressed={editing} onclick={() => (editing = !editing)}>{editing ? '마치기' : '고치기'}</button>
          {/if}
        </div>
      {/if}
      {#if saved.recent.length && !setting && !collecting}
        <div class="row"><h2>최근 찾은 곳</h2><button type="button" class="chip sm" onclick={() => saved.dropRecent(null)}>모두 지우기</button></div>
        <ul class="list">
          {#each saved.recent as p (p.id + p.lon)}
            <li class="rrow">
              <button type="button" class="item flat" onclick={() => choose(p, 'recent')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>
                <span class="txt"><strong>{p.name}</strong><span>{[p.cat >= 0 ? CAT_LABEL[p.cat] : p.sub, p.addr].filter(Boolean).join(', ')}</span></span>
              </button>
              <button type="button" class="icon" onclick={() => saved.dropRecent(p)} aria-label={`${p.name} 최근 기록에서 지우기`}>{@render xmark(16)}</button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if !db}
      <div class="row start"><span class="loader" aria-hidden="true"></span><p>가게 정보를 불러오고 있어요.</p></div>
    {:else if shared}
      {#if shared.place}
        <button type="button" class="item" onclick={() => choose(shared!.place!, 'share')}>
          <span class="txt"><strong>{shared.place.name}</strong><span>{[shared.found === 'addr' ? '주소 위치' : shared.place.sub, shared.place.addr, floorText(shared.place.floor)].filter(Boolean).join(', ')}</span></span>
        </button>
      {:else}
        <p>{eul(shared.name || shared.addr)} 찾지 못했어요. 지금은 {regionName} 근처만 찾을 수 있어요.</p>
      {/if}
    {:else if looksShared(query)}
      <p>공유한 글자에서 주소를 찾지 못했어요. 가게 이름만 넣어 보거나 지도를 길게 눌러 직접 골라 주세요.</p>
    {:else}
      {#if sugs.length}
        <div class="chips wrap" role="group" aria-label="추천어">
          {#each sugs as s}<button type="button" class="chip sm solid" onclick={() => { sub = s; query = s }}>{s}</button>{/each}
        </div>
      {/if}
      {#if addrs.length}
        <ul class="list">
          {#each addrs as a (a.id)}
            <li><button type="button" class="item" onclick={() => choose(a)}><span class="txt"><strong>{a.name}</strong><span>주소</span></span></button></li>
          {/each}
        </ul>
      {/if}
      {#if !results.length && !addrs.length}
        <p>찾는 곳이 없어요. 지금은 {regionName} 근처만 찾을 수 있어요.</p>
      {:else if results.length}
        <ul class="list">
          {#each results as r (r.p.id)}
            {@const h = hl(r.p.name)}
            <li>
              <button type="button" class="item" onclick={() => choose(r.p)}>
                <span class="txt"><strong>{h.a}<mark>{h.b}</mark>{h.c}</strong><span>{[r.p.sub, floorText(r.p.floor), distText(r.d)].filter(Boolean).join(', ')}</span></span>
                {#if inFolder(r.p)}<span class="tag">넣었어요</span>{:else if saved.isStarred(r.p)}<span class="tag soft">저장</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</div>

<style>
  .search { position: absolute; inset: 0; z-index: 8; background: var(--bg); display: flex; flex-direction: column; padding-top: env(safe-area-inset-top) }
  .sbar { display: flex; align-items: flex-start; gap: 4px; padding: 8px 8px 8px 6px; border-bottom: 1px solid var(--line) }
  .sbar textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 96px; padding: 11px 4px; border: 0; outline: 0; resize: none; background: transparent; color: var(--ink); font: inherit; font-size: 16px; line-height: 1.4; field-sizing: content }
  .sbar textarea::placeholder { color: var(--sub) }
  .ctx { padding: 10px 16px 0; font-weight: 700; color: var(--ink) }
  .cats { padding: 10px 16px 4px }
  .sbody { flex: 1; overflow-y: auto; padding: 8px 16px calc(20px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px }
  .short { display: flex; gap: 8px; flex-wrap: wrap; align-items: center }
  .sc { display: flex; align-items: center }
  .plus { color: var(--sub); font-weight: 500 }
  .edit { margin-left: auto }
  .edit[aria-pressed='true'] { border-color: var(--ink); color: var(--ink) }
  .rrow { display: flex; align-items: center; gap: 4px }
  .ic { width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center; background: var(--surf); border: 1px solid var(--line); flex: none; color: var(--ink) }
</style>
