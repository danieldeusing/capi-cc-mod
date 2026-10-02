// The cells a string takes on screen: an emoji two, a variation selector or
// joiner none. ponytail: no full East Asian width table; the band's text is
// Latin, emoji and flags.
export function cells(str) {
  let n = 0
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0)
    if (c === 0xfe0f || c === 0x200d || (c >= 0x300 && c < 0x370)) continue
    n += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1
  }
  return n
}
