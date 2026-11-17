/** 장소 데이터(상가정보)와 검색, 공유 글자 읽기. */
export interface PoiData { cats: string[]; subs: string[]; rows: [string, number, number, number, number, number, number | null][] }
export interface AddrData { addrs: string[]; pts: [number, number][] }
export interface Place { id: string; name: string; sub: string; lon: number; lat: number; addr: string; floor: number | null; cat: number }
export const CAT_LABEL = ['음식점', '카페와 디저트', '술집', '편의점']

export class Places {
  list: Place[]
  addrIdx = new Map<string, number>()
  constructor(public poi: PoiData, public addr: AddrData) {
    addr.addrs.forEach((a, i) => this.addrIdx.set(a.replace(/\s/g, ''), i))
    this.list = poi.rows.map((r, i) => ({ id: 'q' + i, name: r[0], cat: r[1], sub: poi.subs[r[2]].replace(/\//g, ', '), lon: r[3], lat: r[4], addr: r[5] >= 0 ? addr.addrs[r[5]] : '', floor: r[6] }))
  }
  /** 이름 검색. 빈칸과 대소문자를 무시한다. */
  search(q: string, cat: number | null): Place[] {
    const n = norm(q)
    return this.list.filter((p) => (cat === null || p.cat === cat) && (!n || norm(p.name).includes(n)))
  }
  nearest(lon: number, lat: number, maxM: number): Place | null {
    let best: Place | null = null, bd = maxM
    for (const p of this.list) { const d = meters([lon, lat], [p.lon, p.lat]); if (d < bd) { bd = d; best = p } }
    return best
  }
  nearestAddr(lon: number, lat: number, maxM: number): string | null {
    let best = -1, bd = maxM
    this.addr.pts.forEach((p, i) => { const d = meters([lon, lat], p); if (d < bd) { bd = d; best = i } })
    return best >= 0 ? this.addr.addrs[best] : null
  }
  /** 공유 글자에서 이름과 주소를 읽어 장소를 찾는다. */
  fromShare(text: string): { place: Place | null; name: string; addr: string; found: 'shop' | 'addr' | 'none' } | null {
    // 링크와 [네이버지도], [카카오맵] 같은 꼬리표는 줄 안에 있어도 지운다
    const lines = text.split(/\r?\n/).map((l) => l.replace(/https?:\/\/\S+/g, '').replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean)
    const a = lines.map(addrKey).find(Boolean)
    if (!a) {
      // 카카오맵처럼 이름만 오는 경우: 이름으로 찾는다
      const name = lines[0] ?? ''; if (!name) return null
      const nn = norm(name), hit = this.list.filter((p) => norm(p.name) === nn)
      const part = hit.length ? hit : this.list.filter((p) => norm(p.name).includes(nn) || (norm(p.name).length >= 3 && nn.includes(norm(p.name))))
      return { place: part[0] ?? null, name, addr: '', found: part.length ? 'shop' : 'none' }
    }
    const name = lines.find((l) => !addrKey(l)) ?? ''
    const ai = this.addrIdx.get(a.replace(/\s/g, ''))
    const same = this.list.filter((p) => p.addr.replace(/\s/g, '') === a.replace(/\s/g, ''))
    if (same.length) {
      const nn = norm(name), score = (p: Place) => { const pn = norm(p.name); return pn === nn ? 3 : pn.includes(nn) || nn.includes(pn) ? 2 : common(pn, nn) }
      const best = same.sort((x, y) => score(y) - score(x))[0]
      if (score(best) >= 1.5) return { place: best, name, addr: a, found: 'shop' }
    }
    if (ai !== undefined) {
      const [lon, lat] = this.addr.pts[ai]
      return { place: { id: 'a' + ai, name: name || a, sub: '', lon, lat, addr: a, floor: floorOf(text), cat: -1 }, name, addr: a, found: 'addr' }
    }
    return { place: null, name, addr: a, found: 'none' }
  }
}
export const norm = (s: string) => s.toLowerCase().replace(/[\s·.\-_()]/g, '')
function common(a: string, b: string) { let n = 0; for (const ch of new Set(b)) if (a.includes(ch)) n++; return b.length ? (n / b.length) * 1.4 : 0 }
/** '서울 동작구 노량진로 100 2층' -> '노량진로 100' */
export function addrKey(s: string): string | null {
  const m = s.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/)
  return m && /(시|구|동|로|길)\s/.test(s) ? `${m[1]} ${m[2]}` : null
}
function floorOf(s: string): number | null { const m = s.match(/(지하\s*)?(\d+)\s*층/); return m ? (m[1] ? -1 : 1) * +m[2] : null }
export function looksShared(s: string) { return /\n/.test(s.trim()) || /naver\.me|kko\.to|kakao|네이버지도|카카오맵/i.test(s) }
export const meters = (a: [number, number], b: [number, number]) => {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)
}
export const floorText = (f: number | null) => (f === null ? '' : f < 0 ? `지하 ${-f}층` : `${f}층`)
