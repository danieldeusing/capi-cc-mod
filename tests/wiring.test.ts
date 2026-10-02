// The mod's wiring against Claude Code's own test kit: claude plugin test
// The model, the store, the files and the processes are stubs; nothing is spent.
import { expect, mock, test } from 'claude-code/testing'

const T0 = Date.UTC(2026, 9, 2, 15, 0)
const HOME = '/Users/test'
const DIR = HOME + '/Library/Mobile Documents/com~apple~CloudDocs/ptbr'

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
function engine(on: any, replies: unknown[], files = new Map<string, string>(), unreadable = new Set<string>()) {
  const store = new Map<string, unknown>()
  const model: any[] = []
  const logs: string[] = []
  const writes: string[] = []
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
    files.has(e.path) && !unreadable.has(e.path) ? { value: files.get(e.path) } : { deny: 'cannot read ' + e.path },
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
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', ($: any, e: any) => {
    model.push(e)
    return { value: replies.shift() ?? { isAnswered: false, reason: 'api-error' } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  return { store, files, model, logs, writes, clock }
}

const BAND = {
  plugin: 'ptbr',
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
    expect(await ui.find({ type: 'Text', text: /✅ Certo! \+10/ })).toBeDefined()

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

test('a subagent finishing does not stop the band from following other sessions', async ($, on) => {
  const { store, clock } = engine(on, [reply(five())])
  await start($, clock)
  await $.turn.complete({ turnId: 't1', agentId: 'sub1', answer: 'done', durationMs: 1, isAborted: false, usage: null } as any)
  // another session moves on to a card of its own
  store.set('current', { card: { ...card({ question: 'Carta da outra sessão' }), id: 'other' }, stage: 'quiz', at: T0 })
  await clock.advance(3500)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Carta da outra sessão/ })).toBeDefined()
})
