// The mod's wiring against Claude Code's own test kit: claude plugin test
// The model, the store, the files and the processes are stubs; nothing is spent.
import { expect, mock, test } from 'claude-code/testing'

const T0 = Date.UTC(2026, 9, 2, 15, 0)
const HOME = '/Users/test'
const DIR = HOME + '/Library/Mobile Documents/com~apple~CloudDocs/capi'

const card = (over: Record<string, unknown> = {}) => ({
  kind: 'spoken',
  topic: 'brasil',
  format: 'tf',
  item: 'ficar de fora',
  de: 'außen vor bleiben',
  question: 'Só o Chile e o Equador ficam de fora da fronteira com o Brasil.',
  options: ['verdade', 'mentira'],
  answer: 0,
  explain: 'Verdade: são 10 vizinhos.',
  note: '«ficar de fora» = außen vor bleiben',
  source: 'IBGE',
  capiRight: 'Mandou bem!',
  capiWrong: 'Quase!',
  ...over,
})
// five cards: the queue stays at 4 after the first is shown, so no second request
const five = (first = card(), second = card({ question: 'Segunda pergunta?' })) => [first, second, card(), card(), card()]
const reply = (cards: unknown[]) => ({
  isAnswered: true,
  text: JSON.stringify(cards),
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

// Stands in for Claude Code: an in-memory store and file system, a mock clock.
function engine(on: any, replies: unknown[], files = new Map<string, string>(), unreadable = new Set<string>(), env?: string) {
  const store = new Map<string, unknown>()
  const model: any[] = []
  const logs: string[] = []
  const writes: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: T0 })
  const list = (path: string) =>
    [...files.keys()]
      .filter((f) => f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/'))
      .map((f) => ({ name: f.slice(path.length + 1), kind: 'file', size: files.get(f)!.length, isLink: false }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: 'sess1' }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('fs.list', ($: any, e: any) => ({ value: list(e.path) }))
  on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) || list(e.path).length > 0 }))
  on('fs.read', ($: any, e: any) =>
    e.path.endsWith('/.env')
      ? env === undefined ? { deny: 'no settings file' } : { value: env }
      : files.has(e.path) && !unreadable.has(e.path) ? { value: files.get(e.path) } : { deny: 'cannot read ' + e.path },
  )
  on('fs.write', ($: any, e: any) => (writes.push(e.path), files.set(e.path, e.text), { value: undefined }))
  on('process.run', ($: any, e: any) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'scutil') return { value: { exitCode: 0, stdout: 'ddStudio\n', stderr: '' } }
    if (cmd === 'mv') {
      files.set(args[2], files.get(args[1])!)
      files.delete(args[1])
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => (logs.push(e.text), { value: undefined }))
  on('ui.toast', ($: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('model.complete', ($: any, e: any) => {
    model.push(e)
    return { value: replies.shift() ?? { isAnswered: false, reason: 'api-error' } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  return { store, files, model, logs, writes, toasts, clock }
}

// every string under a node, in drawing order
const words = (box: any): string[] => (box.children ?? []).flatMap((c: any) => (typeof c === 'string' ? [c] : words(c)))

// every element key under a node, in drawing order
const keysIn = (box: any): string[] =>
  (box?.children ?? []).flatMap((c: any) => (typeof c === 'string' ? [] : [...(c.props?.key ? [c.props.key] : []), ...keysIn(c)]))

// the first Text under a node whose words match
const textOf = (box: any, re: RegExp): any =>
  box?.type === 'Text' && re.test(words(box).join(' ')) ? box : (box?.children ?? []).map((c: any) => (typeof c === 'string' ? undefined : textOf(c, re))).find(Boolean)

const BAND = {
  plugin: 'capi',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

async function start($: any, clock: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  await $.turn.start({ text: 'do something', turnId: 't1' })
  await clock.settle()
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a card is answered, graded and recorded (${surface})`, async ($, on) => {
    const { store, model, clock } = engine(on, [reply(five())])
    await start($, clock)

    expect(model.length).toBe(1)
    expect(model[0].model).toBe('claude-opus-5-5')
    expect(model[0].effort).toBe('high')

    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /ficam de fora/ })).toBeDefined()

    // a press right after the card appeared is the tail of a double press
    await ui.press({ key: 'opt-0' })
    expect(await ui.find({ type: 'Text', text: /Certo/ })).toBeUndefined()

    await clock.advance(1000)
    await ui.press({ key: 'opt-0' })
    expect(await ui.find({ type: 'Text', text: /^Certo! \+10/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✅' })).toBeDefined() // in the icon column

    await clock.advance(1000)
    await ui.press({ key: 'yes' })
    const log = store.get('log:2026-10-02:sess1') as any[]
    expect(log.length).toBe(1)
    expect(log[0]).toMatchObject({ item: 'ficar de fora', quiz: true, grade: 'ok', machine: 'ddStudio' })
    expect(await ui.find({ type: 'Text', text: /Segunda pergunta/ })).toBeDefined()
    await ui.unmount()
  })
}

test('the answer reaches this Mac’s month file through a temporary file', async ($, on) => {
  const { files, writes, clock } = engine(on, [reply(five())])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1000)
  await ui.press({ key: 'opt-0' })
  await clock.advance(1000)
  await ui.press({ key: 'yes' })
  await clock.advance(6000) // the sync runs 5 s after an answer
  const month = files.get(DIR + '/ddStudio-2026-10.jsonl')
  expect(month).toBeDefined()
  expect(month!.trim().split('\n').length).toBe(1)
  expect(files.has(DIR + '/ddStudio-2026-10.jsonl.tmp')).toBe(false)
  // never written in place, where a reader could catch half a file
  expect(writes.includes(DIR + '/ddStudio-2026-10.jsonl')).toBe(false)
})

test('a month file that cannot be read is never overwritten', async ($, on) => {
  const own = DIR + '/ddStudio-2026-10.jsonl'
  const files = new Map([[own, 'three answers from yesterday\n'.repeat(3)]])
  const { store, clock } = engine(on, [reply(five())], files, new Set([own]))
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1000)
  await ui.press({ key: 'opt-0' })
  await clock.advance(1000)
  await ui.press({ key: 'yes' })
  await clock.advance(6000)
  expect(files.get(own)).toBe('three answers from yesterday\n'.repeat(3))
  // the answer is still safe in the store
  expect((store.get('log:2026-10-02:sess1') as any[]).length).toBe(1)
})

test('an API error is retried after a minute, and the band says what happened', async ($, on) => {
  const { model, clock, logs } = engine(on, [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }])
  await start($, clock)
  expect(model.length).toBe(1)
  expect(logs.some((l) => l.includes('api-error 529 overloaded'))).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Capi tropeçou \(api-error 529 overloaded\)/ })).toBeDefined()

  await clock.advance(50_000)
  expect(model.length).toBe(1)
  await clock.advance(15_000)
  expect(model.length).toBe(2)
})

test('a reply that cost tokens but gave no cards waits six minutes, not a loop', async ($, on) => {
  const { model, clock } = engine(on, [reply([]), reply([])])
  await start($, clock)
  expect(model.length).toBe(1)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.advance(5 * 60_000)
  expect(model.length).toBe(1)
  await clock.advance(2 * 60_000)
  expect(model.length).toBe(2)
})

test('🚩 needs a second press, and only then asks for a re-check', async ($, on) => {
  const { model, store, clock } = engine(on, [reply(five()), reply([]) as any])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1000)
  await ui.press({ key: 'flag' })
  expect(model.length).toBe(1)
  expect(await ui.find({ key: 'flag' })).toMatchObject({ props: { label: '🚩 de novo = confirmar' } })
  await ui.press({ key: 'flag' })
  expect(model.length).toBe(2)
  expect(model[1].effort).toBe('xhigh')
  const log = store.get('log:2026-10-02:sess1') as any[]
  expect(log[0].type).toBe('flag')
})

test('the band follows the card another session moved to', async ($, on) => {
  const { store, clock } = engine(on, [reply(five())])
  await start($, clock)
  store.set('current', { card: { ...card({ question: 'Carta da outra sessão' }), id: 'other' }, stage: 'quiz', at: T0 })
  await clock.advance(3500)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Carta da outra sessão/ })).toBeDefined()
})

test('– folds the band to its header line, □ opens it again, and a new session remembers', async ($, on) => {
  const { store, clock } = engine(on, [reply(five())])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // the standard window controls, grey text like the hotkey digits, no hotkey of their own
  expect(await ui.find({ key: 'size' })).toMatchObject({ props: { label: '–', dimColor: true } })
  expect(await ui.find({ key: 'close' })).toMatchObject({ props: { label: '×', dimColor: true } })
  expect(((await ui.find({ key: 'size' })) as any).props.hotkey).toBeUndefined()
  const header = ((await ui.find({ type: 'Box' })) as any).children[0]
  expect(header.children[1].children[0].props.columnGap).toBe(1) // – and × sit close together
  expect(await ui.find({ type: 'Svg' })).toBeUndefined() // text, no drawings
  await ui.press({ key: 'size' })
  const folded = (await ui.find({ type: 'Box' })) as any
  expect(folded.children.length).toBe(1) // the header line alone
  expect(await ui.find({ key: 'opt-0' })).toBeUndefined()
  expect(await ui.find({ key: 'gram' })).toBeUndefined()
  expect(await ui.find({ key: 'size' })).toMatchObject({ props: { label: '□' } })
  expect(store.get('minimized')).toBe(true)
  await ui.press({ key: 'size' })
  expect(await ui.find({ key: 'opt-0' })).toBeDefined()
  expect(store.get('minimized')).toBe(false)
})

test('short of width, actions keep icon and digit only, then the header and answers wrap', async ($, on) => {
  const { clock } = engine(on, [reply(five())])
  await start($, clock)
  const at = async (bodyColumns: number, maxRows = 20) => {
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns, maxRows }, surface: 'desktop' })
    const label = async (key: string) => ((await ui.find({ key })) as any).props
    const root = (await ui.find({ type: 'Box' })) as any
    const pairsBox = root.children[0].children[0].children[1]
    return { gram: await label('gram'), speak: await label('speak'), flag: await label('flag'), wrap: pairsBox.props.flexWrap }
  }
  const wide = await at(200)
  expect(wide.gram.label).toBe('📐 gramática')
  expect(wide.speak.label).toBe('🔊 ouvir')
  // 100 columns hold the question or the three labelled buttons, not both: those buttons lose their words
  const medium = await at(100)
  expect(medium.gram).toMatchObject({ label: '📐', hotkey: '6' })
  expect(medium.speak.label).toBe('🔊 ouvir')
  const narrow = await at(40)
  expect(narrow.speak).toMatchObject({ label: '🔊', hotkey: '8' })
  expect(narrow.flag).toMatchObject({ label: '🚩', hotkey: '9' })
  expect(narrow.wrap).toBe('wrap') // the header's pairs go onto more lines
  // a band too short for that cuts lines instead of wrapping them
  expect((await at(40, 4)).wrap).toBe('nowrap')
})

test('× hides the band in this session only, and /capi show brings it back', async ($, on) => {
  const { store, toasts, clock } = engine(on, [reply(five())])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'close' })
  expect(await ui.find({ key: 'opt-0' })).toBeUndefined()
  expect(await ui.find({ key: 'close' })).toBeUndefined()
  expect(toasts.some((t) => t.includes('/capi show'))).toBe(true)
  expect([...store.keys()].some((k) => /closed/.test(String(k)))).toBe(false) // nothing kept: a new session shows the band
  const r = (await $.command.run({ command: 'capi', args: 'show' })) as any
  expect(r.text).toMatch(/back/)
  expect(await ui.find({ key: 'opt-0' })).toBeDefined()
})

test('a band folded in another session opens folded', async ($, on) => {
  const { store, clock } = engine(on, [reply(five())])
  store.set('minimized', true)
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'opt-0' })).toBeUndefined()
  expect(await ui.find({ key: 'size' })).toMatchObject({ props: { label: '□', dimColor: true } })
})

test('a card that arrives after the turn ended shows while idle', async ($, on) => {
  // what happened live: a short turn starts the request, ends, and the cards come later
  const { clock } = engine(on, [reply(five())])
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'start a background wait', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: 'started', durationMs: 1, isAborted: false, usage: null } as any)
  await clock.settle()
  const idle = { ...BAND, props: { ...BAND.props, isWorking: false } }
  const ui = await $.ui.mount({ ...idle, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /ficam de fora/ })).toBeDefined()
})

test('CAPI_SHOW=working shows the band only while Claude works', async ($, on) => {
  const { clock } = engine(on, [reply(five())], new Map(), new Set(), 'CAPI_SHOW=working\n')
  await start($, clock)
  const idle = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false }, surface: 'desktop' })
  expect(await idle.find({ key: 'opt-0' })).toBeUndefined()
  expect(await idle.find({ type: 'Text', text: 'engine' })).toBeDefined() // the engine draws its own
  const working = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await working.find({ key: 'opt-0' })).toBeDefined()
})

test('🇩🇪 opens the translation under the card and closes it again', async ($, on) => {
  const de = { questionDe: 'Nur Chile und Ecuador grenzen nicht an Brasilien.', explainDe: 'Stimmt: 10 Nachbarn.', capiRightDe: 'Gut gemacht!', capiWrongDe: 'Fast!' }
  const { clock } = engine(on, [reply(five(card(de)))])
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /🇩🇪/ })).toBeUndefined()
    await ui.press({ key: 'de' })
    expect(await ui.find({ type: 'Text', text: /^Nur Chile und Ecuador/ })).toBeDefined()
    await ui.press({ key: 'de' })
    expect(await ui.find({ type: 'Text', text: /🇩🇪/ })).toBeUndefined()
    await ui.unmount()
  }
  // open, answer: the reveal shows Capi's line and the explanation in German
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'de' })
  await clock.advance(1000)
  await ui.press({ key: 'opt-0' })
  expect(await ui.find({ type: 'Text', text: /^Gut gemacht!/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Stimmt: 10 Nachbarn/ })).toBeDefined()
})

test('🇩🇪 on a card made before translations translates it once, and every session sees it', async ($, on) => {
  const de = { questionDe: 'Nur Chile und Ecuador grenzen nicht an Brasilien.', optionsDe: [], explainDe: 'Stimmt.', capiRightDe: 'Gut!', capiWrongDe: 'Fast!' }
  const { model, store, clock } = engine(on, [reply(five()), { ...reply([]), text: JSON.stringify(de) }])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'de' })
  expect(model.length).toBe(2)
  expect(model[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
  expect(await ui.find({ type: 'Text', text: /^Nur Chile und Ecuador/ })).toBeDefined()
  expect((store.get('current') as any).card.questionDe).toBe(de.questionDe)
  // closing and opening again costs nothing
  await ui.press({ key: 'de' })
  await ui.press({ key: 'de' })
  expect(model.length).toBe(2)
})

test('a translation that fails says so and closes again', async ($, on) => {
  const { model, toasts, clock } = engine(on, [reply(five())])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'de' })
  expect(model.length).toBe(2)
  expect(toasts.some((t) => t.includes('não conseguiu (tradução'))).toBe(true)
  expect(await ui.find({ key: 'de' })).toMatchObject({ props: { label: '🇩🇪 tradução' } })
})

test('📐 🔤 🇩🇪 sit top right, 🇩🇪 on key 0, 🔊 🚩 bottom right beside the answers, blank lines frame the question', async ($, on) => {
  const { clock } = engine(on, [reply(five())])
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const root0 = (await ui.find({ type: 'Box' })) as any
    const blanks = root0.children.map((c: any, i: number) => (c.type === 'Text' && c.children?.[0] === ' ' ? i : -1)).filter((i: number) => i >= 0)
    expect(blanks).toEqual([1, root0.children.length - 2]) // under the header, above the buttons
    expect(await ui.find({ key: 'de' })).toMatchObject({ props: { hotkey: '0' } })
    // the answers, indented to the text column with 👉 in the icon column
    const answers = root0.children[root0.children.length - 1]
    expect(words(answers.children[0])).toEqual(['👉'])
    // a Desktop button pads itself by a cell, so there the icon column gives that cell back
    expect(answers.children[0].props.width).toBe(surface === 'terminal' ? 4 : 3)
    expect(root0.children[2].children[0].props.width).toBe(4) // the question's icon column
    const bar = answers.children[1].children[0]
    // 🔊 🚩 at the right edge: the text column fills the row and the bar fills the text column
    expect(answers.children[1].props).toMatchObject({ flexDirection: 'row', flexGrow: 1 })
    expect(bar.props.flexGrow).toBe(1)
    expect(bar.props.justifyContent).toBe('space-between')
    expect(bar.children[0].children.map((c: any) => c.props.key)).toEqual(['opt-0', 'opt-1'])
    expect(bar.children[1].children.map((c: any) => c.props.key)).toEqual(['speak', 'flag'])
    // header: ONE line, the card's pairs then the learner's, with 📐 🔤 🇩🇪 at its right
    const header = root0.children[0]
    expect(header.props.justifyContent).toBe('space-between')
    expect(keysIn(header.children[1])).toEqual(['size', 'close']) // – and × at the header's right
    expect(words(header.children[0])).toEqual(['🦫', 'categoria', 'brasil', 'tipo', 'Fala', 'pergunta', 'Verdade ou mentira', 'nível', 'Turista 0/50', 'sequência', '0 dias', 'combo', '0'])
    expect(words(root0.children[0]).join(' ')).not.toMatch(/[·│|]/) // one structure: no separators
    // labels dim, every value and the question at full strength, the question bold
    const values = header.children[0].children[1].children.map((p: any) => p.children[1].props)
    expect(values.every((v: any) => !v.dimColor)).toBe(true)
    expect(header.children[0].children[1].children.every((p: any) => p.children[0].props.dimColor)).toBe(true)
    // the question, under the blank line: ❓ in the same icon column as the header's 🦫,
    // 📐 🔤 🇩🇪 at the right end of its line
    const [qIcon, qBody] = root0.children[2].children
    const qRow = qBody.children[0]
    expect(words(qIcon)).toEqual(['❓'])
    expect(qRow.props.justifyContent).toBe('space-between')
    expect(textOf(qRow, /ficam de fora/).props.bold).toBe(true)
    expect(qRow.children[1].children[0].children.map((c: any) => c.props.key)).toEqual(['gram', 'conj', 'de'])
    expect(qIcon.props.width).toBe(header.children[0].children[0].props.width)
    expect(words(header.children[0].children[0])).toEqual(['🦫'])
    // the question type lives in the header now, not above the question
    expect(await ui.find({ type: 'Text', text: /Verdade ou mentira\?/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('📐 and 🔤 are generated once each, at their effort, and only one panel is open at a time', async ($, on) => {
  const grammar = { grammarDe: ['«do caju» = de + o, wie ein Genitiv: der Teil DES Cashews.', '«saca só» ist Umgangssprache.'] }
  const forms = (a: string) => [a + '1', a + '2', a + '3', a + '4', a + '5']
  const verbs = { verbs: [{ infinitive: 'ser', tenses: { presente: forms('sou'), 'pretérito perfeito': forms('fui'), 'pretérito imperfeito': forms('era'), futuro: forms('serei'), 'subjuntivo presente': forms('seja') } }] }
  const text = (o: unknown) => ({ ...reply([]), text: JSON.stringify(o) })
  const { model, store, clock } = engine(on, [reply(five()), text(grammar), text(verbs)])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'gram' })
  expect(model[1]).toMatchObject({ effort: 'medium' })
  expect(await ui.find({ type: 'Text', text: /^«do caju» = de \+ o/ })).toBeDefined()

  await ui.press({ key: 'conj' })
  expect(model[2]).toMatchObject({ effort: 'low' })
  // a table as in the morning briefs: tenses across, one row per person, no title line; one verb is still a tab
  expect(await ui.find({ key: 'verb-0' })).toMatchObject({ props: { label: '▸ ser' } })
  expect(await ui.find({ type: 'Text', text: /🔤 ser|=/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'subjuntivo presente' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ele/ela' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'seja3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /📐/ })).toBeUndefined() // grammar closed when conjugation opened

  await ui.press({ key: 'gram' }) // back to grammar: kept, no new call
  expect(model.length).toBe(3)
  expect(await ui.find({ type: 'Text', text: /^«do caju»/ })).toBeDefined()
  const kept = (store.get('current') as any).card
  expect(kept.grammarDe.length).toBe(2)
  expect(kept.verbs[0].infinitive).toBe('ser')
})

test('a settings file changes what Capi asks the model for', async ($, on) => {
  const env = 'CAPI_TOPICS=football and music\nCAPI_NATIVE_LANGUAGE=English\nCAPI_NATIVE_FLAG=🇬🇧\n'
  const { model, clock } = engine(on, [reply(five())], new Map(), new Set(), env)
  await start($, clock)
  expect(model[0].prompt).toMatch(/Spread the facts across: football and music\./)
  expect(model[0].system).toMatch(/native English speaker/)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'de' })).toMatchObject({ props: { label: '🇬🇧 tradução' } })
})

test('without a settings file Capi keeps its defaults', async ($, on) => {
  const { model, clock } = engine(on, [reply(five())])
  await start($, clock)
  expect(model[0].system).toMatch(/teaches Brazilian Portuguese/)
  expect(model[0].system).toMatch(/native German speaker/)
})

test('🔤 shows one verb at a time in tabs, and an open panel stands apart from the question', async ($, on) => {
  const forms = (a: string) => [a + '1', a + '2', a + '3', a + '4', a + '5']
  const verb = (inf: string, p: string) => ({ infinitive: inf, de: inf, tenses: { presente: forms(p + 'P'), 'pretérito perfeito': forms(p + 'R'), 'pretérito imperfeito': forms(p + 'I'), futuro: forms(p + 'F'), 'subjuntivo presente': forms(p + 'S') } })
  const text = (o: unknown) => ({ ...reply([]), text: JSON.stringify(o) })
  const { model, clock } = engine(on, [reply(five()), text({ verbs: [verb('sacar', 'sa'), verb('ser', 'se')] })])
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'conj' })

  expect(await ui.find({ key: 'verb-0' })).toMatchObject({ props: { label: '▸ sacar' } })
  expect(await ui.find({ key: 'verb-1' })).toMatchObject({ props: { label: 'ser' } })
  expect(await ui.find({ type: 'Text', text: 'saP1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'seP1' })).toBeUndefined()

  await ui.press({ key: 'verb-1' })
  expect(await ui.find({ type: 'Text', text: 'seS5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'saP1' })).toBeUndefined()
  expect(model.length).toBe(2) // switching tabs asks for nothing

  // the question, a blank line, then the panel
  const root = (await ui.find({ type: 'Box' })) as any
  const q = root.children.findIndex((c: any) => /ficam de fora/.test(words(c).join(' ')))
  expect(root.children[q + 1].children?.[0]).toBe(' ')
  // the verbs as tabs down the left, the table beside them
  expect(words(root.children[q + 2].children[0])).toEqual(['🔤']) // the panel's icon in the icon column
  expect(root.children[q + 2].props.alignItems).toBe('flex-start') // at the panel's top, not its middle
  const [tabs, table] = root.children[q + 2].children[1].children[0].children
  expect(tabs.props.flexDirection).toBe('column')
  expect(tabs.props.width).toBe('sacar'.length + 4) // fixed by the longest verb, whichever is chosen
  expect(tabs.children.map((c: any) => c.props.key)).toEqual(['verb-0', 'verb-1'])
  // every tab padded alike (none dimmed), and on Desktop the panel's icon column gives the padding's cell back
  expect(tabs.children.every((c: any) => !c.props.dimColor)).toBe(true)
  expect(root.children[q + 2].children[0].props.width).toBe(3)
  expect(table.children.length).toBe(6) // the tenses, then one row per person

  // the panel counts as its 6 rows when the band is short: header, question, panel, answers
  // and 3 blank lines are 12 rows, so 11 cuts texts to one line and 12 does not
  const question = async (maxRows: number) => {
    const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows }, surface: 'desktop' })
    const r = (await band.find({ type: 'Box' })) as any
    return textOf(r, /ficam de fora/).props.wrap
  }
  expect(await question(11)).toBe('truncate-end')
  expect(await question(12)).toBe('wrap')
})
