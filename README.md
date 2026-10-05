# self-compact (Pi 1.x compatible fork)

A standalone [Pi](https://github.com/earendil-works/pi) coding-agent extension that lets a long-running, autonomous agent manage its own context window.

Forked from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) with Pi 1.x compatibility fixes and tuned defaults. MIT licensed, same as upstream (© 2026 IndyDevDan).

## What it does

Pi's built-in compaction is reactive: it fires near the context limit with a generic summary prompt, and the agent gets no warning. This extension hands the agent the gauge and the hand-off instead:

| Phase | Trigger | What happens |
| --- | --- | --- |
| **notice** | usage crosses soft threshold | one transient message with live numbers; all tools available |
| **warning** | usage crosses warning threshold | "time to compact soon", refreshed on every call; all tools available |
| **forced** | usage crosses warning + buffer (capped at 90%) | every tool call is blocked except `self_compact` |
| **handoff** | agent calls `self_compact({ note_to_self })` | note saved, run ends, compaction runs once idle, note returned verbatim |

The footer shows a 20-cell context bar (`#` cached, `=` not cached, `-` free; `~` soft, `!` warning, `|` hard cutoff) with a phase tag. `view_context` gives the agent the same numbers as JSON. If compaction fails, the note and the lock survive and it retries automatically; `/self-compact-now` or `/compact` finish the job manually.

## Changes from upstream

This fork exists because upstream (v0.85.1 era) broke on Pi 1.x:

1. **Pi 1.x split-turn compaction fix** (`summary.ts`) — Pi 1.x wraps the turn-prefix summarization request as `# Conversation\n...\n\n# Instructions\n` instead of `<conversation>...</conversation>`. Upstream's instruction-replacement matcher recognized neither shape in that path and aborted with `Unrecognized Pi summary input; cannot replace instructions safely.` — bricking any session whose cut point fell mid-turn. This fork matches both the `<conversation>` (main history) and `# Conversation` (turn prefix) shapes.
2. **Fail-soft instruction replacement** (`summary.ts`) — if a summary request shape is ever unrecognized again, the extension keeps Pi's default instructions for that request and notifies, instead of throwing. Compaction always completes; the session can no longer get locked with a kept note.
3. **Tuned defaults** (`defaults.ts`) — notice 10%, warning 15%, buffer 10% (forced cutoff at 25%). Tuned for 1M-context models where the provider bills cached tokens at full price: request size stays small (~104k tokens average) without losing context, since the handoff note carries the work state verbatim.

## Install

The repo is a proper Pi package (explicit `pi` manifest + host `peerDependencies`), so any of these work:

```bash
pi install git:github.com/priaculun/self-compact
pi install https://github.com/priaculun/self-compact   # URLs are treated as git sources
```

Updates flow through `pi update --extensions` — no more manual file copying, and a Pi upgrade cannot silently disable it (unlike a hand-added `settings.json` entry).

Then restart Pi (or `/reload`). Verify with `/self-compact-info` — you should see the resolved thresholds (soft 10% / warning 15% / forced 25%) and the prompt files. The three editable prompt files resolve from the package itself (`.pi/self-compact/` ships in the repo); drop files in `<cwd>/.pi/self-compact/` to override per project.

### Manual install (no package manager)

```bash
git clone https://github.com/priaculun/self-compact.git ~/.pi/agent/extensions/self-compact
mkdir -p ~/.pi/agent/.pi/self-compact
cp ~/.pi/agent/extensions/self-compact/.pi/self-compact/*.md ~/.pi/agent/.pi/self-compact/
```

Then enable it in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["+extensions/self-compact/extensions/self-compact/index.ts"]
}
```

Note: a manual `settings.json` entry can get silently flipped to `-` (disabled) when a Pi update reconciles extensions — one of the bugs that motivated this fork's packaging.

## Configuration

Defaults live in `extensions/self-compact/defaults.ts`:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--compact-soft-at` | `10%` | soft heads-up, nothing changes |
| `--compact-at` | `15%` | time to write a note and compact soon |
| `--compact-buffer` | `10%` | extra allowance above warning before the hard cutoff (so forced = 25%) |

Each value is a percentage of the active model's context window, or a token count (`270000`, `100k`, `1.5m`). The hard cutoff never exceeds 90% of the window.

Pi has no persistent storage for extension flags — to change thresholds permanently, either edit `defaults.ts` in your clone, or launch with flags: `pi --compact-at 25%`.

### Editable prompt files

Three prompt files are read live from `<cwd>/.pi/self-compact/` or `~/.pi/agent/.pi/self-compact/` (templates in [.pi/self-compact/](.pi/self-compact/)):

- `USER_PROMPT_SOFT_SELF_COMPACT.md` — notice-phase guidance
- `USER_PROMPT_WARNING_SELF_COMPACT.md` — warning-phase guidance
- `USER_PROMPT_COMPACTION_MESSAGE.md` — the summary request instructions used instead of Pi's generic ones

Live values are available as `{{placeholders}}` (e.g. `{{used_tokens}}`, `{{used_percent}}`, `{{warning_tokens}}`).

## Commands & tools

- `self_compact({ note_to_self })` — the agent-facing tool: save the note, end the run, compact, resume with the note verbatim
- `view_context()` — current usage numbers as JSON
- `/self-compact-info` — full settings/thresholds/state dump without spending a model turn
- `/self-compact-now` — force the handoff cycle immediately
