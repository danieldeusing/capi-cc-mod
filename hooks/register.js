// Capi teaches Brazilian Portuguese in the band above the prompt while Claude works.
//
// Where things live:
//   $.store 'log:<day>:<session>'   this session's answers that day (one writer per key)
//   $.store 'queue' / 'current'     the cards every session on this Mac shares
//   $.store 'machine'               this Mac's name, fixed on first use
//   iCloud capi/<Mac>-<YYYY-MM>.jsonl  each Mac's history per month; every Mac reads all

import { replay, dayOf } from './lib/srs.js'
import { parseJsonl, toJsonl, merge, monthFile } from './lib/log.js'
import { buildRequest, parseCards, activityHint, germanLines, headerParts, translationRequest, parseTranslation, ITEM_FORMATS } from './lib/cards.js'
import { grammarRequest, parseGrammar, grammarLines, conjugationRequest, parseConjugation, conjugationTables, fitsTable } from './lib/extras.js'
import { configFrom, parseEnv, DEFAULT_CONFIG } from './lib/config.js'
import { cells } from './lib/cells.js'

// The one horizontal space between things side by side: pairs, buttons, tabs.
const GAP = 2
// The facts have to be TRUE, so batches go to Opus at high effort. They run in
// the background while cards are still queued, so the latency costs nothing.
const GENERATE = { model: 'claude-opus-5-5', effort: 'high', maxTokens: 32000, timeoutMs: 300_000 }
// A 🚩 asks whether one claim really is wrong: rare, and worth the most care.
const CHECK = { model: 'claude-opus-5-5', effort: 'xhigh', maxTokens: 2000, timeoutMs: 300_000 }
// The panels a card can open, top right, each generated on its first opening
// and then kept on the shared card. Translating and conjugating are plain jobs;
// explaining grammar takes some judgement.
const EXTRAS = {
  gram: {
    icon: '📐', name: 'gramática', hotkey: '6',
    call: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 2500, timeoutMs: 120_000 },
    has: (c) => Array.isArray(c.grammarDe), request: (c) => grammarRequest(c, cfg), parse: (t) => parseGrammar(t),
    lines: (c) => grammarLines(c),
  },
  conj: {
    icon: '🔤', name: 'conjugação', hotkey: '7',
    call: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 3000, timeoutMs: 120_000 },
    // A table made for other persons or tenses than the config's is made again.
    has: (c) => Array.isArray(c.verbs) && c.verbs.some((v) => fitsTable(v, cfg)),
    request: (c) => conjugationRequest(c, cfg), parse: (t) => parseConjugation(t, cfg),
    tables: (c) => conjugationTables(c, cfg),
  },
  de: {
    get icon() { return cfg.nativeFlag },
    name: 'tradução', hotkey: '0',
    call: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 1500, timeoutMs: 60_000 },
    has: (c) => Boolean(c.questionDe || c.explainDe), request: (c) => translationRequest(c, cfg), parse: (t) => parseTranslation(t),
    lines: (c, stage, quizOk) => germanLines(c, stage, quizOk),
  },
}
const BATCH = 10
const REFILL_BELOW = 4
const POLL_MS = 3000
const SYNC_DELAY_MS = 5000
// Covers one model call. A failed refill keeps the lock, so it is also the backoff:
// a reply that cost tokens but gave no cards waits the full time, while an API
// error or a call cut short (both free) is retried after a minute.
const REFILL_LOCK_MS = 6 * 60_000
const RETRY_FREE_MS = 60_000
// A press this soon after the card changed is the second half of a double press.
const PRESS_GUARD_MS = 800
const FLAG_CONFIRM_MS = 10_000
const VOICE = 'Luciana'
const ICLOUD = 'Library/Mobile Documents/com~apple~CloudDocs/capi'


let home = ''
// The learner's languages, topics and conjugation table, from the plugin's .env.
let cfg = DEFAULT_CONFIG
let machine = ''
let sessionId = 'session'
let entries = []
let state = replay([], 0)
let current = null
let activity = []
let refilling = false
let recording = Promise.resolve()
let syncTimer = null
let armed = null
// The one extra panel open in this session ({ id, kind }), and the one being fetched.
let open = null
// The verb tab chosen in the conjugation panel ({ id, index }); the first by default.
let verbTab = null
// The band folded to its header line. Kept in $.store, so a new session opens it the same way.
let minimized = false
// The band closed with ×: this session only, so a new session or /capi show brings it back.
let closed = false
let loading = null
let syncReport = 'not synced yet'
let lastBatch = 'none yet'
let failure = ''
let effortRefused = false

