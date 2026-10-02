// The learning logic, outside Claude Code: node --test test/*.test.mjs
// Days and month files follow local time, so the tests pin one: Brazil's.
process.env.TZ = 'America/Sao_Paulo'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replay, dueItems, newAllowance, levelFor, PLACEMENT_BOX, NEW_PER_DAY } from '../hooks/lib/srs.js'
import { parseJsonl, toJsonl, merge, monthFile } from '../hooks/lib/log.js'
import { cells } from '../hooks/lib/cells.js'
import { buildRequest, parseCards, activityHint, germanLines, parseTranslation, translationRequest } from '../hooks/lib/cards.js'

const MIN = 60_000
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 1, 15, 0) // 2026-10-01, midday in Brazil
let n = 0
const answer = (t, item, grade, extra = {}) => ({
  type: 'answer', id: `e${n++}`, t, machine: 'ddStudio', cardId: `c${n}`,
  item, de: 'x', kind: 'spoken', format: 'tf', quiz: grade === 'ok', grade, ...extra,
})

test('placement: an item known in the first week jumps to box 4', () => {
  const s = replay([answer(T0, 'ficar de fora', 'ok')], T0)
  assert.equal(s.items.get('ficar de fora').box, PLACEMENT_BOX)
})

test('after placement a known new item goes to box 2, due in 3 days', () => {
  const s = replay([answer(T0, 'a', 'ok'), answer(T0 + 8 * DAY, 'b', 'ok')], T0 + 8 * DAY)
  const b = s.items.get('b')
  assert.equal(b.box, 2)
  assert.equal(b.due, T0 + 11 * DAY)
})

test('a miss sends the item to box 1 and back within the payback window', () => {
  const s = replay([answer(T0, 'rolar', 'ok'), answer(T0 + 5 * DAY, 'rolar', 'miss', { format: 'cloze' })], T0 + 5 * DAY)
  const it = s.items.get('rolar')
  assert.equal(it.box, 1)
  assert.equal(it.due, T0 + 5 * DAY + 20 * MIN)
  assert.equal(it.lastMiss, true)
  assert.deepEqual(dueItems(s, T0 + 5 * DAY + 21 * MIN).map((i) => i.item), ['rolar'])
  assert.deepEqual(dueItems(s, T0 + 5 * DAY + 19 * MIN), [])
})

test('the same card answered in two sessions counts once', () => {
  const a = answer(T0, 'bora', 'ok')
  const b = { ...answer(T0 + 1000, 'bora', 'ok'), cardId: a.cardId }
  const s = replay([a, b], T0)
  assert.equal(s.points, 10)
  assert.equal(s.items.get('bora').box, PLACEMENT_BOX)
})

test('items are matched regardless of case and punctuation', () => {
  const s = replay([answer(T0, 'Tô de boa!', 'ok'), answer(T0 + 9 * DAY, '«tô de boa»', 'miss')], T0 + 9 * DAY)
  assert.equal(s.items.size, 1)
})

test('streak counts consecutive days and survives a day not yet started', () => {
  const es = [answer(T0 - 2 * DAY, 'a', 'ok'), answer(T0 - DAY, 'b', 'ok'), answer(T0, 'c', 'ok')]
  assert.equal(replay(es, T0).streak, 3)
  assert.equal(replay(es, T0 + DAY).streak, 3) // tomorrow morning, nothing answered yet
  assert.equal(replay(es, T0 + 2 * DAY).streak, 0) // a whole day missed
})

test('combo grows the points and resets on a wrong quiz answer', () => {
  const es = [answer(T0, 'a', 'ok'), answer(T0 + 1, 'b', 'ok'), answer(T0 + 2, 'c', 'miss'), answer(T0 + 3, 'd', 'ok')]
  const s = replay(es, T0)
  assert.equal(s.points, 10 + 12 + 10)
  assert.equal(s.combo, 1)
  assert.equal(s.bestCombo, 2)
})

test('the new-item cap counts today and the queue', () => {
  const es = Array.from({ length: 7 }, (_, i) => answer(T0 + i, 'w' + i, 'ok'))
  const s = replay(es, T0)
  assert.equal(s.todayNew, 7)
  assert.equal(newAllowance(s, 2), NEW_PER_DAY - 9)
  assert.equal(newAllowance(s, 5), 0)
})

