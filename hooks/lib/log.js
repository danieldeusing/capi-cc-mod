// The answer log as JSON lines: one file per Mac and month in iCloud Drive,
// merged on read. A month stays far below the 4 MiB a mod may read or write.

import { dayOf } from './srs.js'

export function monthFile(machine, t) {
  return `${machine}-${dayOf(t).slice(0, 7)}.jsonl`
}

export function parseJsonl(text) {
  const entries = []
  let bad = 0
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.id === 'string' && typeof e.t === 'number' && typeof e.type === 'string') entries.push(e)
      else bad += 1
    } catch {
      bad += 1
    }
  }
  return { entries, bad }
}

export function toJsonl(entries) {
  return entries.map((e) => JSON.stringify(e) + '\n').join('')
}

// Union of every list, one entry per id, oldest first.
export function merge(...lists) {
  const byId = new Map()
  for (const list of lists) for (const e of list) byId.set(e.id, e)
  return [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