export function register(on) {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    sessionId = await $.session.id()
    cfg = await loadConfig($)
    machine = await machineName($)
    current = (await $.store.get('current')) ?? null
    minimized = (await $.store.get('minimized')) === true
    $.clock.every(POLL_MS, () => poll($))
    // Not awaited: a slow or offline iCloud must not hold up the first prompt.
    sync($).catch((err) => (syncReport = 'sync failed: ' + (err?.message ?? err)))
    await $.command.register({
      name: 'capi',
      description: 'Capi: your progress (skip: next card, show: bring the band back)',
      argumentHint: '[skip|show]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'capi' }, async ($, e) => {
    if (e.args.trim() === 'skip') {
      await advance($)
      return { text: 'Capi: card skipped' }
    }
    if (e.args.trim() === 'show') {
      closed = false
      $.ui.invalidate('ui.render')
      return { text: 'Capi: back above the prompt' }
    }
    await sync($).catch((err) => (syncReport = 'sync failed: ' + (err?.message ?? err)))
    return { text: statsText(await $.clock.now()) }
  })

  on('turn.start', async ($, e, next) => {
    if (!current) current = (await $.store.get('current')) ?? null
    if (!current) await advance($)
    else refillIfLow($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const hint = activityHint(e.tool, e.command)
    if (hint) activity = [hint, ...activity.filter((a) => a !== hint)].slice(0, 6)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Working or not, unless CAPI_SHOW=working: a card waits until it is answered,
    // and only answering pulls new cards, so a visible band never costs a model call.
    if (e.props.hasSurvey || closed || (cfg.show === 'working' && !e.props.isWorking)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = view(Box, Text, Button, (e.props.bodyColumns ?? 80) - ICON_W, {
      pick: (id, i) => pick($, id, i),
      grade: (id, ok) => grade($, id, ok),
      next: (id) => nextCard($, id),
      speak: () => speak($),
      flag: (id) => flag($, id),
      extra: (id, kind) => toggleExtra($, id, kind),
      verb: (id, index) => {
        verbTab = { id, index }
        $.ui.invalidate('ui.render')
      },
      close: () => {
        closed = true
        $.ui.invalidate('ui.render')
        $.ui.toast('Capi is hidden in this session. /capi show brings it back.')
      },
      size: async () => {
        minimized = !minimized
        $.ui.invalidate('ui.render')
        await $.store.set('minimized', minimized)
      },
    })
    const body = parts.map((p) => (p.flush ? p : indent(Box, Text, p, e.surface)))
    return Box({ flexDirection: 'column', children: fit(body, e.props.maxRows ?? 99, (e.props.bodyColumns ?? 80) - ICON_W) })
  })
}

// The plugin's own .env (see .env.example). No file, or no such key, keeps the default.
async function loadConfig($) {
  try {
    return configFrom(parseEnv(await $.fs.read($.plugin.root + '/.env')))
  } catch {
    return DEFAULT_CONFIG
  }
}

async function machineName($) {
  const saved = await $.store.get('machine')
  if (saved) return saved
  let name = ''
  for (const argv of [['scutil', '--get', 'LocalHostName'], ['hostname', '-s']]) {
    try {
      const r = await $.process.run(argv)
      if (r.exitCode === 0 && /^[\w.-]+$/.test(r.stdout.trim())) name = r.stdout.trim()
    } catch {
      // try the next one
    }
    if (name) break
  }
  name ||= 'mac-' + Math.random().toString(36).slice(2, 8)
  await $.store.set('machine', name)
  return name
}

// ---- drawing ---------------------------------------------------------------

// Parts of the card: { make(cut) } for text that may be cut to one line,
// { node } otherwise. `drop` marks what goes first when the band is short.
function view(Box, Text, Button, cols, act) {
  const s = state
  const text = (t, props = {}, drop = 0) => ({
    text: t,
    drop,
    make: (cut) => Text({ ...props, wrap: cut ? 'truncate-end' : 'wrap', children: [t] }),
  })
  const node = (n) => ({ node: n })
  // An icon in a column of its own, so the header and the question start their
  // text at the same place whatever the icon's drawn width.
  const icon = (glyph) => Box({ width: ICON_W, flexShrink: 0, children: [Text({ children: [glyph] })] })
  // One line of label and value pairs, labels dim, set apart by space alone:
  // the card (categoria, tipo, pergunta), then the learner. 📐 🔤 🇩🇪
  // sit at its right end and never shrink; the values give way first.
  const { card: cardPairs, learner } = headerParts(current?.card, s)
  const pairs = [...cardPairs, ...learner]
  // Too wide for one line beside the toggle: the pairs wrap onto more lines, unless the band is short.
  const pairsWidth = pairs.reduce((n, [k, v]) => n + cells(k) + 1 + cells(v), 0) + GAP * (pairs.length - 1)
  const headRows = Math.max(1, Math.ceil(pairsWidth / Math.max(cols - GAP - 1, 20)))
  const pair = ([k, v], cut) =>
    Box({ flexDirection: 'row', columnGap: 1, flexShrink: 1, children: [Text({ dimColor: true, children: [k] }), Text({ wrap: cut ? 'truncate-end' : 'wrap', children: [v] })] })
  const head = {
    flush: true,
    text: '',
    rows: headRows,
    drop: 0,
    make: (cut, side) =>
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: GAP,
        children: [
          Box({
            flexDirection: 'row',
            flexShrink: 1,
            children: [icon('🦫'), Box({ flexDirection: 'row', flexWrap: cut ? 'nowrap' : 'wrap', columnGap: GAP, flexShrink: 1, children: pairs.map((p) => pair(p, cut)) })],
          }),
          ...(side ? [Box({ flexShrink: 0, children: [side] })] : []),
        ],
      }),
  }
  // The standard window controls, grey text like the hotkey digits: – minimize, □ restore, × close.
  const control = (key, label, onPress) => Button({ key, label, plain: true, dimColor: true, onPress })
  const controls = Box({
    flexDirection: 'row',
    columnGap: 1, // a pair, closer than the GAP between unrelated things
    children: [
      control('size', minimized ? '□' : '–', act.size),
      control('close', '×', act.close),
    ],
  })
  // The header line: the pairs, and the window controls at its right end.
  const top = { ...head, make: (cut) => head.make(cut, controls) }
  // Folded, or with no card yet: the header line with 🔼/🔽 alone at its right.
  if (minimized || !current) {
    if (minimized) return [top]
    const msg = refilling
      ? 'Capi está preparando cartas… ☕'
      : failure
        ? `Capi tropeçou (${failure}). Já já tenta de novo.`
        : 'Capi está sem cartas. Já já tem mais!'
    return [top, text(msg)]
  }
  const { card, stage } = current
  const id = card.id
  // Answers on the left; 🔊 and 🚩 on the right, in line with them.
  // Answers on the left; 🔊 and 🚩 on the right. Short of room, 🔊 and 🚩 drop their words;
  // shorter still, the answers wrap onto more lines.
  const row = (children) => {
    const compact = widthOf(children) + GAP + widthOf(tools(false)) > cols
    const right = tools(compact)
    const rows = Math.max(1, Math.ceil(widthOf(children) / Math.max(cols - GAP - widthOf(right), 10)))
    return {
      icon: '👉',
      buttons: true,
      rows,
      ...node(
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          columnGap: GAP,
          flexGrow: 1, // the whole width after the icon column, so 🔊 🚩 reach the right edge
          children: [
            Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: GAP, flexShrink: 1, children }),
            Box({ flexDirection: 'row', columnGap: GAP, flexShrink: 0, children: right }),
          ],
        }),
      ),
    }
  }
  // A blank line between the blocks of the card. Always kept: when the band is
  // short the note goes and texts are cut instead.
  const gap = { text: '', drop: 0, flush: true, make: () => Text({ children: [' '] }) }
  const flagLabel = current.flagged ? '🚩 marcado' : armed?.id === id ? '🚩 de novo = confirmar' : '🚩 tá errado?'
  // compact: the icon alone, keeping the hotkey digit
  const tools = (compact) => [
    Button({ key: 'speak', label: compact ? '🔊' : '🔊 ouvir', hotkey: '8', plain: true, onPress: act.speak }),
    Button({ key: 'flag', label: compact ? '🚩' : flagLabel, hotkey: '9', plain: true, dimColor: Boolean(current.flagged), onPress: () => act.flag(id) }),
  ]
  const extraButtons = (compact) =>
    Object.entries(EXTRAS).map(([kind, x]) => {
      const isOpen = open?.id === id && open.kind === kind
      const busy = loading?.id === id && loading.kind === kind
      const label = busy ? `${x.icon} …` : compact ? x.icon : isOpen ? `${x.icon} fechar` : `${x.icon} ${x.name}`
      return Button({ key: kind, label, hotkey: x.hotkey, plain: true, onPress: () => act.extra(id, kind) })
    })
  // 📐 🔤 🇩🇪 sit at the right end of the card's first line: the question, or the verdict once
  // answered. Short of room they drop their words; shorter still, the line's text wraps.
  const panelButtons = (line) => {
    const compact = cells(line) + GAP + widthOf(extraButtons(false)) > cols
    return Box({ flexDirection: 'row', columnGap: GAP, children: extraButtons(compact) })
  }
  const question = { ...text(card.question, { bold: true }), icon: '❓', side: panelButtons(card.question) }
  // Asked for, so never dropped to save rows; cut to one line at worst.
  const x = open?.id === id ? EXTRAS[open.kind] : null
  const extra = !x
    ? []
    : x.tables
      ? tables(Box, Text, Button, x.tables(card), verbTab?.id === id ? verbTab.index : 0, (i) => act.verb(id, i))
      : x.lines(card, stage, current.quizOk).map((l) => text(l, { italic: true, dimColor: true }))
  // the panel's icon, once, in the icon column; the verb tabs are buttons and pad themselves
  if (extra.length) extra[0] = { ...extra[0], icon: x.icon, buttons: Boolean(x.tables) }
  // An open panel stands apart from the card with a blank line on either side.
  const panel = extra.length ? [gap, ...extra, gap] : []
  const next = Button({ key: 'next', label: 'próxima', hotkey: '1', plain: true, onPress: () => act.next(id) })
  const note = { ...text(card.note, { dimColor: true }, 1), icon: '📚' }

  if (card.format === 'bonus') {
    return [top, gap, question, text(card.explain), ...panel, note, gap, row([next])]
  }
  if (stage === 'quiz') {
    const options = card.options.map((o, i) =>
      Button({ key: 'opt-' + i, label: o, hotkey: String(i + 1), plain: true, onPress: () => act.pick(id, i) }),
    )
    return [top, gap, question, ...(extra.length ? [gap, ...extra] : []), gap, row(options)]
  }
  const verdict = current.quizOk
    ? `Certo! +${current.gain} · ${card.capiRight}`
    : `Errou! Era «${card.options[card.answer]}» · ${card.capiWrong}`
  const ask = current.graded
    ? [next]
    : [
        Text({ children: [`Kanntest du «${card.item}»?`] }),
        Button({ key: 'yes', label: 'sim', hotkey: '1', plain: true, onPress: () => act.grade(id, true) }),
        Button({ key: 'no', label: 'não', hotkey: '2', plain: true, onPress: () => act.grade(id, false) }),
      ]
  return [
    top,
    gap,
    { ...text(verdict, { color: current.quizOk ? 'green' : 'red' }), icon: current.quizOk ? '✅' : '❌', side: panelButtons(verdict) },
    text(`${card.explain} (Fonte: ${card.source})`),
    ...panel,
    note,
    gap,
    row(ask),
  ]
}

