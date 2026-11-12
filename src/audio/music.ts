export const NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b']
export const noteName = (m: number) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1)
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
export const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}
