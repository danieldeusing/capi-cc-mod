import React from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import cards from './cards.json'

// 38 s at 30 fps. Each beat is the frame a key is pressed.
export const DURATION = 1130
const T = { band: 40, de: 150, gram: 240, answer: 360, conj: 450, ser: 540, b: 620, bAnswer: 700, bSim: 790, c: 840, cAnswer: 920, end: 1040 }
type Card = (typeof cards)[number]
const KIND: Record<string, string> = { spoken: 'Fala', grammar: 'Gramática', vocab: 'Vocabulário' }
// what happens to each card: when it appears, which option is pressed when, and the level shown
const SCENES = [
  { card: cards[0], start: T.band, answer: T.answer, pick: 1, known: 1 },
  { card: cards[1], start: T.b, answer: T.bAnswer, pick: 0, sim: T.bSim, known: 2 },
  { card: cards[2], start: T.c, answer: T.cAnswer, pick: 0, known: 3 },
]

const C = {
  bg: '#141413',
  window: '#1f1e1d',
  band: '#2a2927',
  border: '#3a3936',
  text: '#ecebe8',
  dim: '#8e8c88',
  green: '#7bc47f',
  red: '#e06c6c',
  accent: '#d97757',
}
const FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif'
const ICON = 56

const at = (f: number, start: number, len = 12) => interpolate(f, [start, start + len], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })

function Key({ k, label, pressed, dim }: { k?: string; label: string; pressed?: number; dim?: boolean }) {
  const f = useCurrentFrame()
  const flash = pressed !== undefined && f >= pressed && f < pressed + 10 ? 1 - (f - pressed) / 10 : 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '2px 8px', borderRadius: 6, background: `rgba(217,119,87,${0.45 * flash})`, color: dim ? C.dim : C.text }}>
      {k && <span style={{ border: `1px solid ${C.border}`, borderRadius: 5, padding: '0 7px', fontSize: 18, color: C.dim }}>{k}</span>}
      {label}
    </span>
  )
}

function Row({ icon, children, right }: { icon?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 18 }}>
      <div style={{ width: ICON, flexShrink: 0 }}>{icon}</div>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
        <div style={{ flex: 1 }}>{children}</div>
        {right && <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>{right}</div>}
      </div>
    </div>
  )
}