// Conjugation as the morning briefs draw it, one verb at a time: the verbs as
// tabs down the left, the chosen verb's table beside them, the tenses over one
// row per person. Boxes of fixed width keep the columns aligned in the Desktop
// app's proportional font too.
function tables(Box, Text, Button, list, selected, choose) {
  if (!list.length) return []
  const index = Math.min(Math.max(selected, 0), list.length - 1)
  const t = list[index]
  // Every tab drawn alike (a dimmed Desktop button loses its padding, and the
  // tabs would no longer start in one column); ▸ marks the chosen verb.
  // As wide as the longest verb with its ▸ and the button's frame, so the
  // table does not move when another verb is chosen.
  const tabs = Box({
    flexDirection: 'column',
    width: Math.max(...list.map((v) => v.verb.length)) + 4,
    flexShrink: 0,
    children: list.map((v, i) =>
      Button({ key: 'verb-' + i, label: (i === index ? '▸ ' : '') + v.verb, plain: true, onPress: () => choose(i) }),
    ),
  })
  const table = Box({
    flexDirection: 'column',
    children: [t.header, ...t.rows].map((cells, i) =>
      Box({
        flexDirection: 'row',
        children: cells.map((c, j) =>
          Box({ width: t.widths[j] + GAP, children: [Text({ dimColor: (i === 0) !== (j === 0), italic: i === 0 && j > 0, wrap: 'truncate-end', children: [c] })] }),
        ),
      }),
    ),
  })
  return [{ node: Box({ flexDirection: 'row', columnGap: GAP, children: [tabs, table] }), rows: Math.max(list.length, t.rows.length + 1) }]
}

