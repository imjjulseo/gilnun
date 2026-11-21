/** 기기에 남기는 것: 설정, 폴더(별표), 최근 검색, 집과 회사, 저장한 코스와 길.
 *  장소는 데이터 번호가 바뀌어도 남도록 이름과 좌표를 통째로 저장한다. */
import type { Place } from './places'
import type { ModeId } from './route'

export const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 저장 못 해도 동작 */ } },
  del(k: string) { try { localStorage.removeItem(k) } catch { /* */ } },
}
export const samePlace = (a: Place, b: Place) => a.id === b.id || (Math.abs(a.lon - b.lon) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6 && a.name === b.name)
const slim = (p: Place): Place => ({ id: p.id, name: p.name, sub: p.sub, lon: p.lon, lat: p.lat, addr: p.addr, floor: p.floor, cat: p.cat })
const uid = () => Math.random().toString(36).slice(2, 9)

export type ThemePick = 'system' | 'light' | 'night'
export type SkyPick = 'real' | 'day'
export interface Settings { theme: ThemePick; walk: number; sky: SkyPick; open: number; fit: boolean }
export const WALKS = [{ v: 58, label: '천천히' }, { v: 67, label: '보통' }, { v: 80, label: '빠르게' }]
export const DEFAULT_SETTINGS: Settings = { theme: 'system', walk: 67, sky: 'real', open: 30, fit: true }

export interface Folder { id: string; name: string; items: Place[] }
export type CourseStyle = 'fast' | 'fit' | 'view'
export interface SavedTrip { id: string; name: string; at: number; stops: Place[]; mode: ModeId; open: number; len: number; view: number; kind: 'course' | 'route'; style?: CourseStyle }

class Saved {
  settings = $state<Settings>({ ...DEFAULT_SETTINGS, ...store.get<Partial<Settings>>('gn.settings', {}) })
  folders = $state<Folder[]>(store.get<Folder[]>('gn.folders', [{ id: 'f0', name: '가고 싶은 곳', items: [] }]))
  recent = $state<Place[]>(store.get<Place[]>('gn.recent', []))
  home = $state<Place | null>(store.get<Place | null>('gn.home', null))
  work = $state<Place | null>(store.get<Place | null>('gn.work', null))
  trips = $state<SavedTrip[]>(store.get<SavedTrip[]>('gn.trips', []))
  seen = $state(store.get<boolean>('gn.seen', false))

  constructor() {
    // 옛 테마 값과 갈 곳 목록 옮기기
    const oldTheme = store.get<string | null>('gn.theme', null)
    if (oldTheme && !store.get('gn.settings', null)) { this.settings.theme = oldTheme as ThemePick; this.saveSettings(); store.del('gn.theme') }
    const go = store.get<Place[]>('gn.go', [])
    if (go.length) { for (const p of go) this.star(p.sub === '스팟' ? { ...p, sub: '트인 자리' } : p, 'f0', true); store.del('gn.go') }
  }
  saveSettings() { store.set('gn.settings', $state.snapshot(this.settings)) }
  setSeen(v: boolean) { this.seen = v; store.set('gn.seen', v) }

  // 폴더
  private saveFolders() { store.set('gn.folders', $state.snapshot(this.folders)) }
  foldersOf(p: Place) { return this.folders.filter((f) => f.items.some((x) => samePlace(x, p))).map((f) => f.id) }
  isStarred(p: Place) { return this.folders.some((f) => f.items.some((x) => samePlace(x, p))) }
  star(p: Place, folder = 'f0', on = true) {
    const f = this.folders.find((x) => x.id === folder); if (!f) return
    const has = f.items.some((x) => samePlace(x, p))
    if (on && !has) f.items = [slim(p), ...f.items]
    else if (!on && has) f.items = f.items.filter((x) => !samePlace(x, p))
    this.saveFolders()
  }
  unstarAll(p: Place) { for (const f of this.folders) f.items = f.items.filter((x) => !samePlace(x, p)); this.saveFolders() }
  addFolder(name: string): string {
    const id = 'f' + uid(); this.folders = [...this.folders, { id, name: name.trim().slice(0, 20) || '새 폴더', items: [] }]; this.saveFolders(); return id
  }
  renameFolder(id: string, name: string) { const f = this.folders.find((x) => x.id === id); if (f && name.trim()) { f.name = name.trim().slice(0, 20); this.saveFolders() } }
  removeFolder(id: string) { if (id === 'f0') return; this.folders = this.folders.filter((f) => f.id !== id); this.saveFolders() }

  // 최근 검색
  pushRecent(p: Place) {
    if (p.id === 'me') return
    this.recent = [slim(p), ...this.recent.filter((x) => !samePlace(x, p))].slice(0, 12); store.set('gn.recent', $state.snapshot(this.recent))
  }
  dropRecent(p: Place | null) { this.recent = p ? this.recent.filter((x) => !samePlace(x, p)) : []; store.set('gn.recent', $state.snapshot(this.recent)) }

  // 집과 회사
  setPlace(which: 'home' | 'work', p: Place | null) {
    const v = p ? slim(p) : null
    if (which === 'home') { this.home = v; store.set('gn.home', v) } else { this.work = v; store.set('gn.work', v) }
  }

  // 코스와 길
  private saveTrips() { store.set('gn.trips', $state.snapshot(this.trips)) }
  addTrip(t: Omit<SavedTrip, 'id' | 'at'>): string {
    const id = 't' + uid(); this.trips = [{ ...t, stops: t.stops.map(slim), id, at: Date.now() }, ...this.trips].slice(0, 60); this.saveTrips(); return id
  }
  renameTrip(id: string, name: string) { const t = this.trips.find((x) => x.id === id); if (t && name.trim()) { t.name = name.trim().slice(0, 30); this.saveTrips() } }
  removeTrip(id: string) { this.trips = this.trips.filter((t) => t.id !== id); this.saveTrips() }

  reset() {
    for (const k of ['gn.settings', 'gn.folders', 'gn.recent', 'gn.home', 'gn.work', 'gn.trips', 'gn.seen', 'gn.prefs', 'gn.mode', 'gn.trip', 'gn.course']) store.del(k)
    this.settings = { ...DEFAULT_SETTINGS }; this.folders = [{ id: 'f0', name: '가고 싶은 곳', items: [] }]; this.recent = []
    this.home = null; this.work = null; this.trips = []; this.seen = false
  }
}
export const saved = new Saved()
