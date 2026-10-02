// Capi teaches Brazilian Portuguese in the band above the prompt while Claude works.
//
// Where things live:
//   $.store 'log:<day>:<session>'   this session's answers that day (one writer per key)
//   $.store 'queue' / 'current'     the cards every session on this Mac shares
//   $.store 'machine'               this Mac's name, fixed on first use
//   iCloud ptbr/<Mac>-<YYYY-MM>.jsonl  each Mac's history per month; every Mac reads all

import { replay, dayOf } from './lib/srs.js'
import { parseJsonl, toJsonl, merge, monthFile } from './lib/log.js'
import { buildRequest, parseCards, activityHint, germanLines, headerParts, translationRequest, parseTranslation, ITEM_FORMATS } from './lib/cards.js'

// The facts have to be TRUE, so batches go to Opus at high effort. They run in
// the background while cards are still queued, so the latency costs nothing.
const GENERATE = { model: 'claude-opus-5-5', effort: 'high', maxTokens: 32000, timeoutMs: 300_000 }
// A 🚩 asks whether one claim really is wrong: rare, and worth the most care.
const CHECK = { model: 'claude-opus-5-5', effort: 'xhigh', maxTokens: 2000, timeoutMs: 300_000 }
// Translating one older card on demand: a small, plain job.
const TRANSLATE = { model: 'claude-opus-5-5', effort: 'low', maxTokens: 1500, timeoutMs: 60_000 }
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
// The card whose German translation is open in this session, if any.
let translated = null
let translating = null
let syncReport = 'not synced yet'
let lastBatch = 'none yet'
let failure = ''
let effortRefused = false

export function register(on) {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    sessionId = await $.session.id()
    machine = await machineName($)
    current = (await $.store.get('current')) ?? null
    $.clock.every(POLL_MS, () => poll($))
    // Not awaited: a slow or offline iCloud must not hold up the first prompt.
    sync($).catch((err) => (syncReport = 'sync failed: ' + (err?.message ?? err)))
    await $.command.register({
      name: 'ptbr',
      description: 'Capi: your Portuguese progress (skip: next card)',
      argumentHint: '[skip]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'ptbr' }, async ($, e) => {
    if (e.args.trim() === 'skip') {
      await advance($)
      return { text: 'Capi: card skipped' }
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
    // Always there, working or not: a card waits until it is answered, and only
    // answering pulls new cards, so a visible band never costs a model call.
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = view(Box, Text, Button, {
      pick: (id, i) => pick($, id, i),
      grade: (id, ok) => grade($, id, ok),
      next: (id) => nextCard($, id),
      speak: () => speak($),
      flag: (id) => flag($, id),
      translate: (id) => toggleTranslation($, id),
    })
    return Box({ flexDirection: 'column', children: fit(parts, e.props.maxRows ?? 99, e.props.bodyColumns ?? 80) })
  })
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
function view(Box, Text, Button, act) {
  const s = state
  const text = (t, props = {}, drop = 0) => ({
    text: t,
    drop,
    make: (cut) => Text({ ...props, wrap: cut ? 'truncate-end' : 'wrap', children: [t] }),
  })
  const node = (n) => ({ node: n })
  // Category in bold, a divider, then the learner's level, streak and combo, dimmed.
  const { category, standing } = headerParts(current?.card, s)
  const head = {
    text: ['🦫', category, '│', standing].filter(Boolean).join('  '),
    drop: 2,
    make: (cut) =>
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ children: ['🦫'] }),
          ...(category ? [Text({ bold: true, wrap: cut ? 'truncate-end' : 'wrap', children: [category] }), Text({ dimColor: true, children: ['│'] })] : []),
          Text({ dimColor: true, wrap: cut ? 'truncate-end' : 'wrap', children: [standing] }),
        ],
      }),
  }
  if (!current) {
    const msg = refilling
      ? 'Capi está preparando cartas… ☕'
      : failure
        ? `Capi tropeçou (${failure}). Já já tenta de novo.`
        : 'Capi está sem cartas. Já já tem mais!'
    return [head, text(msg)]
  }
  const { card, stage } = current
  const id = card.id
  // Answers on the left; 🔊 and 🚩 on the right, in line with them.
  const row = (children) =>
    node(
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          Box({ flexDirection: 'row', columnGap: 3, children }),
          Box({ flexDirection: 'row', columnGap: 3, children: tools }),
        ],
      }),
    )
  // A blank line under the header and above the buttons; both go first when
  // the band is short.
  const gap = { text: '', drop: 1, make: () => Text({ children: [' '] }) }
  const flagLabel = current.flagged ? '🚩 marcado' : armed?.id === id ? '🚩 de novo = confirmar' : '🚩 tá errado?'
  const tools = [
    Button({ key: 'speak', label: '🔊 ouvir', hotkey: '8', plain: true, onPress: act.speak }),
    Button({ key: 'flag', label: flagLabel, hotkey: '9', plain: true, dimColor: Boolean(current.flagged), onPress: () => act.flag(id) }),
  ]
  const german = germanLines(card, stage, current.quizOk)
  const deLabel = translating === id ? '🇩🇪 traduzindo…' : translated === id ? '🇩🇪 esconder' : '🇩🇪 tradução'
  const deButton = Button({ key: 'de', label: deLabel, hotkey: '0', plain: true, onPress: () => act.translate(id) })
  // 🇩🇪 sits at the top right, in the header, so the header is never dropped.
  const top = {
    text: head.text,
    drop: 0,
    make: (cut) => Box({ flexDirection: 'row', justifyContent: 'space-between', children: [head.make(cut), deButton] }),
  }
  // Asked for, so never dropped to save rows; cut to one line at worst.
  const de = translated === id ? german.map((l) => text('🇩🇪 ' + l, { italic: true, dimColor: true })) : []
  const next = Button({ key: 'next', label: 'próxima', hotkey: '1', plain: true, onPress: () => act.next(id) })
  const note = text('📚 ' + card.note, { dimColor: true }, 1)

  if (card.format === 'bonus') {
    return [top, gap, text(ASK.bonus, { bold: true }), text(card.question), text(card.explain), ...de, note, gap, row([next])]
  }
  if (stage === 'quiz') {
    const options = card.options.map((o, i) =>
      Button({ key: 'opt-' + i, label: o, hotkey: String(i + 1), plain: true, onPress: () => act.pick(id, i) }),
    )
    return [top, gap, text('❓ ' + ASK[card.format], { bold: true }), text(card.question), ...de, gap, row(options)]
  }
  const verdict = current.quizOk
    ? `✅ Certo! +${current.gain} · ${card.capiRight}`
    : `❌ Errou! Era «${card.options[card.answer]}» · ${card.capiWrong}`
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
    text(verdict, { color: current.quizOk ? 'green' : 'red' }),
    text(`${card.explain} (Fonte: ${card.source})`),
    ...de,
    note,
    gap,
    row(ask),
  ]
}