// The cells a row of elements takes: Text by its words, a Button by its label
// plus the hotkey digit and its mark, and GAP between them.
function widthOf(list) {
  const one = (el) =>
    el?.type === 'Button' ? cells(el.props?.label) + (el.props?.hotkey ? 3 : 0) : cells((el?.children ?? []).filter((c) => typeof c === 'string').join(''))
  return list.reduce((n, el) => n + one(el), 0) + GAP * Math.max(0, list.length - 1)
}

// Everything under the header starts where the header's text does: after the
// icon column. Each block names itself there: 🦫 the header, ❓ the question,
// 📐 🔤 🇩🇪 an open panel (on its first line), ✅ ❌ the verdict, 📚 the note,
// 👉 the answers. Parts marked flush draw the column themselves or are blank.
const ICON_W = 2 + GAP
function indent(Box, Text, p, surface) {
  // A Desktop button (one not dimmed) draws its own padding, about a cell; a
  // row that starts with buttons takes that cell from the icon column.
  const width = ICON_W - (p.buttons && surface !== 'terminal' ? 1 : 0)
  const column = Box({ width, flexShrink: 0, children: p.icon ? [Text({ children: [p.icon] })] : [] })
  // p.side sits at the right end of the block's first line, and never shrinks
  const body = (n) =>
    p.side
      ? Box({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', columnGap: GAP, flexGrow: 1, children: [Box({ flexShrink: 1, children: [n] }), Box({ flexShrink: 0, children: [p.side] })] })
      : n
  const shift = (n) => Box({ flexDirection: 'row', alignItems: 'flex-start', children: [column, Box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, children: [body(n)] })] })
  return p.node ? { ...p, node: shift(p.node) } : { ...p, make: (cut) => shift(p.make(cut)) }
}

