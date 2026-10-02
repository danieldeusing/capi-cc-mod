// Card batches: the request Capi sends to the model, and the check of what comes back.

import { dueItems, newAllowance, norm } from './srs.js'

// Formats whose answer tests the language item itself; the others test the fact,
// and the learner says afterwards whether they knew the item.
export const ITEM_FORMATS = new Set(['cloze', 'meaning'])
const QUIZ_FORMATS = new Set(['tf', 'mc', 'number', 'cloze', 'meaning'])
const KINDS = new Set(['spoken', 'grammar', 'vocab'])
const AVOID_LIMIT = 400
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const WRAPPERS = new Set(['sudo', 'env', 'export', 'time', 'nohup', 'exec'])

// What Claude is doing, safe to put in a prompt: a tool's name, or a shell
// command's program and subcommand. Assignments, paths and arguments, which
// is where a secret would be, never get through.
export function activityHint(tool, command) {
  if (tool !== 'Bash') return /^[\w-]+$/.test(tool ?? '') ? tool : ''
  const words = String(command ?? '').trim().split(/\s+/).filter((w) => !w.includes('='))
  while (WRAPPERS.has(words[0])) words.shift()
  const program = (words[0] ?? '').split('/').pop()
  if (!/^[\w.-]+$/.test(program)) return ''
  return /^[a-z][a-z0-9-]*$/.test(words[1] ?? '') ? `${program} ${words[1]}` : program
}

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
- "tf": the question is a statement making exactly ONE checkable claim, options ["verdade","mentira"], answer 0 or 1. About a third are false; a false one is clearly false and "explain" says what is true.
- "mc": the question asks about the fact; 3 or 4 options.
- "number": the question asks for a number; 3 or 4 plausible numbers as options.
- "cloze": the sentence with the item replaced by "___"; 3 or 4 candidate fillers as options, exactly one is the item.
- "meaning": the sentence, then which German meaning the item has; 3 or 4 German options.
- "bonus": no quiz. A Brazilian proverb, an idiom with its story, or a word with a surprising origin. kind "bonus", options [], answer -1, item may be "".

Translations, so the learner can check what he read: "questionDe" is the question in German, "explainDe" the explanation in German, "capiRightDe" and "capiWrongDe" Capi's lines in German. "optionsDe" is the options in German, same order, for "mc" cards only; [] for every other format. Translate EVERYTHING into German, the expression being taught included, so the learner sees what it means (write "Schau mal: …" for "Saca só: …", never leave it in Portuguese). Two exceptions, so a translation never gives the answer away: in a "meaning" card keep the item in Portuguese inside «», because its meaning is the answer, and in a "cloze" card keep the ___.

Tone: playful, warm, a bit cheeky. "capiRight" and "capiWrong" are Capi's Portuguese one-liners of at most 12 words, funny and never mean.

Reply with ONLY a JSON array. Each card:
{"kind":"spoken|grammar|vocab|bonus","topic":"...","format":"tf|mc|number|cloze|meaning|bonus","item":"...","de":"German meaning of the item","question":"...","options":["..."],"answer":0,"explain":"one or two short Portuguese sentences with the true fact","note":"in German: «item» = meaning, plus one usage hint","source":"...","capiRight":"...","capiWrong":"...","questionDe":"...","optionsDe":[],"explainDe":"...","capiRightDe":"...","capiWrongDe":"..."}`

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
  // Bonus-only batches are full size: a call costs about the same for 3 cards or 10.
  const bonus = due.length + fresh === 0 ? total : 1

  const d = new Date(now)
  const date = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`
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
  if (![c.item, c.de, c.note, c.source, c.capiRight, c.capiWrong].every(isText)) return false
  if (!Array.isArray(c.options) || !c.options.every(isText)) return false
  const n = c.options.length
  if (c.format === 'tf' ? n !== 2 : n < 3 || n > 4) return false
  return Number.isInteger(c.answer) && c.answer >= 0 && c.answer < n
}

// The German lines the translation toggle shows for a card at its stage. A card
// made before translations existed has none, and then there is no toggle.
export function germanLines(card, stage, quizOk) {
  const lines = []
  if (card.format === 'bonus' || stage === 'quiz') lines.push(card.questionDe)
  if (stage === 'quiz' && card.format === 'mc' && Array.isArray(card.optionsDe) && card.optionsDe.length === card.options.length) {
    lines.push(card.optionsDe.map((o, i) => `${i + 1}: ${o}`).join(' · '))
  }
  if (stage === 'reveal' && card.format !== 'bonus') lines.push(quizOk ? card.capiRightDe : card.capiWrongDe)
  if (card.format === 'bonus' || stage === 'reveal') lines.push(card.explainDe)
  return lines.filter(isText)
}

// For a card made before translations existed: one small request when the
// learner opens 🇩🇪 on it, under the same rules the card batches follow.
export const TRANSLATE_SYSTEM = `Translate one Brazilian Portuguese quiz card into German for a learner. Reply with ONLY a JSON object:
{"questionDe":"...","optionsDe":[],"explainDe":"...","capiRightDe":"...","capiWrongDe":"..."}
"optionsDe" holds the options in German, same order, for an "mc" card only; [] otherwise. Translate EVERYTHING into German, the expression being taught included, so the learner sees what it means (write "Schau mal: …" for "Saca só: …", never leave it in Portuguese). Two exceptions, so a translation never gives the answer away: in a "meaning" card keep the item in Portuguese inside «», because its meaning is the answer, and in a "cloze" card keep the ___. Leave out a field the card does not have.`

export function translationRequest(card) {
  const { format, item, question, options, explain, capiRight, capiWrong } = card
  return { system: TRANSLATE_SYSTEM, prompt: JSON.stringify({ format, item, question, options, explain, capiRight, capiWrong }) }
}

// The German fields of a reply, only those that are well formed.
export function parseTranslation(text) {
  const s = String(text ?? '')
  let raw = null
  try {
    raw = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
  } catch {
    return {}
  }
  const out = {}
  for (const k of ['questionDe', 'explainDe', 'capiRightDe', 'capiWrongDe']) if (isText(raw?.[k])) out[k] = raw[k]
  if (Array.isArray(raw?.optionsDe) && raw.optionsDe.every(isText)) out.optionsDe = raw.optionsDe
  return out
}
