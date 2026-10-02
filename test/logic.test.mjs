// The learning logic, outside Claude Code: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replay, dueItems, newAllowance, levelFor, PLACEMENT_BOX, NEW_PER_DAY } from '../hooks/lib/srs.js'
import { parseJsonl, toJsonl, merge, monthFile } from '../hooks/lib/log.js'
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
  assert.match(req.system, /keep the item in Portuguese/)
  assert.equal(JSON.parse(req.prompt).item, 'ficar de fora')
  assert.equal(JSON.parse(req.prompt).answer, undefined) // the translator never sees which option is right
})

test('both prompts translate the taught expression too, except where it is the answer', async () => {
  const { SYSTEM, TRANSLATE_SYSTEM } = await import('../hooks/lib/cards.js')
  for (const prompt of [SYSTEM, TRANSLATE_SYSTEM]) {
    assert.match(prompt, /Translate EVERYTHING into German, the expression being taught included/)
    assert.match(prompt, /in a "meaning" card keep the item in Portuguese/)
  }
})