function Header({ card, known }: { card: Card; known: number }) {
  const pairs = [['categoria', card.topic], ['tipo', KIND[card.kind]], ['nível', `Turista ${known}/50`]]
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <div style={{ width: ICON }}>🦫</div>
      <div style={{ flex: 1, display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        {pairs.map(([k, v]) => (
          <span key={k}>
            <span style={{ color: C.dim }}>{k}</span> {v}
          </span>
        ))}
      </div>
      <span style={{ color: C.dim, letterSpacing: 8 }}>–×</span>
    </div>
  )
}

function Table({ verb }: { verb: (typeof cards)[0]['verbs'][number] }) {
  const persons = ['eu', 'você', 'ele/ela', 'nós', 'vocês']
  const tenses = ['presente', 'pretérito perfeito', 'futuro']
  const cell = { padding: '3px 20px 3px 0', fontSize: 25 }
  return (
    <table style={{ borderCollapse: 'collapse' }}>
      <tbody>
        <tr>
          <td style={cell} />
          {tenses.map((t) => (
            <td key={t} style={{ ...cell, color: C.dim, fontStyle: 'italic' }}>{t}</td>
          ))}
        </tr>
        {persons.map((p, i) => (
          <tr key={p}>
            <td style={{ ...cell, color: C.dim }}>{p}</td>
            {tenses.map((t) => (
              <td key={t} style={cell}>{(verb.tenses as Record<string, string[]>)[t][i]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Band() {
  const f = useCurrentFrame()
  const scene = [...SCENES].reverse().find((s) => f >= s.start) ?? SCENES[0]
  const { card } = scene
  const first = scene === SCENES[0]
  const answered = f >= scene.answer
  const right = scene.pick === card.answer
  // one panel at a time, as in the mod: 📐 replaces 🇩🇪
  const showDe = first && f >= T.de && f < T.gram
  const showGram = first && f >= T.gram && f < T.answer
  const showConj = first && f >= T.conj
  const verb = f >= T.ser ? cards[0].verbs[1] : cards[0].verbs[0]
  const panelButtons = (
    <>
      <Key k="6" label="📐" pressed={first ? T.gram : undefined} />
      <Key k="7" label="🔤" pressed={first ? T.conj : undefined} />
      <Key k="0" label="🇩🇪" pressed={first ? T.de : undefined} />
    </>
  )
  const verdict = right ? `Certo! +${first ? 10 : 12} · ${card.capiRight}` : `Errou! Era «${card.options[card.answer]}» · ${card.capiWrong}`
  return (
    <div style={{ background: C.band, border: `1px solid ${C.border}`, borderRadius: 14, padding: '24px 28px', fontSize: 28, color: C.text, lineHeight: 1.35 }}>
      <Header card={card} known={scene.known} />
      <div style={{ opacity: first ? 1 : at(f, scene.start, 8) }}>
        {!answered ? (
          <Row icon="❓" right={panelButtons}>
            <b>{card.question}</b>
          </Row>
        ) : (
          <Row icon={right ? '✅' : '❌'} right={panelButtons}>
            <span style={{ color: right ? C.green : C.red }}>{verdict}</span>
            <div style={{ marginTop: 8, opacity: at(f, scene.answer + 4) }}>{card.explain} (Fonte: {card.source})</div>
          </Row>
        )}
        {showDe && (
          <Row icon="🇩🇪">
            <i style={{ color: C.dim, opacity: at(f, T.de + 2) }}>{cards[0].questionDe}</i>
          </Row>
        )}
        {showGram && (
          <Row icon="📐">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: at(f, T.gram + 2) }}>
              {cards[0].grammarDe.map((l) => (
                <i key={l} style={{ color: C.dim, fontSize: 25 }}>{l}</i>
              ))}
            </div>
          </Row>
        )}
        {showConj && (
          <Row icon="🔤">
            <div style={{ display: 'flex', gap: 30, opacity: at(f, T.conj + 2) }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 25 }}>
                {cards[0].verbs.map((v, i) => (
                  <Key key={v.infinitive} label={(v === verb ? '▸ ' : '') + v.infinitive} pressed={i === 1 ? T.ser : undefined} />
                ))}
              </div>
              <Table verb={verb} />
            </div>
          </Row>
        )}
        {answered && (
          <Row icon="📚">
            <div style={{ color: C.dim, opacity: at(f, scene.answer + 8), display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{card.note}</div>
          </Row>
        )}
        <Row
          icon="👉"
          right={
            <>
              <Key k="8" label="🔊" />
              <Key k="9" label="🚩" />
            </>
          }
        >
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
            {answered ? (
              <>
                <span>Kanntest du «{card.item}»?</span>
                <Key k="1" label="sim" pressed={scene.sim} />
                <Key k="2" label="não" />
              </>
            ) : (
              card.options.map((o, i) => <Key key={o} k={String(i + 1)} label={o} pressed={i === scene.pick ? scene.answer : undefined} />)
            )}
          </div>
        </Row>
      </div>
    </div>
  )
}

const CAPTIONS: [number, string][] = [
  [0, 'Claude Code is working…'],
  [T.band, 'meanwhile, Capi asks a question'],
  [T.de, 'peek at the translation'],
  [T.gram, 'grammar notes for this very sentence'],
  [T.answer, 'answer, and learn a real fact'],
  [T.conj, 'conjugations, one key away'],
  [T.b, 'every card: a true fact and one expression'],
  [T.bAnswer, 'the expression, explained in your language'],
  [T.c, 'grammar cards, built on real facts'],
  [T.cAnswer, 'missed? it comes back in 20 minutes'],
]

export function Capi() {
  const f = useCurrentFrame()
  const { fps, width } = useVideoConfig()
  // wider than square: the band takes the width too
  const side = width > 1080 ? 80 : 40
  const rise = spring({ frame: f - T.band, fps, config: { damping: 18 } })
  const caption = [...CAPTIONS].reverse().find(([t]) => f >= t)![1]
  const endIn = at(f, T.end, 20)
  const dots = '.'.repeat(1 + (Math.floor(f / 8) % 3))
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT, color: C.text }}>
      <AbsoluteFill style={{ opacity: 1 - endIn, padding: `40px ${side}px`, justifyContent: 'flex-end' }}>
        <div style={{ position: 'absolute', top: 56, left: 0, right: 0, textAlign: 'center', fontSize: 40, fontWeight: 600 }}>{caption}</div>
        <div style={{ transform: `translateY(${(1 - rise) * 500}px)`, opacity: rise, marginBottom: 20 }}>
          <Band />
        </div>
        <div style={{ background: C.window, border: `1px solid ${C.border}`, borderRadius: 14, padding: '22px 26px', fontSize: 24 }}>
          <div style={{ color: C.accent }}>✻ Thinking{dots}</div>
          <div style={{ color: C.dim, marginTop: 10 }}>&gt; sync the history files across both Macs</div>
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: endIn, justifyContent: 'center', alignItems: 'center', textAlign: 'center', gap: 26, padding: 80 }}>
        <div style={{ fontSize: 140 }}>🦫</div>
        <div style={{ fontSize: 64, fontWeight: 700 }}>Capi</div>
        <div style={{ fontSize: 36, lineHeight: 1.35 }}>a Claude Code mod to learn a language while it works</div>
        <div style={{ fontSize: 30, color: C.accent, marginTop: 20 }}>github.com/danieldeusing/capi-cc-mod</div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
