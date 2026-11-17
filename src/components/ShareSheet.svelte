<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { CONCEPTS, drawShare, conceptTitle, type Concept, type ShareArt } from '../lib/share'
  interface Props { art: ShareArt; url: string; sky: { dusk: number; night: number }; onClose: () => void; say: (m: string) => void }
  let { art, url, sky, onClose, say }: Props = $props()
  let concept = $state<Concept>(untrack(() => (sky.night > 0.5 ? 'star' : sky.dusk > 0.3 ? 'dusk' : 'sky')))
  let cv = $state<HTMLCanvasElement | null>(null)
  let img = $state('')
  let busy = $state(true)
  async function render() {
    if (!cv) return
    busy = true
    await drawShare(cv, art, concept)
    img = cv.toDataURL('image/png'); busy = false
  }
  onMount(render)
  const blob = () => new Promise<Blob | null>((res) => cv!.toBlob(res, 'image/png'))
  async function shareImage() {
    const b = await blob(); if (!b) return
    const file = new File([b], `트이길-${conceptTitle(concept)}.png`, { type: 'image/png' })
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: art.title, text: `${art.title}\n${url}` }); return }
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      say('이미지를 내려받았어요.')
    } catch (e) { if ((e as Error)?.name !== 'AbortError') say('이미지를 공유하지 못했어요.') }
  }
  async function shareLink() {
    try {
      if (navigator.share) { await navigator.share({ title: art.title, text: art.stops.map((s, i) => `${i + 1}. ${s.name}`).join('\n'), url }); return }
      await navigator.clipboard.writeText(url); say('링크를 복사했어요.')
    } catch (e) { if ((e as Error)?.name !== 'AbortError') say('링크를 만들지 못했어요.') }
  }
</script>

<div class="share" role="dialog" aria-modal="true" aria-label="공유하기">
  <div class="head">
    <button type="button" class="icon" onclick={onClose} aria-label="닫기">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <h1>공유하기</h1>
  </div>
  <div class="seg" role="group" aria-label="이미지 컨셉">
    {#each CONCEPTS as c}<button type="button" aria-pressed={concept === c.id} onclick={() => { concept = c.id; render() }}>{c.label}</button>{/each}
  </div>
  <div class="frame">
    <canvas bind:this={cv} class="hid" aria-hidden="true"></canvas>
    {#if img}<img src={img} alt={`${art.title} 코스 그림`} class:dim={busy} />{:else}<div class="row start"><span class="loader" aria-hidden="true"></span><p>그림을 그리고 있어요.</p></div>{/if}
  </div>
  <div class="two">
    <button type="button" class="wide ghostbtn" onclick={shareLink}>링크 보내기</button>
    <button type="button" class="wide primary" onclick={shareImage} disabled={busy}>이미지 보내기</button>
  </div>
</div>

<style>
  .share { position: absolute; inset: 0; z-index: 8; background: var(--bg); display: flex; flex-direction: column; gap: 12px; padding: calc(8px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom)) }
  .head { display: flex; align-items: center; gap: 4px; min-height: 52px }
  .frame { flex: 1; min-height: 0; display: grid; place-items: center }
  .frame img { max-width: 100%; max-height: 100%; border-radius: 16px; box-shadow: 0 6px 28px rgba(0, 0, 0, 0.18); transition: opacity 0.15s }
  .frame img.dim { opacity: 0.6 }
  .hid { display: none }
</style>
