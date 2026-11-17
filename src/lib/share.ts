/** 공유: 링크에 코스를 담고, 컨셉에 맞게 코스를 그린 이미지를 만든다. */
import type { Place } from './places'
import type { ModeId } from './route'

// ---- 링크. ?c=<base64url(JSON)>
// v2: {v:2, m:길 종류, o:트인 정도, n:이름, s:[[이름, 경도, 위도, 업종, 표시]]}  표시 's'는 트인 자리
// v1(예전 갈 곳): {v:1, m, g:[...]} 도 읽는다
export interface SharedTrip { mode: ModeId; open: number; name: string; stops: Place[] }
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (c: string) => new TextDecoder().decode(Uint8Array.from(atob(c.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)))
export function tripUrl(t: SharedTrip): string {
  const s = t.stops.filter((p) => p.id !== 'me').map((p) => [p.name.slice(0, 40), +p.lon.toFixed(6), +p.lat.toFixed(6), p.cat, p.sub === '트인 자리' ? 's' : ''])
  return `${location.origin}${location.pathname}?c=${b64(JSON.stringify({ v: 2, m: t.mode, o: Math.round(t.open), n: t.name.slice(0, 30), s }))}`
}
export function readTripUrl(search = location.search): SharedTrip | null {
  const c = new URLSearchParams(search).get('c'); if (!c) return null
  try {
    const j = JSON.parse(unb64(c)), rows = (j.v === 1 ? j.g : j.s) as [string, number, number, number, string][]
    const stops: Place[] = rows.slice(0, 8).map((r, i) => ({ id: `sh${i}-${r[1]},${r[2]}`, name: String(r[0]).slice(0, 60), lon: +r[1], lat: +r[2], cat: Number.isInteger(r[3]) ? r[3] : -1, sub: r[4] === 's' ? '트인 자리' : '', addr: '', floor: null }))
    if (!stops.length || !stops.every((p) => isFinite(p.lon) && isFinite(p.lat))) return null
    const mode: ModeId = ['fast', 'balance', 'view'].includes(j.m) ? j.m : 'balance'
    return { mode, open: Number.isFinite(j.o) ? Math.max(0, Math.min(100, j.o)) : 30, name: typeof j.n === 'string' ? j.n : '', stops }
  } catch { return null }
}

// ---- 이미지
export type Concept = 'sky' | 'dusk' | 'star'
export const CONCEPTS: { id: Concept; label: string }[] = [{ id: 'sky', label: '하늘' }, { id: 'dusk', label: '노을' }, { id: 'star', label: '별빛' }]
export interface ShareArt {
  title: string
  stops: { name: string; lon: number; lat: number }[]
  path: [number, number][][]                      // 걷는 선 조각들
  context: { coords: [number, number][]; kind: string }[]   // 바탕으로 옅게 깔 길
  minutes: number; meters: number; view: number   // view: 트인 구간 비율 0~1
}
interface Look { bg: [string, string, string]; net: string; netK: string; netW: string; netG: string; line: [string, string]; glow: string; ink: string; sub: string; card: string; pin: string; pinInk: string; title: string }
const LOOKS: Record<Concept, Look> = {
  sky: { bg: ['#DFF1FD', '#F4FAFF', '#FFFFFF'], net: 'rgba(40,70,110,0.10)', netK: 'rgba(77,184,238,0.30)', netW: 'rgba(43,61,140,0.25)', netG: 'rgba(79,174,104,0.25)', line: ['#3CB0EC', '#1D64D8'], glow: 'rgba(29,100,216,0.35)', ink: '#16202B', sub: '#55616E', card: 'rgba(255,255,255,0.92)', pin: '#1D64D8', pinInk: '#FFFFFF', title: '하늘 코스' },
  dusk: { bg: ['#FFB48A', '#FBD9C2', '#FFF3EA'], net: 'rgba(110,50,40,0.10)', netK: 'rgba(236,136,99,0.35)', netW: 'rgba(120,60,110,0.25)', netG: 'rgba(130,120,70,0.22)', line: ['#FFB25E', '#D9534A'], glow: 'rgba(217,83,74,0.40)', ink: '#3A1D1A', sub: '#7A4C44', card: 'rgba(255,248,242,0.92)', pin: '#C8483F', pinInk: '#FFFFFF', title: '노을 코스' },
  star: { bg: ['#0C1030', '#1A1F4A', '#2B2860'], net: 'rgba(200,205,255,0.10)', netK: 'rgba(160,150,240,0.30)', netW: 'rgba(110,120,230,0.25)', netG: 'rgba(90,180,140,0.22)', line: ['#FFE9A8', '#C9BEFF'], glow: 'rgba(255,233,168,0.55)', ink: '#F5EFE7', sub: '#B4BAD0', card: 'rgba(20,24,58,0.88)', pin: '#FFE9A8', pinInk: '#1A1420', title: '별빛 코스' },
}
export const conceptTitle = (c: Concept) => LOOKS[c].title

