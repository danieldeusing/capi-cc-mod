// Card batches: the request Capi sends to the model, and the check of what comes back.

import { dueItems, newAllowance, norm } from './srs.js'
import { DEFAULT_CONFIG } from './config.js'

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

// The card prompt, built from the learner's config (lib/config.js). Fields named
// …De hold the learner's own language, whatever it is; the names stayed.
export function systemPrompt(cfg = DEFAULT_CONFIG) {
  const { learn, native } = cfg
  return `You write quiz cards for "Capi", a cheeky capybara who teaches ${learn} inside a coding tool while the developer waits.

The learner: native ${native} speaker who ${cfg.learner}. Explanations meant for the learner are in ${native}.

Every card teaches TWO things at once: one true, interesting real-world fact AND one ${learn} language item. A sentence with nothing to learn is a failure.

Truth rules, the most important part:
- Only facts you would find in mainstream reference works: encyclopedias, official statistics, textbooks. When you are not sure, pick another fact.
- Round numbers and say "about" or "more than" in the card's language; no fake precision. No superlatives ("the biggest in the world") unless they are textbook knowledge.
- No popular myths (the Great Wall visible from space, using 10% of the brain, goldfish memory). Debunking a myth makes a great card.
- "source" names a real kind of source: "IBGE", "NASA", "OMS", "Britannica", "Embrapa".

Language rules:
- ${learn} as it is spoken today. Spoken items use real colloquial forms (for Brazilian Portuguese: tô, tá, cê, né, a gente, pra, bora, rolar, dar um jeito).
- "item" is the expression being taught, written the way a learner would look it up: the infinitive for a verb phrase (e.g. "ficar de fora"), the pattern for grammar (e.g. "quando + futuro do subjuntivo").
- The card's sentence uses the item naturally.

Formats:
- "tf": the question is a statement making exactly ONE checkable claim, options are the ${learn} words for true and false (["verdade","mentira"] in Portuguese), answer 0 or 1. About a third are false; a false one is clearly false and "explain" says what is true.
- "mc": the question asks about the fact; 3 or 4 options.
- "number": the question asks for a number; 3 or 4 plausible numbers as options.
- "cloze": the sentence with the item replaced by "___"; 3 or 4 candidate fillers as options, exactly one is the item.
- "meaning": the sentence, then which ${native} meaning the item has; 3 or 4 ${native} options.
- "bonus": no quiz. A proverb from where ${learn} is spoken, an idiom with its story, or a word with a surprising origin. kind "bonus", options [], answer -1, item may be "".

Translations, so the learner can check what they read: "questionDe" is the question in ${native}, "explainDe" the explanation in ${native}, "capiRightDe" and "capiWrongDe" Capi's lines in ${native}. "optionsDe" is the options in ${native}, same order, for "mc" cards only; [] for every other format. Translate EVERYTHING into ${native}, the expression being taught included, so the learner sees what it means (for German, write "Schau mal: …" for "Saca só: …"; never leave it in ${learn}). Two exceptions, so a translation never gives the answer away: in a "meaning" card keep the item in ${learn} inside «», because its meaning is the answer, and in a "cloze" card keep the ___.

Tone: playful, warm, a bit cheeky. "capiRight" and "capiWrong" are Capi's ${learn} one-liners of at most 12 words, funny and never mean.

Reply with ONLY a JSON array. Each card:
{"kind":"spoken|grammar|vocab|bonus","topic":"short ${learn} category of the fact, 1 to 3 words, commas only, e.g. Comida, botânica or História do Brasil","format":"tf|mc|number|cloze|meaning|bonus","item":"...","de":"${native} meaning of the item","question":"...","options":["..."],"answer":0,"explain":"one or two short ${learn} sentences with the true fact","note":"in ${native}: «item» = meaning, plus one usage hint","source":"...","capiRight":"...","capiWrong":"...","questionDe":"...","optionsDe":[],"explainDe":"...","capiRightDe":"...","capiWrongDe":"..."}`
}

