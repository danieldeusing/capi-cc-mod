// What a learner sets in the plugin's .env (see .env.example). Every value has
// a default, so a missing file or key changes nothing.

export const DEFAULTS = {
  CAPI_LEARN_LANGUAGE: 'Brazilian Portuguese',
  CAPI_NATIVE_LANGUAGE: 'German',
  CAPI_NATIVE_FLAG: '🇩🇪',
  CAPI_LEARNER:
    'has lived in Brazil for four years and gets by in everyday Portuguese (about A2/B1), with real gaps, above all in grammar',
  CAPI_TOPICS:
    'Brazil, science and nature, technology, history (Brazil and the world), everyday life, food, health and fitness',
  // The conjugation table, as the morning briefs draw it: rows are persons,
  // columns are tenses, both separated by |.
  CAPI_PERSONS: 'eu|você|ele/ela|nós|vocês',
  CAPI_TENSES: 'presente|pretérito perfeito|pretérito imperfeito|futuro|subjuntivo presente',
  // When the band is there: always, or only while Claude works.
  CAPI_SHOW: 'always',
}

// KEY=value lines; blank lines and # comments skipped, one pair of quotes around
// a value removed. Nothing else is interpreted: no expansion, no escapes.
export function parseEnv(text) {
  const env = {}
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    let value = line.slice(eq + 1).trim()
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    env[line.slice(0, eq).trim()] = value
  }
  return env
}

const list = (v) => v.split('|').map((x) => x.trim()).filter(Boolean)

export function configFrom(env = {}) {
  const get = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : DEFAULTS[k])
  return {
    learn: get('CAPI_LEARN_LANGUAGE'),
    native: get('CAPI_NATIVE_LANGUAGE'),
    nativeFlag: get('CAPI_NATIVE_FLAG'),
    learner: get('CAPI_LEARNER'),
    topics: get('CAPI_TOPICS'),
    persons: list(get('CAPI_PERSONS')),
    tenses: list(get('CAPI_TENSES')),
    show: get('CAPI_SHOW').toLowerCase() === 'working' ? 'working' : 'always',
  }
}

export const DEFAULT_CONFIG = configFrom()