// A tree taller than the band scrolls, and then the digit hotkeys stop working.
// So: drop the note, then cut every text to one line. Blank lines, the header
// and an open panel stay.
function fit(parts, maxRows, cols) {
  const rows = (p, cut) => (p.make ? (cut ? 1 : (p.rows ?? Math.max(1, Math.ceil(p.text.length / Math.max(cols, 20))))) : (p.rows ?? 1))
  const height = (list, cut) => list.reduce((n, p) => n + rows(p, cut), 0)
  let keep = parts
  for (const level of [1, 2]) if (height(keep, false) > maxRows) keep = keep.filter((p) => p.drop !== level)
  const cut = height(keep, false) > maxRows
  return keep.map((p) => (p.make ? p.make(cut) : p.node))
}

// Opens or closes one extra panel; opening one closes the others. A panel the
// card has no content for yet is generated on that first opening, and the
// result is kept on the shared card, so no session pays for it twice.
async function toggleExtra($, id, kind) {
  if (!current || current.card.id !== id) return
  const x = EXTRAS[kind]
  open = open?.id === id && open.kind === kind ? null : { id, kind }
  $.ui.invalidate('ui.render')
  const card = current.card
  if (open?.kind !== kind || (loading?.id === id && loading.kind === kind) || x.has(card)) return
  loading = { id, kind }
  $.ui.invalidate('ui.render')
  const r = await complete($, x.call, x.request(card))
  loading = null
  const fields = r.ok ? x.parse(r.text) : {}
  if (Object.keys(fields).length === 0) {
    if (open?.id === id && open.kind === kind) open = null
    $.ui.toast(`Capi não conseguiu (${x.name}: ${r.ok ? 'resposta sem conteúdo' : r.reason})`)
  } else {
    const shared = (await $.store.get('current')) ?? null
    if (shared?.card.id === id) {
      current = { ...shared, card: { ...shared.card, ...fields } }
      await $.store.set('current', current)
    } else if (current?.card.id === id) {
      current = { ...current, card: { ...current.card, ...fields } }
    }
  }
  $.ui.invalidate('ui.render')
}

// ---- answering -------------------------------------------------------------

