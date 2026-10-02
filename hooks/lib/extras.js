// 📐 grammar notes and 🔤 conjugations for a card's sentence, asked for when
// the learner opens them and then kept on the card.

const isText = (v) => typeof v === 'string' && v.trim() !== ''

export const TENSES = ['presente', 'pretérito perfeito', 'pretérito imperfeito', 'futuro']
// Brazilian persons, the forms people actually use: tu and vós are left out.
export const PERSONS = 'eu · você/ele/ela/a gente · nós · vocês/eles/elas'

const NO_GIVEAWAY = `If the sentence contains ___, it is a gap the learner must fill: never fill it, never name or hint at the missing word. If the card is a "meaning" card, never explain what the item in «» means.`

export const GRAMMAR_SYSTEM = `You explain the grammar of one Brazilian Portuguese sentence to a German native speaker who lives in Brazil and speaks everyday Portuguese. Reply with ONLY a JSON object: {"grammarDe":["...", "..."]}
2 to 5 notes in German, each one short line (at most 140 characters), about what is actually in this sentence: prepositions and contractions and the German case they do the job of (e.g. «do caju» = de + o, wie ein Genitiv), pronoun placement, word order, tense and mood choices (subjuntivo!), colloquial forms (tô, cê, pra, a gente). Compare with German where it helps. ${NO_GIVEAWAY}`

export const CONJUGATION_SYSTEM = `You conjugate the verbs of one Brazilian Portuguese sentence for a German learner. Reply with ONLY a JSON object:
{"verbs":[{"infinitive":"...","de":"German meaning","inSentence":"the form used in the sentence","form":"its tense and person, in Portuguese","tenses":{"presente":["eu","você/ele/ela/a gente","nós","vocês/eles/elas"],"pretérito perfeito":[...],"pretérito imperfeito":[...],"futuro":[...]}}]}
Every verb in the sentence, auxiliaries included, at most 4, in the order they appear. Each tense lists exactly 4 forms in this person order: eu, você/ele/ela/a gente, nós, vocês/eles/elas. "futuro" is the futuro do presente (farei, fará, …). ${NO_GIVEAWAY}`

function cardJson(card) {
  const { format, item, question } = card
  return JSON.stringify({ format, item: format === 'cloze' ? undefined : item, sentence: question })
}

export function grammarRequest(card) {
  return { system: GRAMMAR_SYSTEM, prompt: cardJson(card) }
}

export function conjugationRequest(card) {
  return { system: CONJUGATION_SYSTEM, prompt: cardJson(card) }
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

export function parseConjugation(text) {
  const verbs = jsonObject(text)?.verbs
  if (!Array.isArray(verbs)) return {}
  const ok = verbs
    .filter((v) => isText(v?.infinitive) && v.tenses && TENSES.every((t) => Array.isArray(v.tenses[t]) && v.tenses[t].length === 4 && v.tenses[t].every(isText)))
    .slice(0, 4)
  return ok.length ? { verbs: ok } : {}
}

export function grammarLines(card) {
  return (card.grammarDe ?? []).map((n) => '📐 ' + n)
}

export function conjugationLines(card) {
  if (!card.verbs?.length) return []
  const lines = ['🔤 ' + PERSONS]
  for (const v of card.verbs) {
    const where = isText(v.inSentence) ? ` · im Satz: ${v.inSentence}${isText(v.form) ? ` (${v.form})` : ''}` : ''
    lines.push(`🔤 ${v.infinitive}${isText(v.de) ? ` = ${v.de}` : ''}${where}`)
    for (const t of TENSES) lines.push(`    ${t}: ${v.tenses[t].join(' · ')}`)
  }
  return lines
}