// A tree taller than the band scrolls, and then the digit hotkeys stop working.
// So: drop the note, then the header, then cut every text to one line.
function fit(parts, maxRows, cols) {
  const rows = (p, cut) => (p.make && !cut ? Math.max(1, Math.ceil(p.text.length / Math.max(cols, 20))) : 1)
  const height = (list, cut) => list.reduce((n, p) => n + rows(p, cut), 0)
  let keep = parts
  for (const level of [1, 2]) if (height(keep, false) > maxRows) keep = keep.filter((p) => p.drop !== level)
  const cut = height(keep, false) > maxRows
  return keep.map((p) => (p.make ? p.make(cut) : p.node))
}

// Opens or closes the German lines. A card made before translations existed
// is translated on the first open, and the result is kept on the shared card.
async function toggleTranslation($, id) {
  if (!current || current.card.id !== id) return
  translated = translated === id ? null : id
  $.ui.invalidate('ui.render')
  const card = current.card
  if (translated !== id || translating === id || card.questionDe || card.explainDe) return
  translating = id
  $.ui.invalidate('ui.render')
  const r = await complete($, TRANSLATE, translationRequest(card))
  translating = null
  const fields = r.ok ? parseTranslation(r.text) : {}
  if (Object.keys(fields).length === 0) {
    if (translated === id) translated = null
    $.ui.toast(`Capi não conseguiu traduzir (${r.ok ? 'resposta sem tradução' : r.reason})`)
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
    const req = buildRequest({ now, state, queue, activity, total: BATCH })
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
  const key = (c) => (c ? `${c.card.id}:${c.stage}:${c.flagged ? 1 : 0}:${c.card.questionDe ? 1 : 0}` : '')
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