// True when the press belongs to the card and stage that are current here and
// in the store. Otherwise another session moved on, and this one follows.
async function stillMine($, id, stage) {
  const shared = (await $.store.get('current')) ?? null
  const now = await $.clock.now()
  const same = (c) => c && c.card.id === id && c.stage === stage
  if (!same(current) || !same(shared)) {
    current = shared
    $.ui.invalidate('ui.render')
    return false
  }
  return now - (current.at ?? 0) >= PRESS_GUARD_MS
}

async function pick($, id, i) {
  if (!(await stillMine($, id, 'quiz'))) return
  const card = current.card
  const quizOk = i === card.answer
  const gain = quizOk ? 10 + 2 * Math.min(state.combo, 5) : 0
  const graded = ITEM_FORMATS.has(card.format)
  const now = await $.clock.now()
  current = { ...current, stage: 'reveal', at: now, quizOk, gain, graded }
  await $.store.set('current', current)
  $.ui.invalidate('ui.render')
  if (graded) await record($, answerEntry(now, card, quizOk, quizOk ? 'ok' : 'miss'))
}

async function grade($, id, ok) {
  if (!current || current.graded || !(await stillMine($, id, 'reveal'))) return
  await record($, answerEntry(await $.clock.now(), current.card, current.quizOk, ok ? 'ok' : 'miss'))
  await advance($)
}

// "próxima": after a graded reveal, and on a bonus card.
async function nextCard($, id) {
  const stage = current?.stage ?? 'quiz'
  if (!(await stillMine($, id, stage))) return
  if (current.card.format === 'bonus') await record($, answerEntry(await $.clock.now(), current.card, null, null))
  await advance($)
}