// The batch to ask for. queue: cards already waiting; activity: what Claude is
// busy with right now. Once today's new items are used up and nothing is due,
// the batch is bonus cards only. Cards leave the queue only when answered, so
// generation never runs ahead of the learner.
export function buildRequest({ now, state, queue, activity, total, cfg = DEFAULT_CONFIG }) {
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
      `New: ${fresh} cards with items the learner has not met. About 60% spoken everyday ${cfg.learn}, 20% grammar, 20% vocabulary.`,
    )
    if (known.length) lines.push(`Items already known, do not use: ${JSON.stringify(known)}`)
    lines.push('')
  }
  lines.push(`Bonus: ${bonus} "bonus" card${bonus > 1 ? 's' : ''}.`, '')
  lines.push(
    `Spread the facts across: ${cfg.topics}.`,
    `Calendar: when you are certain of a well-known event on this calendar date (where ${cfg.learn} is spoken first, then world history), or of something seasonal there right now, base one card on it. When you are not certain, skip this.`,
  )
  if (activity.length) {
    lines.push(
      `Right now Claude, the coding assistant, is busy with: ${activity.join(', ')}. Base one card on that moment (in Portuguese: "Enquanto o Claude…") with a ${cfg.learn} tech or work expression, and still a real fact.`,
    )
  }
  if (state.flagged.length) {
    lines.push(`Never use these facts, the learner flagged them as wrong: ${JSON.stringify(state.flagged.slice(-50))}`)
  }
  return { system: systemPrompt(cfg), prompt: lines.join('\n'), count: due.length + fresh + bonus }
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
export function translateSystem(cfg = DEFAULT_CONFIG) {
  const { learn, native } = cfg
  return `Translate one ${learn} quiz card into ${native} for a learner. Reply with ONLY a JSON object:
{"questionDe":"...","optionsDe":[],"explainDe":"...","capiRightDe":"...","capiWrongDe":"..."}
"optionsDe" holds the options in ${native}, same order, for an "mc" card only; [] otherwise. Translate EVERYTHING into ${native}, the expression being taught included, so the learner sees what it means (for German, write "Schau mal: …" for "Saca só: …"; never leave it in ${learn}). Two exceptions, so a translation never gives the answer away: in a "meaning" card keep the item in ${learn} inside «», because its meaning is the answer, and in a "cloze" card keep the ___. Leave out a field the card does not have.`
}

export function translationRequest(card, cfg = DEFAULT_CONFIG) {
  const { format, item, question, options, explain, capiRight, capiWrong } = card
  return { system: translateSystem(cfg), prompt: JSON.stringify({ format, item, question, options, explain, capiRight, capiWrong }) }
}

// The translated fields of a reply, only those that are well formed.
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

const KIND_LABELS = { spoken: 'Fala', grammar: 'Gramática', vocab: 'Vocabulário', bonus: 'Bônus' }
const QUESTION_LABELS = {
  tf: 'Verdade ou mentira',
  mc: 'Múltipla escolha',
  number: 'Chute o número',
  cloze: 'Complete a frase',
  meaning: 'O que significa',
  bonus: 'Curiosidade',
}

// The header as label and value pairs, in two lines: what the card is, and
// where the learner stands. Values carry no separators of their own: a topic's
// dots, pipes or dashes become commas.
export function headerParts(card, state) {
  const { level, known, streak, combo } = state
  const learner = [
    ['nível', level.next === null ? level.name : `${level.name} ${known}/${level.next}`],
    ['sequência', `${streak} dia${streak === 1 ? '' : 's'}`],
    ['combo', String(combo)],
  ]
  if (!card) return { card: [], learner }
  const topic = isText(card.topic) ? card.topic.trim().replace(/\s*[·|•–—]\s*|\s+-\s+/g, ', ') : ''
  const pairs = [
    ['categoria', topic],
    ['tipo', KIND_LABELS[card.kind] ?? ''],
    ['pergunta', QUESTION_LABELS[card.format] ?? ''],
  ]
  return { card: pairs.filter(([, v]) => v), learner }
}
