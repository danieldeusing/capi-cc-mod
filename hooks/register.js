// Capi teaches Brazilian Portuguese in the band above the prompt while Claude works.
//
// Where things live:
//   $.store 'log:<day>:<session>'  this session's answers that day (one writer per key)
//   $.store 'queue' / 'current'    the cards every session on this Mac shares
//   iCloud ptbr/<Mac>.jsonl        each Mac's whole history; every Mac reads all of them

import { replay, dayOf } from './lib/srs.js'
import { parseJsonl, toJsonl, merge } from './lib/log.js'
import { buildRequest, parseCards, ITEM_FORMATS } from './lib/cards.js'

// The facts have to be TRUE, so batches go to Opus at high effort. They run in
// the background while cards are still queued, so the latency costs nothing.
const GENERATE = { model: 'claude-opus-5-5', effort: 'high', maxTokens: 12000, timeoutMs: 300_000 }
// A 🚩 asks whether one claim really is wrong: rare, and worth the most care.
const CHECK = { model: 'claude-opus-5-5', effort: 'xhigh', maxTokens: 2000, timeoutMs: 300_000 }
const BATCH = 10
const REFILL_BELOW = 4
const POLL_MS = 3000
const SYNC_DELAY_MS = 5000
// A refill another session started counts as running for this long.
const REFILL_LOCK_MS = 6 * 60_000
const VOICE = 'Luciana'
const ICLOUD = 'Library/Mobile Documents/com~apple~CloudDocs/ptbr'

const ASK = {
  tf: 'Verdade ou mentira?',
  mc: 'Qual é a resposta?',
  number: 'Chuta o número!',
  cloze: 'Complete a frase:',
  meaning: 'O que significa?',
  bonus: '✨ Bônus do Capi',
}

let home = ''
let machine = 'mac'
let sessionId = 'session'
let working = false
let entries = []
let state = replay([], 0)
let current = null
let activity = []
let refilling = false
let syncTimer = null
let syncReport = 'not synced yet'
let lastBatch = 'none yet'
let effortRefused = false

