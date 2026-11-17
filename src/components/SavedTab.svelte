<script lang="ts">
  import { CAT_LABEL, type Place } from '../lib/places'
  import { saved, type SavedTrip } from '../lib/saved.svelte'
  import Compare from './Compare.svelte'
  interface Props { onPlace: (p: Place) => void; onTrip: (t: SavedTrip) => void; walk: number; say: (m: string) => void }
  let { onPlace, onTrip, walk, say }: Props = $props()

  let open = $state<string>('f0')
  let naming = $state<'' | 'new' | string>('')
  let name = $state('')
  let confirmDel = $state('')
  let renamingTrip = $state('')
  let compare = $state<string[]>([])
  let comparing = $state(false)
  const folder = $derived(saved.folders.find((f) => f.id === open) ?? saved.folders[0])
  const mins = (m: number) => Math.max(1, Math.round(m / walk))
  const timeText = (m: number) => { const t = mins(m); return t < 60 ? `${t}분` : `${Math.floor(t / 60)}시간${t % 60 ? ` ${t % 60}분` : ''}` }
  const sub = (p: Place) => [p.cat >= 0 ? CAT_LABEL[p.cat] : p.sub, p.addr].filter(Boolean).join(', ')
  function submitName() {
    if (!name.trim()) { naming = ''; return }
    if (naming === 'new') { open = saved.addFolder(name); say('폴더를 만들었어요.') } else saved.renameFolder(naming, name)
    naming = ''; name = ''
  }
</script>

{#snippet xmark()}
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
{/snippet}

<div class="page">
  <header><h1>저장</h1></header>

  <div class="chips" role="tablist" aria-label="폴더">
    {#each saved.folders as f (f.id)}
      <button type="button" role="tab" class="chip" class:on={open === f.id} aria-selected={open === f.id} onclick={() => { open = f.id; confirmDel = '' }}>{f.name} {f.items.length}</button>
    {/each}
    <button type="button" class="chip solid" onclick={() => { naming = 'new'; name = '' }}>폴더 만들기</button>
  </div>

  {#if naming}
    <form class="two" onsubmit={(e) => { e.preventDefault(); submitName() }}>
      <label class="sr" for="fname">폴더 이름</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="fname" class="field" bind:value={name} maxlength="20" placeholder="폴더 이름" autofocus />
      <button type="submit" class="mini" style="flex:none">{naming === 'new' ? '만들기' : '바꾸기'}</button>
    </form>
  {/if}

  {#if folder}
    <section class="card">
      <div class="row">
        <h2>{folder.name}</h2>
        <div class="chips">
          <button type="button" class="chip sm" onclick={() => { naming = folder.id; name = folder.name }}>이름 바꾸기</button>
          {#if folder.id !== 'f0'}
            {#if confirmDel === folder.id}
              <button type="button" class="chip sm on" onclick={() => { saved.removeFolder(folder.id); open = 'f0'; confirmDel = ''; say('폴더를 지웠어요.') }}>정말 지우기</button>
            {:else}
              <button type="button" class="chip sm" onclick={() => (confirmDel = folder.id)}>지우기</button>
            {/if}
          {/if}
        </div>
      </div>
      {#if folder.items.length}
        <ul class="list">
          {#each folder.items as p (p.id + p.lon + p.lat)}
            <li class="r">
              <button type="button" class="item flat" onclick={() => onPlace(p)}>
                <span class="txt"><strong>{p.name}</strong><span>{sub(p)}</span></span>
              </button>
              <button type="button" class="icon" onclick={() => saved.star(p, folder.id, false)} aria-label={`${p.name} 이 폴더에서 빼기`}>{@render xmark()}</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p>가게 카드의 별표를 누르면 여기에 모여요.</p>
      {/if}
    </section>
  {/if}

  <section class="card">
    <div class="row"><h2>저장한 코스와 길</h2>{#if compare.length >= 2}<button type="button" class="chip sm on" onclick={() => (comparing = true)}>{compare.length}개 나란히 보기</button>{/if}</div>
    {#if saved.trips.length}
      <ul class="list">
        {#each saved.trips as t (t.id)}
          {@const on = compare.includes(t.id)}
          <li class="r">
            <label class="check"><input type="checkbox" checked={on} onchange={() => (compare = on ? compare.filter((x) => x !== t.id) : [...compare, t.id].slice(-3))} /><span class="sr">{t.name} 비교에 넣기</span></label>
            {#if renamingTrip === t.id}
              <form class="two grow" onsubmit={(e) => { e.preventDefault(); saved.renameTrip(t.id, name); renamingTrip = '' }}>
                <label class="sr" for={'tn' + t.id}>이름</label>
                <!-- svelte-ignore a11y_autofocus -->
                <input id={'tn' + t.id} class="field" bind:value={name} maxlength="30" autofocus />
                <button type="submit" class="mini" style="flex:none">바꾸기</button>
              </form>
            {:else}
              <button type="button" class="item flat" onclick={() => onTrip(t)}>
                <span class="txt"><strong>{t.name}</strong><span>{t.kind === 'course' ? '코스' : '길'}, {timeText(t.len)}, {t.stops.length}곳</span></span>
              </button>
              <button type="button" class="icon" onclick={() => { renamingTrip = t.id; name = t.name }} aria-label={`${t.name} 이름 바꾸기`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>
              </button>
              <button type="button" class="icon" onclick={() => { saved.removeTrip(t.id); compare = compare.filter((x) => x !== t.id) }} aria-label={`${t.name} 지우기`}>{@render xmark()}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p>길 찾기나 코스에서 저장하기를 누르면 여기에 모여요.</p>
    {/if}
  </section>
</div>

{#if comparing}
  <Compare trips={compare.map((id) => saved.trips.find((t) => t.id === id)).filter(Boolean) as SavedTrip[]} {walk} onClose={() => (comparing = false)} onOpen={onTrip} />
{/if}

<style>
  .r { display: flex; align-items: center; gap: 2px }
  .grow { flex: 1 }
  .check { width: 44px; height: 44px; display: grid; place-items: center; flex: none }
  .check input { width: 22px; height: 22px; accent-color: var(--acc) }
</style>
