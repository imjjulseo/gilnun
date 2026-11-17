<script lang="ts">
  import { saved, WALKS, type ThemePick, type SkyPick } from '../lib/saved.svelte'
  interface Props { say: (m: string) => void }
  let { say }: Props = $props()
  let confirmReset = $state(false)
  const THEMES: { v: ThemePick; label: string }[] = [{ v: 'system', label: '기기 설정' }, { v: 'light', label: '낮' }, { v: 'night', label: '밤' }]
  const SKIES: { v: SkyPick; label: string }[] = [{ v: 'real', label: '실제 하늘' }, { v: 'day', label: '늘 하늘색' }]
  function set<K extends keyof typeof saved.settings>(k: K, v: (typeof saved.settings)[K]) { saved.settings[k] = v; saved.saveSettings() }
</script>

<div class="page">
  <header><h1>설정</h1></header>

  <section class="card">
    <h2 id="s-theme">화면</h2>
    <div class="seg" role="group" aria-labelledby="s-theme">
      {#each THEMES as t}<button type="button" aria-pressed={saved.settings.theme === t.v} onclick={() => set('theme', t.v)}>{t.label}</button>{/each}
    </div>
  </section>

  <section class="card">
    <h2 id="s-sky">하늘 길 색</h2>
    <div class="seg" role="group" aria-labelledby="s-sky">
      {#each SKIES as t}<button type="button" aria-pressed={saved.settings.sky === t.v} onclick={() => set('sky', t.v)}>{t.label}</button>{/each}
    </div>
    <p>{saved.settings.sky === 'real' ? '지금 시각을 따라 하늘색, 노을색, 밤하늘과 별빛으로 바뀌어요.' : '시각과 상관없이 하늘색으로 보여요.'}</p>
  </section>

  <section class="card">
    <h2 id="s-walk">걷는 속도</h2>
    <div class="seg" role="group" aria-labelledby="s-walk">
      {#each WALKS as w}<button type="button" aria-pressed={saved.settings.walk === w.v} onclick={() => set('walk', w.v)}>{w.label}</button>{/each}
    </div>
    <p>1분에 {saved.settings.walk}m를 걷는다고 보고 시간을 계산해요.</p>
  </section>

  <section class="card">
    <button type="button" class="wide ghostbtn" onclick={() => { saved.setSeen(false); say('지도 탭에서 처음 안내를 다시 보여 드릴게요.') }}>처음 안내 다시 보기</button>
    {#if confirmReset}
      <div class="two">
        <button type="button" class="wide ghostbtn" onclick={() => (confirmReset = false)}>그대로 두기</button>
        <button type="button" class="wide primary danger" onclick={() => { saved.reset(); confirmReset = false; say('저장한 것을 모두 지웠어요.') }}>모두 지우기</button>
      </div>
      <p>폴더, 최근 찾은 곳, 집과 회사, 저장한 코스와 길이 이 기기에서 지워져요.</p>
    {:else}
      <button type="button" class="wide ghostbtn" onclick={() => (confirmReset = true)}>저장한 것 지우기</button>
    {/if}
  </section>

  <section class="card src">
    <h2>데이터 출처</h2>
    <ul class="lines">
      <li>서울특별시 건물정보와 도보 네트워크</li>
      <li>국토지리정보원 수치지형도와 연속수치지도</li>
      <li>소상공인시장진흥공단 상가정보</li>
      <li>OpenFreeMap과 OpenStreetMap 바탕 지도</li>
      <li>Copernicus GLO-30 지형</li>
    </ul>
    <p>트이길은 공공데이터로 길마다 하늘, 물, 녹지가 얼마나 보이는지 계산해요. 현장과 다를 수 있어요.</p>
  </section>
</div>

<style>
  .src .lines { font-size: 14px; color: var(--sub) }
  .danger { background: #C8483F; color: #fff }
</style>