test('levels', () => {
  assert.deepEqual(levelFor(0), { name: 'Turista', next: 50 })
  assert.deepEqual(levelFor(150), { name: 'Gringo esperto', next: 300 })
  assert.deepEqual(levelFor(9999), { name: 'Brasileiro de coração', next: null })
})

test('the log survives a damaged line and merges two Macs without duplicates', () => {
  const a = [answer(T0, 'a', 'ok'), answer(T0 + 2, 'b', 'ok')]
  const b = [{ ...a[1] }, { ...answer(T0 + 1, 'c', 'ok'), machine: 'ddAir' }]
  const parsed = parseJsonl(toJsonl(a) + 'not json\n{"id":1}\n')
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.bad, 2)
  assert.deepEqual(merge(parsed.entries, b).map((e) => e.item), ['a', 'c', 'b'])
})

const card = (over = {}) => ({
  kind: 'spoken', topic: 'brasil', format: 'tf', item: 'ficar de fora', de: 'außen vor bleiben',
  question: 'O Brasil faz fronteira com quase todos os países da América do Sul — só o Chile e o Equador ficam de fora.',
  options: ['verdade', 'mentira'], answer: 0, explain: 'Verdade: são 10 vizinhos.', note: '«ficar de fora» = außen vor bleiben',
  source: 'IBGE', capiRight: 'Mandou bem!', capiWrong: 'Quase!', ...over,
})

test('parseCards keeps valid cards from a fenced reply and drops broken ones', () => {
  const reply = '```json\n' + JSON.stringify([
    card(),
    card({ answer: 2 }), // tf answer out of range
    card({ format: 'mc', options: ['a', 'b'] }), // mc needs 3-4 options
    card({ source: '' }), // a fact needs a source
    { kind: 'bonus', format: 'bonus', question: 'Pagar o pato', explain: 'Levar a culpa.', note: 'büßen', options: [], answer: -1, item: '' },
  ]) + '\n```'
  const { cards, dropped } = parseCards(reply, T0)
  assert.deepEqual(cards.map((c) => c.format), ['tf', 'bonus'])
  assert.equal(dropped, 3)
  assert.notEqual(cards[0].id, cards[1].id)
})

test('parseCards on garbage yields nothing, not a throw', () => {
  assert.deepEqual(parseCards('Desculpa, não consigo.', T0), { cards: [], dropped: 0 })
  assert.deepEqual(parseCards('[{"oops"', T0), { cards: [], dropped: 0 })
})

test('buildRequest asks a missed item back in the other format', () => {
  const s = replay([answer(T0 - 10 * DAY, 'rolar', 'ok'), answer(T0 - 2 * DAY, 'rolar', 'miss', { format: 'cloze' })], T0)
  const req = buildRequest({ now: T0, state: s, queue: [], activity: ['git push'], total: 10 })
  assert.match(req.prompt, /"rolar" \(x\) → format meaning/)
  assert.match(req.prompt, /git push/)
  assert.match(req.prompt, /1 de outubro de 2026/)
  assert.equal(req.count, 10)
})

test('buildRequest skips items already waiting and falls back to bonus cards at the cap', () => {
  const es = Array.from({ length: NEW_PER_DAY }, (_, i) => answer(T0 + i, 'w' + i, 'ok'))
  const s = replay(es, T0)
  const req = buildRequest({ now: T0 + 1000, state: s, queue: [], activity: [], total: 10 })
  assert.equal(req.count, 10)
  assert.match(req.prompt, /Bonus: 10 "bonus" cards/)
  assert.doesNotMatch(req.prompt, /^New:/m)

  const s2 = replay([answer(T0 - 10 * DAY, 'rolar', 'ok'), answer(T0 - 2 * DAY, 'rolar', 'miss')], T0)
  const queued = buildRequest({ now: T0, state: s2, queue: [card({ item: 'Rolar' })], activity: [], total: 10 })
  assert.doesNotMatch(queued.prompt, /^Review:/m)
})

test('the activity hint never carries an assignment, a path or an argument', () => {
  assert.equal(activityHint('Bash', 'git push origin main'), 'git push')
  assert.equal(activityHint('Bash', '/usr/bin/git commit -m "x"'), 'git commit')
  assert.equal(activityHint('Bash', 'TOKEN=abc123 curl https://x.example/?k=1'), 'curl')
  assert.equal(activityHint('Bash', 'export API_KEY=abc123'), '')
  assert.equal(activityHint('Bash', 'sudo env FOO=1 docker ps'), 'docker ps')
  assert.equal(activityHint('Bash', 'cd /secret/dir && ls'), 'cd')
  assert.equal(activityHint('Edit'), 'Edit')
  assert.equal(activityHint('weird tool; rm'), '')
})

