// Card batches: the request Capi sends to the model, and the check of what comes back.

import { dueItems, newAllowance, norm } from './srs.js'

// Formats whose answer tests the language item itself; the others test the fact,
// and the learner says afterwards whether they knew the item.
export const ITEM_FORMATS = new Set(['cloze', 'meaning'])
const QUIZ_FORMATS = new Set(['tf', 'mc', 'number', 'cloze', 'meaning'])
const KINDS = new Set(['spoken', 'grammar', 'vocab'])
const AVOID_LIMIT = 400
const BONUS_ONLY = 3

export const SYSTEM = `You write quiz cards for "Capi", a cheeky capybara who teaches Brazilian Portuguese inside a coding tool while the developer waits.

The learner: native German speaker, has lived in Brazil for four years, gets by in everyday Portuguese (about A2/B1) but has real gaps, above all in grammar. Explanations meant for him are in German.

Every card teaches TWO things at once: one true, interesting real-world fact AND one Portuguese language item. A sentence with nothing to learn is a failure.

Truth rules, the most important part:
- Only facts you would find in mainstream reference works: encyclopedias, official statistics, textbooks. When you are not sure, pick another fact.
- Round numbers and say "cerca de" or "mais de"; no fake precision. No superlatives ("o maior do mundo") unless they are textbook knowledge.
- No popular myths (the Great Wall visible from space, using 10% of the brain, goldfish memory). Debunking a myth makes a great card.
- "source" names a real kind of source: "IBGE", "NASA", "OMS", "Britannica", "Embrapa".

Language rules:
- Portuguese as it is spoken in Brazil today. Spoken items use real colloquial forms: tô, tá, cê, né, a gente, pra, bora, rolar, dar um jeito.
- "item" is the expression being taught, written the way a learner would look it up: the infinitive for a verb phrase ("ficar de fora"), the pattern for grammar ("quando + futuro do subjuntivo").
- The card's sentence uses the item naturally.

Formats:
- "tf": the question is a statement, options ["verdade","mentira"], answer 0 or 1. About a third are false; a false one is clearly false and "explain" says what is true.
- "mc": the question asks about the fact; 3 or 4 options.
- "number": the question asks for a number; 3 or 4 plausible numbers as options.
- "cloze": the sentence with the item replaced by "___"; 3 or 4 candidate fillers as options, exactly one is the item.
- "meaning": the sentence, then which German meaning the item has; 3 or 4 German options.
- "bonus": no quiz. A Brazilian proverb, an idiom with its story, or a word with a surprising origin. kind "bonus", options [], answer -1, item may be "".

Tone: playful, warm, a bit cheeky. "capiRight" and "capiWrong" are Capi's Portuguese one-liners of at most 12 words, funny and never mean.

Reply with ONLY a JSON array. Each card:
{"kind":"spoken|grammar|vocab|bonus","topic":"...","format":"tf|mc|number|cloze|meaning|bonus","item":"...","de":"German meaning of the item","question":"...","options":["..."],"answer":0,"explain":"one or two short Portuguese sentences with the true fact","note":"in German: «item» = meaning, plus one usage hint","source":"...","capiRight":"...","capiWrong":"..."}`

// The batch to ask for. queue: cards already waiting; activity: what Claude is
// busy with right now. Once today's new items are used up and nothing is due,
// the batch is bonus cards only. Cards leave the queue only when answered, so
// generation never runs ahead of the learner.
export function buildRequest({ now, state, queue, activity, total }) {
  const queued = new Set(queue.map((c) => norm(c.item)))
  const due = dueItems(state, now)
    .filter((it) => !queued.has(norm(it.item)))
    .slice(0, total - 1)
  const queuedNew = queue.filter((c) => c.kind !== 'bonus' && !state.items.has(norm(c.item))).length
  const fresh = Math.min(newAllowance(state, queuedNew), total - due.length - 1)
  const bonus = due.length + fresh === 0 ? BONUS_ONLY : 1

  const date = new Date(now).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const known = [...state.items.values()].map((it) => it.item).slice(-AVOID_LIMIT)
  const lines = [`Today is ${date}. Write ${due.length + fresh + bonus} cards.`, '']

  if (due.length) {
    lines.push(
      `Review: one card for each item below. The learner has met these before, so write a NEW fact and use the format given.`,
    )
    for (const it of due) lines.push(`- "${it.item}" (${it.de}) → format ${formatFor(it)}`)
    lines.push('')
  }
  if (fresh) {
    lines.push(
      `New: ${fresh} cards with items the learner has not met. About 60% spoken Brazilian, 20% grammar, 20% vocabulary.`,
    )
    if (known.length) lines.push(`Items already known, do not use: ${JSON.stringify(known)}`)
    lines.push('')
  }
  lines.push(`Bonus: ${bonus} "bonus" card${bonus > 1 ? 's' : ''}.`, '')
  lines.push(
    'Spread the facts across Brazil, science and nature, technology, history (Brazil and the world), everyday life, food, health and fitness.',
    `Calendar: when you are certain of a well-known event on this calendar date (Brazil first, then world history), or of something seasonal in Brazil right now, base one card on it. When you are not certain, skip this.`,
  )
  if (activity.length) {
    lines.push(
      `Right now Claude, the coding assistant, is busy with: ${activity.join(', ')}. Base one card on that moment ("Enquanto o Claude…") with a Portuguese tech or work expression, and still a real fact.`,
    )
  }
  if (state.flagged.length) {
    lines.push(`Never use these facts, the learner flagged them as wrong: ${JSON.stringify(state.flagged.slice(-50))}`)
  }
  return { system: SYSTEM, prompt: lines.join('\n'), count: due.length + fresh + bonus }
}

// A missed item comes back in the other language format, so the answer cannot
// be remembered by position. The model picks the format for everything else.
function formatFor(it) {
  if (!it.lastMiss) return 'any quiz format'
  return it.lastFormat === 'cloze' ? 'meaning' : 'cloze'
}

// The usable cards in a model reply, and how many were dropped.
export function parseCards(text, now) {
  const s = String(text ?? '')
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  let raw = []
  try {
    raw = start >= 0 && end > start ? JSON.parse(s.slice(start, end + 1)) : []
  } catch {
    raw = []
  }
  if (!Array.isArray(raw)) raw = []
  const cards = raw.filter(isCard).map((c, i) => ({ ...c, id: `${now.toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}` }))
  return { cards, dropped: raw.length - cards.length }
}

function isText(v) {
  return typeof v === 'string' && v.trim() !== ''
}

function isCard(c) {
  if (!c || typeof c !== 'object' || !isText(c.question) || !isText(c.explain)) return false
  if (c.format === 'bonus') return c.kind === 'bonus' && isText(c.note)
  if (!QUIZ_FORMATS.has(c.format) || !KINDS.has(c.kind)) return false
  if (!isText(c.item) || !isText(c.de) || !isText(c.note) || !isText(c.source)) return false
  if (!Array.isArray(c.options) || !c.options.every(isText)) return false
  const n = c.options.length
  if (c.format === 'tf' ? n !== 2 : n < 3 || n > 4) return false
  return Number.isInteger(c.answer) && c.answer >= 0 && c.answer < n
}
