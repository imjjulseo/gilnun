<script lang="ts">
  import type { SavedTrip } from '../lib/saved.svelte'
  interface Props { trips: SavedTrip[]; walk: number; onClose: () => void; onOpen: (t: SavedTrip) => void }
  let { trips, walk, onClose, onOpen }: Props = $props()
  const mins = (m: number) => Math.max(1, Math.round(m / walk))
  const timeText = (m: number) => { const t = mins(m); return t < 60 ? `${t}분` : `${Math.floor(t / 60)}시간${t % 60 ? ` ${t % 60}분` : ''}` }
  const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)
  const STYLE = { fast: '효율', fit: '적절', view: '트인 코스' }
  const best = $derived({ len: Math.min(...trips.map((t) => t.len)), view: Math.max(...trips.map((t) => t.view)) })
  const rows = $derived(Math.max(...trips.map((t) => t.stops.length)))
</script>

<div class="cmp" role="dialog" aria-modal="true" aria-label="코스 나란히 보기">
  <div class="head">
    <button type="button" class="icon" onclick={onClose} aria-label="닫기">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
    </button>
    <h1>나란히 보기</h1>
  </div>
  <div class="grid" style:grid-template-columns={`repeat(${trips.length}, minmax(0, 1fr))`}>
    {#each trips as t (t.id)}<div class="cell name">{t.name}</div>{/each}
    {#each trips as t (t.id)}<div class="cell"><span class="k">걷는 시간</span><strong class:best={t.len === best.len}>{timeText(t.len)}</strong></div>{/each}
    {#each trips as t (t.id)}<div class="cell"><span class="k">거리</span><strong class:best={t.len === best.len}>{km(t.len)}</strong></div>{/each}
    {#each trips as t (t.id)}<div class="cell"><span class="k">트인 구간</span><strong class:best={t.view === best.view && t.view > 0}>{Math.round(t.view * 100)}%</strong></div>{/each}
    {#each trips as t (t.id)}<div class="cell"><span class="k">종류</span><strong>{t.style ? STYLE[t.style] : '길'}</strong></div>{/each}
    {#each Array(rows) as _, i}
      {#each trips as t (t.id)}<div class="cell stop">{#if t.stops[i]}<span class="num sm">{i + 1}</span><span>{t.stops[i].name}</span>{/if}</div>{/each}
    {/each}
    {#each trips as t (t.id)}<div class="cell"><button type="button" class="mini" onclick={() => onOpen(t)}>지도에서 보기</button></div>{/each}
  </div>
</div>

<style>
  .cmp { position: absolute; inset: 0; z-index: 7; background: var(--bg); overflow-y: auto; padding: calc(8px + env(safe-area-inset-top)) 12px 24px }
  .head { display: flex; align-items: center; gap: 4px; min-height: 52px }
  .grid { display: grid; gap: 0 8px }
  .cell { padding: 10px 4px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 14px }
  .cell.name { font-weight: 700; font-size: 15px; border-bottom: 2px solid var(--ink) }
  .cell.stop { flex-direction: row; align-items: center; gap: 6px }
  .cell.stop span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .k { font-size: 12px; color: var(--sub) }
  strong { font-size: 16px }
  .best { color: var(--acc) }
  .mini { width: 100%; padding: 0 6px; font-size: 13px }
</style>