test('history files are per Mac and month, in local time', () => {
  assert.equal(monthFile('ddStudio', Date.UTC(2026, 9, 1, 2, 0)), 'ddStudio-2026-09.jsonl') // still Sep 30 in Brazil
  assert.equal(monthFile('ddAir', T0), 'ddAir-2026-10.jsonl')
})

test('the translation toggle shows the question first, then the explanation', () => {
  const c = card({
    format: 'mc', options: ['a', 'b', 'c'], answer: 0,
    questionDe: 'Nur Chile und Ecuador bleiben außen vor.', optionsDe: ['A', 'B', 'C'],
    explainDe: 'Stimmt: 10 Nachbarn.', capiRightDe: 'Gut gemacht!', capiWrongDe: 'Fast!',
  })
  assert.deepEqual(germanLines(c, 'quiz'), ['Nur Chile und Ecuador bleiben außen vor.', '1: A · 2: B · 3: C'])
  assert.deepEqual(germanLines(c, 'reveal', true), ['Gut gemacht!', 'Stimmt: 10 Nachbarn.'])
  assert.deepEqual(germanLines(c, 'reveal', false), ['Fast!', 'Stimmt: 10 Nachbarn.'])
  // options are only translated for mc, and only when the counts match
  assert.deepEqual(germanLines({ ...c, optionsDe: ['A'] }, 'quiz'), ['Nur Chile und Ecuador bleiben außen vor.'])
  assert.deepEqual(germanLines({ ...c, format: 'cloze' }, 'quiz'), ['Nur Chile und Ecuador bleiben außen vor.'])
  const bonus = { format: 'bonus', questionDe: 'Warum…', explainDe: 'Weil…' }
  assert.deepEqual(germanLines(bonus, 'quiz'), ['Warum…', 'Weil…'])
  assert.deepEqual(germanLines(card(), 'quiz'), []) // a card from before translations
})

test('an on-demand translation keeps only well-formed German fields', () => {
  assert.deepEqual(
    parseTranslation('Aqui: {"questionDe":"Frage?","optionsDe":["a",2],"explainDe":"","capiRightDe":"Gut!","extra":"x"}'),
    { questionDe: 'Frage?', capiRightDe: 'Gut!' },
  )
  assert.deepEqual(parseTranslation('sem json'), {})
  const req = translationRequest(card({ format: 'meaning' }))
  assert.match(req.system, /keep the item in Brazilian Portuguese/)
  assert.equal(JSON.parse(req.prompt).item, 'ficar de fora')
  assert.equal(JSON.parse(req.prompt).answer, undefined) // the translator never sees which option is right
})

test('both prompts translate the taught expression too, except where it is the answer', async () => {
  const { systemPrompt, translateSystem } = await import('../hooks/lib/cards.js')
  for (const prompt of [systemPrompt(), translateSystem()]) {
    assert.match(prompt, /Translate EVERYTHING into German, the expression being taught included/)
    assert.match(prompt, /in a "meaning" card keep the item in Brazilian Portuguese/)
  }
})

test('the header is label and value pairs: the card, then the learner, with no separators in values', async () => {
  const { headerParts } = await import('../hooks/lib/cards.js')
  const s = replay([answer(T0, 'a', 'ok')], T0) // known through placement: 1 of 50
  assert.deepEqual(headerParts(card({ topic: 'Comida · botânica' }), s), {
    card: [['categoria', 'Comida, botânica'], ['tipo', 'Fala'], ['pergunta', 'Verdade ou mentira']],
    learner: [['nível', 'Turista 1/50'], ['sequência', '1 dia'], ['combo', '1']],
  })
  assert.equal(headerParts(card({ topic: 'Saúde | exercício - corpo' }), s).card[0][1], 'Saúde, exercício, corpo')
  assert.deepEqual(headerParts(card({ kind: 'grammar', topic: '', format: 'cloze' }), s).card, [['tipo', 'Gramática'], ['pergunta', 'Complete a frase']])
  assert.deepEqual(headerParts(null, s).card, [])
  assert.equal(headerParts(card(), { ...s, known: 700, level: levelFor(700) }).learner[0][1], 'Brasileiro de coração')
})

