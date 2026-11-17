/** 받침에 맞는 조사 */
function jong(s: string): number {
  const c = s.trim().slice(-1); if (!c) return 0
  const code = c.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28
  if (/[0-9]/.test(c)) return [1, 1, 0, 1, 0, 0, 1, 1, 1, 0][+c] ? 1 : 0   // 영 일 삼 육 칠 팔은 받침
  return 0
}
export const eul = (s: string) => s + (jong(s) ? '을' : '를')
export const iga = (s: string) => s + (jong(s) ? '이' : '가')
export const ro = (s: string) => { const j = jong(s); return s + (j && j !== 8 ? '으로' : '로') }
export const eun = (s: string) => s + (jong(s) ? '은' : '는')
