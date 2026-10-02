# ptbr: Capi teaches Brazilian Portuguese while Claude works

A Claude Code mod. While Claude works, and while background tasks it started are
still running, Capi the capybara shows a quiz card in the band above the prompt.
Every card teaches one true real-world fact and one Portuguese expression, with
German explanations. Answer with the digit keys (type the digit into the empty
prompt) or by clicking.

| key | does |
| --- | --- |
| `1`–`4` | answer the quiz, then `sim`/`não`: did you know the expression? |
| `8` | 🔊 hear it (macOS voice *Luciana*) |
| `9`, then `9` again | 🚩 the fact is wrong: it is never used again, and Capi re-checks it |

`/ptbr` shows level, streak, points, what is due, and how the last sync and card
generation went. It answers instantly, also while Claude works. `/ptbr skip` drops
the current card.

## How it learns

- **The learning unit is the expression**, not the sentence. When an expression is
  due again, Capi writes a NEW fact around it.
- **Leitner boxes**: due again after 1, 3, 7, 30 and 90 days. A miss comes back
  after 20 minutes in the other language format (the payback round).
- **Placement**: during the first week, an expression you already know jumps
  straight to box 4.
- **At most 10 new expressions a day**, across all sessions and both Macs. After
  that, only reviews and bonus cards.

## Models

Every model call uses `claude-opus-5-5` on your plan:

| call | effort | when |
| --- | --- | --- |
| ten new cards | `high` | when fewer than 4 cards are queued; cards leave the queue only when answered |
| 🚩 re-check | `xhigh` | once per flag |

Change them at the top of `hooks/register.js` (`GENERATE`, `CHECK`).

## Data

- `$.store` (`~/.claude/plugins/store/`): the shared card queue and the answers
  not yet folded into the history file
- `~/Library/Mobile Documents/com~apple~CloudDocs/ptbr/<Mac>-<YYYY-MM>.jsonl`: each
  Mac's history, one file per month. Every Mac reads every file and writes only its
  own, through a temporary file and a rename, and never with fewer entries than
  it wrote before.

## Install

Needs Claude Code 2.1.287 or later with mods on: `claude plugin test`, run in an
empty directory, must not say "turned off". Clone this repo on each Mac, then add
it to `~/.claude/settings.json` so it loads in every session, Desktop included:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/daniel/Work/danieldeusing/dd-ptbr-mod" } }
```

For one session only: `claude --plugin-dir ~/Work/danieldeusing/dd-ptbr-mod`.

## Develop

```bash
node --test test/                 # the learning logic, no Claude Code needed
claude plugin test                # the wiring, in Claude Code's own test kit
claude plugin validate . --strict # what Claude Code reads from the mod
```

Tested with Claude Code 2.1.287.