test('grammar and conjugation replies are checked, tables follow the config, and a gap is never filled', async () => {
  const x = await import('../hooks/lib/extras.js')
  const { DEFAULT_CONFIG: cfg } = await import('../hooks/lib/config.js')
  assert.deepEqual(x.parseGrammar('{"grammarDe":["a","",3,"b"]}'), { grammarDe: ['a', 'b'] })
  assert.deepEqual(x.parseGrammar('nada'), {})
  const tenses = (n) => Object.fromEntries(cfg.tenses.map((t, i) => [t, Array.from({ length: i === 0 ? n : 5 }, (_, k) => t[0] + k)]))
  const reply = JSON.stringify({ verbs: [{ infinitive: 'ser', de: 'sein', tenses: tenses(5) }, { infinitive: 'ir', tenses: tenses(4) }] })
  const { verbs } = x.parseConjugation(reply, cfg)
  assert.deepEqual(verbs.map((v) => v.infinitive), ['ser']) // a tense one person short is dropped
  const [table] = x.conjugationTables({ verbs }, cfg)
  assert.deepEqual(table.header, ['', 'presente', 'pretérito perfeito', 'pretérito imperfeito', 'futuro', 'subjuntivo presente'])
  assert.deepEqual(table.rows.map((r) => r[0]), ['eu', 'você', 'ele/ela', 'nós', 'vocês']) // as the morning briefs: no tu, no vós
  assert.deepEqual(table.rows[1], ['você', 'p1', 'p1', 'p1', 'f1', 's1'])
  assert.deepEqual(table.widths, [7, 8, 18, 20, 6, 19]) // longest cell per column: ele/ela, then the tense names
  // a cloze card's item is the answer: it never reaches the model, and the prompt forbids filling the gap
  const req = x.conjugationRequest(card({ format: 'cloze', question: 'Se cê ___ no Pantanal' }))
  assert.equal(JSON.parse(req.prompt).item, undefined)
  assert.match(req.system, /never fill it/)
  assert.match(req.system, /in this order: eu, você, ele\/ela, nós, vocês/)
  assert.match(x.grammarRequest(card()).system, /never fill it/)
})

test('the settings file is read plainly, and every prompt follows it', async () => {
  const { parseEnv, configFrom, DEFAULTS } = await import('../hooks/lib/config.js')
  const { systemPrompt } = await import('../hooks/lib/cards.js')
  const { conjugationSystem } = await import('../hooks/lib/extras.js')
  const env = parseEnv('# comment\n\nCAPI_LEARN_LANGUAGE="Mexican Spanish"\nCAPI_NATIVE_LANGUAGE = English \nCAPI_TOPICS=\nCAPI_PERSONS=yo|tú|él/ella|nosotros|ustedes\nnot a pair\n=x\n')
  assert.deepEqual(env, { CAPI_LEARN_LANGUAGE: 'Mexican Spanish', CAPI_NATIVE_LANGUAGE: 'English', CAPI_TOPICS: '', CAPI_PERSONS: 'yo|tú|él/ella|nosotros|ustedes' })
  const cfg = configFrom(env)
  assert.equal(cfg.topics, DEFAULTS.CAPI_TOPICS) // an empty value keeps the default
  assert.deepEqual(cfg.persons, ['yo', 'tú', 'él/ella', 'nosotros', 'ustedes'])
  assert.match(systemPrompt(cfg), /teaches Mexican Spanish inside a coding tool/)
  assert.match(systemPrompt(cfg), /native English speaker/)
  assert.match(conjugationSystem(cfg), /in this order: yo, tú, él\/ella, nosotros, ustedes/)
  const s = replay([], T0)
  const req = buildRequest({ now: T0, state: s, queue: [], activity: [], total: 10, cfg: configFrom({ CAPI_TOPICS: 'football and music' }) })
  assert.match(req.prompt, /Spread the facts across: football and music\./)
  assert.equal(cfg.show, 'always')
  assert.equal(configFrom({ CAPI_SHOW: 'Working' }).show, 'working')
  assert.equal(configFrom({ CAPI_SHOW: 'sometimes' }).show, 'always') // anything else keeps the default
})

test('screen width in cells: an emoji or a flag two, accents and variation selectors none', () => {
  assert.equal(cells('📐 gramática'), 12)
  assert.equal(cells('🇩🇪'), 2)
  assert.equal(cells('❤️'), 2)
  assert.equal(cells('conjugação'), 10)
  assert.equal(cells('é'), 1) // e + a combining accent
  assert.equal(cells(undefined), 0)
})