function answerEntry(t, card, quiz, result) {
  return {
    type: 'answer',
    id: `${t.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    t,
    machine,
    cardId: card.id,
    item: card.item,
    de: card.de,
    kind: card.kind,
    format: card.format,
    quiz,
    grade: result,
  }
}

async function advance($) {
  const queue = (await $.store.get('queue')) ?? []
  // ponytail: two sessions advancing at the same instant can skip one card; harmless.
  const card = queue.shift() ?? null
  await $.store.set('queue', queue)
  current = card ? { card, stage: 'quiz', at: await $.clock.now() } : null
  await $.store.set('current', current)
  $.ui.invalidate('ui.render')
  refillIfLow($)
}

async function speak($) {
  if (!current) return
  const card = current.card
  const text = current.stage === 'quiz' ? card.question : `${card.item}. ${card.explain}`
  try {
    await $.audio.speak(text, { voice: VOICE })
  } catch {
    $.ui.toast(`Capi braucht die Stimme ${VOICE}: Systemeinstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen`)
  }
}

// The first 9 arms the flag, a second 9 within 10 s confirms it: a stray key
// must not ban a fact and buy a re-check. A flagged fact is never used again,
// and Capi says in the transcript whether it really was wrong.
async function flag($, id) {
  if (!current || current.flagged || !(await stillMine($, id, current.stage))) return
  const now = await $.clock.now()
  if (armed?.id !== id || now - armed.t > FLAG_CONFIRM_MS) {
    armed = { id, t: now }
    $.ui.invalidate('ui.render')
    return
  }
  armed = null
  const card = current.card
  const fact = `${card.question} → ${card.explain}`
  current = { ...current, flagged: true }
  await $.store.set('current', current)
  $.ui.invalidate('ui.render')
  await record($, { type: 'flag', id: `${now.toString(36)}-f${Math.random().toString(36).slice(2, 8)}`, t: now, machine, cardId: id, fact })
  const r = await complete($, CHECK, {
    system:
      'You fact-check one quiz card. Answer in German, in at most three sentences: is the fact correct, wrong or doubtful, and what is true. Name the kind of source you rely on.',
    prompt: `Card: ${fact}\nClaimed source: ${card.source}`,
  })
  $.ui.log(r.ok ? `🚩 Capi hat nachgeprüft: ${r.text.trim()}` : `🚩 Fakt gesperrt; die Nachprüfung kam nicht zurück (${r.reason}).`)
}

// ---- history ---------------------------------------------------------------

// One at a time: two overlapping get-then-set on this session's key would drop one.
function record($, entry) {
  recording = recording.then(() => append($, entry)).catch((err) => (syncReport = 'recording failed: ' + (err?.message ?? err)))
  return recording
}

async function append($, entry) {
  const key = `log:${dayOf(entry.t)}:${sessionId}`
  const mine = (await $.store.get(key)) ?? []
  await $.store.set(key, [...mine, entry])
  entries = merge(entries, [entry])
  state = replay(entries, entry.t)
  $.ui.invalidate('ui.render')
  if (syncTimer) syncTimer.cancel()
  syncTimer = $.clock.after(SYNC_DELAY_MS, () => sync($))
}

// Reads every session's answers on this Mac and every Mac's iCloud files, then
// rewrites the months this Mac still has store entries for. A past day's store
// key is dropped only once a file, read back, holds every one of its entries.
//
// Never writes a month file it could not read, never one with fewer entries
// than it wrote before, and never in place: a reader could see half a file.
async function sync($) {
  const now = await $.clock.now()
  const dir = home + '/' + ICLOUD
  const keys = (await $.store.keys()).filter((k) => k.startsWith('log:'))
  const local = []
  for (const k of keys) {
    const v = await $.store.get(k)
    if (Array.isArray(v)) local.push(...v)
  }

  let listing = null
  try {
    listing = await $.fs.list(dir)
  } catch {
    listing = (await $.fs.exists(dir)) ? null : []
  }
  const files = new Map()
  const evicted = new Set()
  for (const f of listing ?? []) {
    if (f.kind === 'file' && f.name.endsWith('.jsonl')) files.set(f.name, f.size)
    // iCloud keeps a file it has not downloaded yet as ".<name>.icloud"
    const m = /^\.(.+\.jsonl)\.icloud$/.exec(f.name)
    if (m) evicted.add(m[1])
  }
  for (const name of evicted) {
    try {
      await $.process.run(['brctl', 'download', `${dir}/.${name}.icloud`])
    } catch {
      // stays unread and counted below; the next sync asks again
    }
  }

  const readable = new Set()
  const remote = []
  let bad = 0
  for (const [name, size] of files) {
    try {
      const text = await $.fs.read(`${dir}/${name}`)
      // a file iCloud has not materialised can read as empty
      if (size > 0 && !text) continue
      const r = parseJsonl(text)
      remote.push(...r.entries)
      bad += r.bad
      readable.add(name)
    } catch {
      // unreadable: counted below, and never written
    }
  }
  entries = merge(entries, local, remote)
  state = replay(entries, now)
  if (listing === null) {
    syncReport = 'iCloud folder not readable, nothing written'
    return
  }
  const total = files.size + evicted.size
  syncReport = `${readable.size} of ${total} iCloud file${total === 1 ? '' : 's'} read` + (bad ? `, ${bad} damaged lines skipped` : '')

  const months = new Set(local.filter((e) => e.machine === machine).map((e) => monthFile(machine, e.t)))
  const safe = new Set()
  if (months.size) await $.process.run(['mkdir', '-p', dir])
  for (const name of months) {
    const path = `${dir}/${name}`
    if (evicted.has(name) || (files.has(name) && !readable.has(name)) || (!files.has(name) && (await $.fs.exists(path)))) {
      syncReport += ` · ${name} unreadable, not written`
      continue
    }
    const mine = entries.filter((e) => e.machine === machine && monthFile(machine, e.t) === name)
    const before = (await $.store.get('written:' + name)) ?? 0
    if (mine.length < before) {
      syncReport += ` · ${name}: ${mine.length} entries but ${before} written before, not written`
      continue
    }
    try {
      await $.fs.write(path + '.tmp', toJsonl(mine))
      const mv = await $.process.run(['mv', '-f', path + '.tmp', path])
      if (mv.exitCode !== 0) throw new Error(mv.stderr.trim() || 'mv failed')
      const back = parseJsonl(await $.fs.read(path)).entries
      await $.store.set('written:' + name, back.length)
      for (const e of back) safe.add(e.id)
    } catch (err) {
      syncReport += ` · writing ${name} failed: ${err?.message ?? err}`
    }
  }

  const today = dayOf(now)
  for (const k of keys) {
    if (k.split(':')[1] >= today) continue
    const v = (await $.store.get(k)) ?? []
    if (v.every((e) => safe.has(e.id))) await $.store.delete(k)
  }
}

// ---- cards -----------------------------------------------------------------

function refillIfLow($) {
  refill($).catch((err) => {
    refilling = false
    lastBatch = 'failed: ' + (err?.message ?? err)
  })
}

async function refill($) {
  if (refilling) return
  const queue = (await $.store.get('queue')) ?? []
  if (queue.length >= REFILL_BELOW) return
  const now = await $.clock.now()
  const lock = (await $.store.get('refill')) ?? null
  if (lock?.t && now - lock.t < (lock.wait ?? REFILL_LOCK_MS)) return
  // ponytail: set-then-read narrows two sessions starting at once to a tiny window; no compare-and-set exists.
  const mine = { t: now, by: `${sessionId}:${Math.random().toString(36).slice(2, 8)}` }
  await $.store.set('refill', mine)
  if ((await $.store.get('refill'))?.by !== mine.by) return
  refilling = true
  $.ui.invalidate('ui.render')
  let added = 0
  try {
    await sync($)
    const req = buildRequest({ now, state, queue, activity, total: BATCH, cfg })
    // The lock covers the model call itself, not the sync before it.
    await $.store.set('refill', { ...mine, t: await $.clock.now() })
    const r = await complete($, GENERATE, req)
    if (!r.ok) {
      const free = /^(api-error|aborted)/.test(r.reason)
      const wait = free ? RETRY_FREE_MS : REFILL_LOCK_MS
      await $.store.set('refill', { ...mine, t: await $.clock.now(), wait })
      failure = r.reason
      lastBatch = `failed: ${r.reason}`
      $.ui.log(`Capi bekam keine Karten (${r.reason}); nächster Versuch in ${wait / 60_000} Minute${wait === 60_000 ? '' : 'n'}`)
      return
    }
    failure = ''
    const { cards, dropped } = parseCards(r.text, now)
    lastBatch = `${cards.length} of ${cards.length + dropped} cards usable (asked for ${req.count})`
    if (cards.length === 0) $.ui.log(`Capi bekam keine brauchbaren Karten: ${lastBatch}`)
    const fresh = (await $.store.get('queue')) ?? []
    await $.store.set('queue', [...fresh, ...cards])
    added = cards.length
  } finally {
    refilling = false
    // Only a batch that delivered frees the lock; a failure keeps it as the backoff.
    if (added > 0) await $.store.set('refill', null)
    $.ui.invalidate('ui.render')
  }
  if (added > 0 && !current) await advance($)
}

// One model call. Resolves to { ok, text } or { ok: false, reason }; never rejects.
async function complete($, opts, req) {
  const base = { model: opts.model, system: req.system, prompt: req.prompt, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs }
  // An API error says its HTTP status and kind; the bare reason alone hides both.
  const answer = (r) =>
    typeof r === 'string'
      ? { ok: true, text: r }
      : r?.isAnswered
        ? { ok: true, text: r.text }
        : { ok: false, reason: [r?.reason ?? 'no answer', r?.status, r?.error].filter((x) => x != null).join(' ') }
  if (!effortRefused) {
    try {
      return answer(await $.model.complete({ ...base, effort: opts.effort }))
    } catch (err) {
      // Only when the same call without `effort` goes through was `effort` the problem.
      try {
        const r = answer(await $.model.complete(base))
        effortRefused = true
        $.ui.log(`Capi: effort "${opts.effort}" was refused (${err?.message ?? err}); using the model's default effort`)
        return r
      } catch {
        return { ok: false, reason: String(err?.message ?? err) }
      }
    }
  }
  try {
    return answer(await $.model.complete(base))
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) }
  }
}

// Follows the card another session moved to, and keeps cards coming.
async function poll($) {
  const shared = (await $.store.get('current')) ?? null
  const key = (c) =>
    c ? `${c.card.id}:${c.stage}:${c.flagged ? 1 : 0}:${Object.values(EXTRAS).map((x) => (x.has(c.card) ? 1 : 0)).join('')}` : ''
  if (key(shared) !== key(current)) {
    current = shared
    $.ui.invalidate('ui.render')
  }
  if (current) return
  const queue = (await $.store.get('queue')) ?? []
  if (queue.length) await advance($)
  else refillIfLow($)
}

function statsText(now) {
  const s = state
  const due = [...s.items.values()].filter((it) => it.due <= now).length
  const next = s.level.next === null ? 'top level' : `next level at ${s.level.next}`
  return [
    `🦫 ${s.level.name} · ${s.known} expressions known (${next})`,
    `🔥 streak ${s.streak} day${s.streak === 1 ? '' : 's'} · combo x${s.combo} (best ${s.bestCombo}) · ${s.points} points`,
    `📚 learning ${s.learning} · due now ${due} · new today ${s.todayNew}`,
    `☁️ ${machine}: ${syncReport} · last batch: ${lastBatch}`,
  ].join('\n')
}