export function register(on) {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    sessionId = await $.session.id()
    try {
      const r = await $.process.run(['scutil', '--get', 'LocalHostName'])
      if (r.exitCode === 0 && r.stdout.trim()) machine = r.stdout.trim()
    } catch {
      // keeps 'mac'; only the history file's name depends on it
    }
    await sync($)
    current = (await $.store.get('current')) ?? null
    $.clock.every(POLL_MS, () => poll($))
    await $.command.register({ name: 'ptbr', description: 'Capi: your Portuguese progress', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'ptbr' }, async ($) => {
    await sync($)
    return { text: statsText(await $.clock.now()) }
  })

  on('turn.start', async ($, e, next) => {
    working = true
    if (!current) current = (await $.store.get('current')) ?? null
    if (!current) await advance($)
    else refillIfLow($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    working = false
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Remembers WHAT Claude is doing (the tool, or a Bash command's first two
  // words), never arguments, so a card can match the moment without secrets.
  on('tool.call', async ($, e, next) => {
    const hint = e.tool === 'Bash' ? String(e.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ') : e.tool
    if (hint) activity = [hint, ...activity.filter((a) => a !== hint)].slice(0, 6)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.props.isWorking || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: view(Box, Text, Button, {
        pick: (i) => pick($, i),
        grade: (ok) => grade($, ok),
        next: () => nextCard($),
        speak: () => speak($),
        flag: () => flag($),
      }),
    })
  })
}

// ---- drawing ---------------------------------------------------------------

function view(Box, Text, Button, act) {
  const s = state
  const head = Text({
    dimColor: true,
    children: [`🦫 Capi · ${s.level.name} · 🔥 ${s.streak} dia${s.streak === 1 ? '' : 's'} · combo x${s.combo}`],
  })
  if (!current) {
    const msg = refilling ? 'Capi está preparando cartas… ☕' : 'Capi está sem cartas. Já já tem mais!'
    return [head, Text({ children: [msg] })]
  }
  const { card, stage } = current
  const row = (children) => Box({ flexDirection: 'row', columnGap: 3, children })
  const tools = [
    Button({ key: 'speak', label: '🔊 ouvir', hotkey: '8', plain: true, onPress: act.speak }),
    Button({
      key: 'flag',
      label: current.flagged ? '🚩 marcado' : '🚩 tá errado?',
      hotkey: '9',
      plain: true,
      dimColor: Boolean(current.flagged),
      onPress: act.flag,
    }),
  ]
  const next = Button({ key: 'next', label: 'próxima', hotkey: '1', plain: true, onPress: act.next })

  if (card.format === 'bonus') {
    return [
      head,
      Text({ bold: true, children: [ASK.bonus] }),
      Text({ wrap: 'wrap', children: [card.question] }),
      Text({ wrap: 'wrap', children: [card.explain] }),
      Text({ dimColor: true, wrap: 'wrap', children: ['📚 ' + card.note] }),
      row([next, ...tools]),
    ]
  }

  if (stage === 'quiz') {
    const options = card.options.map((o, i) =>
      Button({ key: 'opt-' + i, label: o, hotkey: String(i + 1), plain: true, onPress: () => act.pick(i) }),
    )
    return [
      head,
      Text({ bold: true, children: ['❓ ' + ASK[card.format]] }),
      Text({ wrap: 'wrap', children: [card.question] }),
      row([...options, ...tools]),
    ]
  }

  const verdict = current.quizOk
    ? `✅ Certo! +${current.gain} · ${card.capiRight}`
    : `❌ Errou! Era «${card.options[card.answer]}» · ${card.capiWrong}`
  const ask = current.graded
    ? [next]
    : [
        Text({ children: [`Kanntest du «${card.item}»?`] }),
        Button({ key: 'yes', label: 'sim', hotkey: '1', plain: true, onPress: () => act.grade(true) }),
        Button({ key: 'no', label: 'não', hotkey: '2', plain: true, onPress: () => act.grade(false) }),
      ]
  return [
    head,
    Text({ color: current.quizOk ? 'green' : 'red', wrap: 'wrap', children: [verdict] }),
    Text({ wrap: 'wrap', children: [`${card.explain} (Fonte: ${card.source})`] }),
    Text({ dimColor: true, wrap: 'wrap', children: ['📚 ' + card.note] }),
    row([...ask, ...tools]),
  ]
}

// ---- answering -------------------------------------------------------------

// True when the store still holds the card at the stage this session shows.
// Another session may have answered it meanwhile; then this one follows.
async function stillMine($) {
  const shared = (await $.store.get('current')) ?? null
  if (!current || !shared || shared.card.id !== current.card.id || shared.stage !== current.stage) {
    current = shared
    $.ui.invalidate('ui.render')
    return false
  }
  return true
}

async function pick($, i) {
  if (!current || current.stage !== 'quiz' || !(await stillMine($))) return
  const card = current.card
  const quizOk = i === card.answer
  const gain = quizOk ? 10 + 2 * Math.min(state.combo, 5) : 0
  const graded = ITEM_FORMATS.has(card.format)
  current = { ...current, stage: 'reveal', quizOk, gain, graded }
  await $.store.set('current', current)
  $.ui.invalidate('ui.render')
  if (graded) await record($, answerEntry(await $.clock.now(), card, quizOk, quizOk ? 'ok' : 'miss'))
}

async function grade($, ok) {
  if (!current || current.stage !== 'reveal' || current.graded || !(await stillMine($))) return
  await record($, answerEntry(await $.clock.now(), current.card, current.quizOk, ok ? 'ok' : 'miss'))
  await advance($)
}

// "próxima": after a graded reveal, and on a bonus card.
async function nextCard($) {
  if (!current || !(await stillMine($))) return
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
  current = card ? { card, stage: 'quiz' } : null
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

// A flagged fact is never used again. Capi then re-checks the claim and says in
// the transcript whether it really was wrong.
async function flag($) {
  if (!current || current.flagged) return
  const card = current.card
  const fact = `${card.question} → ${card.explain}`
  current = { ...current, flagged: true }
  await $.store.set('current', current)
  $.ui.invalidate('ui.render')
  const t = await $.clock.now()
  await record($, { type: 'flag', id: `${t.toString(36)}-f${Math.random().toString(36).slice(2, 8)}`, t, machine, cardId: card.id, fact })
  const r = await complete($, CHECK, {
    system:
      'You fact-check one quiz card. Answer in German, in at most three sentences: is the fact correct, wrong or doubtful, and what is true. Name the kind of source you rely on.',
    prompt: `Card: ${fact}\nClaimed source: ${card.source}`,
  })
  $.ui.log(r.ok ? `🚩 Capi hat nachgeprüft: ${r.text.trim()}` : `🚩 Fakt gesperrt; die Nachprüfung kam nicht zurück (${r.reason}).`)
}

// ---- history ---------------------------------------------------------------

async function record($, entry) {
  const key = `log:${dayOf(entry.t)}:${sessionId}`
  const mine = (await $.store.get(key)) ?? []
  await $.store.set(key, [...mine, entry])
  entries = merge(entries, [entry])
  state = replay(entries, entry.t)
  $.ui.invalidate('ui.render')
  if (syncTimer) syncTimer.cancel()
  syncTimer = $.clock.after(SYNC_DELAY_MS, () => sync($))
}

// Reads every session's answers on this Mac and every Mac's iCloud file, then
// writes this Mac's whole history back to its own file. A past day's store key
// is dropped only once the file, read back, holds every one of its entries.
async function sync($) {
  const now = await $.clock.now()
  const dir = home + '/' + ICLOUD
  const own = machine + '.jsonl'
  const keys = (await $.store.keys()).filter((k) => k.startsWith('log:'))
  const local = []
  for (const k of keys) {
    const v = await $.store.get(k)
    if (Array.isArray(v)) local.push(...v)
  }

  let listing = []
  try {
    listing = await $.fs.list(dir)
  } catch {
    listing = []
  }
  const files = listing.filter((f) => f.kind === 'file' && f.name.endsWith('.jsonl')).map((f) => f.name)
  // iCloud keeps a file it has not downloaded yet as ".<name>.icloud"
  const evicted = listing.filter((f) => /^\..+\.jsonl\.icloud$/.test(f.name)).map((f) => f.name.slice(1, -'.icloud'.length))
  for (const name of evicted) {
    try {
      await $.process.run(['brctl', 'download', dir + '/.' + name + '.icloud'])
    } catch {
      // stays unread and counted below; the next sync asks again
    }
  }

  const remote = []
  let read = 0
  let bad = 0
  let ownReadable = !evicted.includes(own)
  for (const name of files) {
    try {
      const r = parseJsonl(await $.fs.read(dir + '/' + name))
      remote.push(...r.entries)
      bad += r.bad
      read += 1
    } catch {
      if (name === own) ownReadable = false
    }
  }
  entries = merge(entries, local, remote)
  state = replay(entries, now)
  const total = files.length + evicted.length
  syncReport = `${read} of ${total} iCloud file${total === 1 ? '' : 's'} read` + (bad ? `, ${bad} damaged lines skipped` : '')

  // Never overwrite this Mac's file with less than it holds.
  if (!ownReadable) {
    syncReport += ` · ${own} not readable, not written`
    return
  }
  try {
    await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(dir + '/' + own, toJsonl(entries.filter((e) => e.machine === machine)))
    const back = new Set(parseJsonl(await $.fs.read(dir + '/' + own)).entries.map((e) => e.id))
    const today = dayOf(now)
    for (const k of keys) {
      if (k.split(':')[1] >= today) continue
      const v = (await $.store.get(k)) ?? []
      if (v.every((e) => back.has(e.id))) await $.store.delete(k)
    }
  } catch (err) {
    syncReport += ` · writing ${own} failed: ${err?.message ?? err}`
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
  const lock = (await $.store.get('refill')) ?? 0
  if (now - lock < REFILL_LOCK_MS) return
  refilling = true
  await $.store.set('refill', now)
  $.ui.invalidate('ui.render')
  try {
    await sync($)
    const req = buildRequest({ now, state, queue, activity, total: BATCH })
    const r = await complete($, GENERATE, req)
    if (!r.ok) {
      lastBatch = `failed: ${r.reason}`
      $.ui.log(`Capi bekam keine Karten: ${r.reason}`)
      return
    }
    const { cards, dropped } = parseCards(r.text, now)
    lastBatch = `${cards.length} of ${cards.length + dropped} cards usable (asked for ${req.count})`
    if (cards.length === 0) $.ui.log(`Capi bekam keine brauchbaren Karten: ${lastBatch}`)
    const fresh = (await $.store.get('queue')) ?? []
    await $.store.set('queue', [...fresh, ...cards])
  } finally {
    refilling = false
    await $.store.set('refill', 0)
  }
  if (!current) await advance($)
  $.ui.invalidate('ui.render')
}

// One model call. Resolves to { ok, text } or { ok: false, reason }; never rejects.
async function complete($, opts, req) {
  const base = { model: opts.model, system: req.system, prompt: req.prompt, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs }
  let r
  try {
    r = await $.model.complete(effortRefused ? base : { ...base, effort: opts.effort })
  } catch (err) {
    if (effortRefused) return { ok: false, reason: String(err?.message ?? err) }
    // A build that refuses `effort` runs at the model's default, and says so once.
    effortRefused = true
    $.ui.log(`Capi: effort "${opts.effort}" was refused (${err?.message ?? err}); using the model's default effort`)
    try {
      r = await $.model.complete(base)
    } catch (err2) {
      return { ok: false, reason: String(err2?.message ?? err2) }
    }
  }
  if (typeof r === 'string') return { ok: true, text: r }
  if (r?.isAnswered) return { ok: true, text: r.text }
  return { ok: false, reason: r?.reason ?? 'no answer' }
}

// Follows the card another session moved to, and keeps cards coming.
async function poll($) {
  if (!working) return
  const shared = (await $.store.get('current')) ?? null
  const key = (c) => (c ? `${c.card.id}:${c.stage}:${c.flagged ? 1 : 0}` : '')
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