export async function drawShare(cv: HTMLCanvasElement, a: ShareArt, concept: Concept) {
  const W = 1080, H = 1350, L = LOOKS[concept]
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  try { await Promise.all([document.fonts.load('700 40px "Noto Sans KR"'), document.fonts.load('400 40px "Noto Sans KR"'), document.fonts.load('40px "Gowun Dodum"')]) } catch { /* 글꼴이 없으면 기본 글꼴 */ }
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, L.bg[0]); g.addColorStop(0.55, L.bg[1]); g.addColorStop(1, L.bg[2])
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  const rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) })()
  if (concept === 'star') for (let i = 0; i < 220; i++) { ctx.fillStyle = `rgba(255,245,220,${0.15 + rnd() * 0.6})`; ctx.beginPath(); ctx.arc(rnd() * W, rnd() * H * 0.95, rnd() * 2.2 + 0.4, 0, 7); ctx.fill() }
  if (concept === 'dusk') { const sg = ctx.createRadialGradient(W * 0.8, 150, 10, W * 0.8, 150, 420); sg.addColorStop(0, 'rgba(255,240,200,0.95)'); sg.addColorStop(0.18, 'rgba(255,200,140,0.6)'); sg.addColorStop(1, 'rgba(255,180,138,0)'); ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H) }
  if (concept === 'sky') { const sg = ctx.createRadialGradient(W * 0.2, 60, 10, W * 0.2, 60, 600); sg.addColorStop(0, 'rgba(255,255,255,0.9)'); sg.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H) }

  // 지도 틀: 코스가 위쪽 900px 안에 들어오게
  const pts = [...a.path.flat(), ...a.stops.map((s) => [s.lon, s.lat] as [number, number])]
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  const kx = Math.cos(((y0 + y1) / 2) * Math.PI / 180)
  const box = { l: 90, t: 150, w: W - 180, h: 760 }
  const sw = Math.max((x1 - x0) * kx, 1e-5), sh = Math.max(y1 - y0, 1e-5)
  const sc = Math.min(box.w / sw, box.h / sh)
  const ox = box.l + (box.w - sw * sc) / 2, oy = box.t + (box.h - sh * sc) / 2
  const P = (lon: number, lat: number): [number, number] => [ox + (lon - x0) * kx * sc, oy + (y1 - lat) * sc]
  const inFrame = ([x, y]: [number, number]) => x > -40 && x < W + 40 && y > -40 && y < 1000
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const c of a.context) {
    const q = c.coords.map(([x, y]) => P(x, y)); if (!q.some(inFrame)) continue
    ctx.strokeStyle = c.kind === 'k' ? L.netK : c.kind === 'w' ? L.netW : c.kind === 'g' ? L.netG : L.net
    ctx.lineWidth = c.kind === 'n' ? 3 : 5
    ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke()
  }
  // 위쪽이 아래로 옅어지게
  const fade = ctx.createLinearGradient(0, 930, 0, 1010); fade.addColorStop(0, L.bg[2] + '00'); fade.addColorStop(1, L.bg[2])
  ctx.fillStyle = fade; ctx.fillRect(0, 940, W, 80)

  // 코스 선
  const lines = a.path.map((seg) => seg.map(([x, y]) => P(x, y)))
  const stroke = (w: number, style: string | CanvasGradient, blur = 0, color = '') => {
    ctx.save(); ctx.lineWidth = w; ctx.strokeStyle = style; if (blur) { ctx.shadowBlur = blur; ctx.shadowColor = color }
    for (const q of lines) { ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke() }
    ctx.restore()
  }
  const lg = ctx.createLinearGradient(box.l, box.t, box.l + box.w, box.t + box.h); lg.addColorStop(0, L.line[0]); lg.addColorStop(1, L.line[1])
  stroke(34, L.glow, 40, L.glow)
  stroke(22, lg)
  stroke(6, concept === 'star' ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)')
  if (concept === 'star') {
    for (const q of lines) for (let i = 0; i < q.length; i += 3) {
      const [x, y] = q[i]; if (rnd() > 0.45) continue
      const r = 3 + rnd() * 5; ctx.save(); ctx.translate(x + (rnd() - 0.5) * 30, y + (rnd() - 0.5) * 30); ctx.fillStyle = '#FFF6D8'; ctx.shadowBlur = 14; ctx.shadowColor = '#FFE9A8'
      ctx.beginPath(); for (let k = 0; k < 8; k++) { const rr = k % 2 ? r * 0.28 : r; ctx.lineTo(Math.cos((k * Math.PI) / 4) * rr, Math.sin((k * Math.PI) / 4) * rr) } ctx.fill(); ctx.restore()
    }
  }
  // 들르는 곳
  ctx.textBaseline = 'middle'
  a.stops.forEach((s, i) => {
    const [x, y] = P(s.lon, s.lat)
    ctx.save(); ctx.shadowBlur = 12; ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.fillStyle = L.pin; ctx.beginPath(); ctx.arc(x, y, 30, 0, 7); ctx.fill(); ctx.restore()
    ctx.lineWidth = 6; ctx.strokeStyle = concept === 'star' ? '#1A1F4A' : '#FFFFFF'; ctx.beginPath(); ctx.arc(x, y, 30, 0, 7); ctx.stroke()
    ctx.fillStyle = L.pinInk; ctx.font = '700 30px "Noto Sans KR", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, y + 1)
    const name = s.name.length > 12 ? s.name.slice(0, 11) + '…' : s.name
    ctx.font = '700 28px "Noto Sans KR", sans-serif'; const tw = ctx.measureText(name).width
    const right = x + 44 + tw + 28 < W - 30, lx = right ? x + 44 : x - 44 - tw - 28
    ctx.fillStyle = L.card; roundRect(ctx, lx, y - 26, tw + 28, 52, 26); ctx.fill()
    ctx.fillStyle = L.ink; ctx.textAlign = 'left'; ctx.fillText(name, lx + 14, y + 1)
  })
  // 위쪽 머리말
  ctx.textAlign = 'left'; ctx.fillStyle = L.ink; ctx.font = '52px "Gowun Dodum", "Noto Sans KR", sans-serif'; ctx.fillText('트이길', 80, 92)
  ctx.font = '500 30px "Noto Sans KR", sans-serif'; ctx.fillStyle = L.sub; ctx.textAlign = 'right'; ctx.fillText(L.title, W - 80, 94)
  // 아래 정보 카드
  const cy = 1010
  ctx.fillStyle = L.card; roundRect(ctx, 60, cy, W - 120, H - cy - 60, 40); ctx.fill()
  ctx.textAlign = 'left'; ctx.fillStyle = L.ink; ctx.font = '700 46px "Noto Sans KR", sans-serif'
  ctx.fillText(clip(ctx, a.title, W - 220), 110, cy + 70)
  const t = a.minutes < 60 ? `${a.minutes}분` : `${Math.floor(a.minutes / 60)}시간${a.minutes % 60 ? ` ${a.minutes % 60}분` : ''}`
  const km = a.meters < 1000 ? `${Math.round(a.meters / 10) * 10}m` : `${(a.meters / 1000).toFixed(1)}km`
  ctx.font = '500 32px "Noto Sans KR", sans-serif'; ctx.fillStyle = L.sub
  ctx.fillText(`걸어서 ${t}, ${km}${a.view > 0.05 ? `, 트인 구간 ${Math.round(a.view * 100)}%` : ''}`, 110, cy + 130)
  ctx.font = '400 28px "Noto Sans KR", sans-serif'; ctx.fillStyle = L.ink
  ctx.fillText(clip(ctx, a.stops.map((s, i) => `${i + 1} ${s.name}`).join('   '), W - 220), 110, cy + 190)
  ctx.font = '400 22px "Noto Sans KR", sans-serif'; ctx.fillStyle = L.sub; ctx.textAlign = 'right'
  ctx.fillText('imjjulseo.github.io/gilnun', W - 110, cy + 248)
}
function clip(ctx: CanvasRenderingContext2D, s: string, w: number) { if (ctx.measureText(s).width <= w) return s; let t = s; while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…' }
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
