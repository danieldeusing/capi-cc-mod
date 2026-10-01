// Spaced repetition over the answer log. The log is the truth; this module only
// replays it, so two sessions or two Macs can never disagree about a score.

const MINUTE = 60_000
const DAY = 86_400_000

// Leitner boxes: days until an item in that box is due again.
export const INTERVAL_DAYS = [0, 1, 3, 7, 30, 90]
export const MAX_BOX = 5
export const KNOWN_BOX = 3
// The first week is placement: an item already known jumps straight to box 4.
export const PLACEMENT_DAYS = 7
export const PLACEMENT_BOX = 4
// A miss comes back the same day, in another format (the payback round).
export const PAYBACK_MINUTES = 20
export const NEW_PER_DAY = 10

export const LEVELS = [
  [0, 'Turista'],
  [50, 'Gringo'],
  [150, 'Gringo esperto'],
  [300, 'Quase brasileiro'],
  [600, 'Brasileiro de coração'],
]

// YYYY-MM-DD in local time, built by hand: the hooks runtime may have no locale data.
export function dayOf(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function norm(item) {
  return String(item ?? '')
    .toLowerCase()
    .replace(/[«»"“”'.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function levelFor(known) {
  let i = 0
  while (i + 1 < LEVELS.length && known >= LEVELS[i + 1][0]) i++
  return { name: LEVELS[i][1], next: LEVELS[i + 1]?.[0] ?? null }
}

// Replays every log entry, oldest first. Answer entries for the same card count
// once, so a card answered in two sessions at the same moment is one answer.
export function replay(entries, now) {
  const items = new Map()
  const answeredCards = new Set()
  const flagged = []
  const days = new Set()
  let firstT = null
  let combo = 0
  let bestCombo = 0
  let points = 0

  for (const e of entries) {
    if (e.type === 'flag') {
      flagged.push(e.fact)
      continue
    }
    if (e.type !== 'answer' || answeredCards.has(e.cardId)) continue
    answeredCards.add(e.cardId)
    firstT ??= e.t
    days.add(dayOf(e.t))

    if (e.quiz === true) {
      combo += 1
      points += 10 + 2 * Math.min(combo - 1, 5)
      bestCombo = Math.max(bestCombo, combo)
    } else if (e.quiz === false) {
      combo = 0
    }

    if (!e.grade || !norm(e.item)) continue
    const key = norm(e.item)
    let it = items.get(key)
    const isNew = !it
    if (isNew) {
      it = { item: e.item, de: e.de, kind: e.kind, box: 1, due: e.t, firstT: e.t, misses: 0 }
      items.set(key, it)
    }
    it.lastFormat = e.format
    if (e.grade === 'ok') {
      const placing = isNew && e.t - firstT < PLACEMENT_DAYS * DAY
      it.box = placing ? PLACEMENT_BOX : Math.min(it.box + 1, MAX_BOX)
      it.due = e.t + INTERVAL_DAYS[it.box] * DAY
      it.lastMiss = false
    } else {
      it.box = 1
      it.misses += 1
      it.due = e.t + PAYBACK_MINUTES * MINUTE
      it.lastMiss = true
    }
  }

  const today = dayOf(now)
  let todayNew = 0
  let known = 0
  for (const it of items.values()) {
    if (dayOf(it.firstT) === today) todayNew += 1
    if (it.box >= KNOWN_BOX) known += 1
  }
  return {
    items,
    flagged,
    known,
    learning: items.size - known,
    todayNew,
    streak: streakOf(days, now),
    combo,
    bestCombo,
    points,
    level: levelFor(known),
  }
}

// Days in a row with at least one answer, ending today, or yesterday when
// today has none yet.
function streakOf(days, now) {
  let t = days.has(dayOf(now)) ? now : now - DAY
  let n = 0
  while (days.has(dayOf(t))) {
    n += 1
    t -= DAY
  }
  return n
}

export function dueItems(state, now) {
  return [...state.items.values()].filter((it) => it.due <= now).sort((a, b) => a.due - b.due)
}

// New items still allowed today, counting the ones already waiting in the queue.
export function newAllowance(state, queuedNew) {
  return Math.max(0, NEW_PER_DAY - state.todayNew - queuedNew)
}
