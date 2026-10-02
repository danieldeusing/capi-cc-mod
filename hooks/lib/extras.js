// 📐 grammar notes and 🔤 conjugations for a card's sentence, asked for when
// the learner opens them and then kept on the card.

import { DEFAULT_CONFIG } from './config.js'

const isText = (v) => typeof v === 'string' && v.trim() !== ''

const NO_GIVEAWAY = `If the sentence contains ___, it is a gap the learner must fill: never fill it, never name or hint at the missing word. If the card is a "meaning" card, never explain what the item in «» means.`

export function grammarSystem(cfg = DEFAULT_CONFIG) {
  return `You explain the grammar of one ${cfg.learn} sentence to a native ${cfg.native} speaker who ${cfg.learner}. Reply with ONLY a JSON object: {"grammarDe":["...", "..."]}
2 to 5 notes in ${cfg.native}, each one short line (at most 140 characters), about what is actually in this sentence: prepositions and contractions and the ${cfg.native} case they do the job of (for German, e.g. «do caju» = de + o, wie ein Genitiv), pronoun placement, word order, tense and mood choices (subjunctive!), colloquial forms. Compare with ${cfg.native} where it helps. ${NO_GIVEAWAY}`
}

export function conjugationSystem(cfg = DEFAULT_CONFIG) {
  const persons = cfg.persons.join(', ')
  const tenses = Object.fromEntries(cfg.tenses.map((t) => [t, cfg.persons.map(() => '…')]))
  return `You conjugate the verbs of one ${cfg.learn} sentence for a ${cfg.native}-speaking learner. Reply with ONLY a JSON object:
{"verbs":[{"infinitive":"...","tenses":${JSON.stringify(tenses)}}]}
Every verb in the sentence, auxiliaries included, at most 4, in the order they appear. Each tense lists exactly ${cfg.persons.length} forms, one per person, in this order: ${persons}. Use the forms these persons take in everyday ${cfg.learn}. ${NO_GIVEAWAY}`
}

function cardJson(card) {
  const { format, item, question } = card
  return JSON.stringify({ format, item: format === 'cloze' ? undefined : item, sentence: question })
}

export function grammarRequest(card, cfg = DEFAULT_CONFIG) {
  return { system: grammarSystem(cfg), prompt: cardJson(card) }
}

export function conjugationRequest(card, cfg = DEFAULT_CONFIG) {
  return { system: conjugationSystem(cfg), prompt: cardJson(card) }
}

function jsonObject(text) {
  const s = String(text ?? '')
  try {
    return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
  } catch {
    return null
  }
}

export function parseGrammar(text) {
  const notes = jsonObject(text)?.grammarDe
  if (!Array.isArray(notes)) return {}
  const ok = notes.filter(isText).slice(0, 5)
  return ok.length ? { grammarDe: ok } : {}
}

// A verb is kept only when every configured tense has one form per person.
export function fitsTable(v, cfg = DEFAULT_CONFIG) {
  return (
    isText(v?.infinitive) &&
    cfg.tenses.every((t) => Array.isArray(v.tenses?.[t]) && v.tenses[t].length === cfg.persons.length && v.tenses[t].every(isText))
  )
}

export function parseConjugation(text, cfg = DEFAULT_CONFIG) {
  const verbs = jsonObject(text)?.verbs
  if (!Array.isArray(verbs)) return {}
  const ok = verbs.filter((v) => fitsTable(v, cfg)).slice(0, 4)
  return ok.length ? { verbs: ok } : {}
}

export function grammarLines(card) {
  return card.grammarDe ?? []
}

// One table per verb, the way the morning briefs draw it: the tenses across,
// one row per person. The verb itself is its tab.
export function conjugationTables(card, cfg = DEFAULT_CONFIG) {
  return (card.verbs ?? [])
    .filter((v) => fitsTable(v, cfg))
    .map((v) => {
      const header = ['', ...cfg.tenses]
      const rows = cfg.persons.map((p, i) => [p, ...cfg.tenses.map((t) => v.tenses[t][i])])
      // each column as wide as its longest cell
      const widths = header.map((_, j) => Math.max(...[header, ...rows].map((r) => r[j].length)))
      return { verb: v.infinitive, header, rows, widths }
    })
}
