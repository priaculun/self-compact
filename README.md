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

The footer shows the model on the left — for a virtual model (e.g. `ontoken/auto`) the latest route as `auto → role · model · thinking`, for a reasoning model `model · thinking` — and a 20-cell context bar (`#` cached, `=` not cached, `-` free; `~` soft, `!` warning, `|` hard cutoff) with a phase tag. `view_context` gives the agent the same numbers as JSON. If compaction fails, the note and the lock survive and it retries automatically; `/self-compact-now` or `/compact` finish the job manually.

## With a task extension

When task tools are active (`TaskList` + `TaskUpdate`, e.g. [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks)), self-compact links the task list to the compaction cycle. Everyday task reminders stay with the task extension; self-compact only covers the boundary it cannot see:

- **Before compacting** (warning, `/self-compact-now`, idle "compact now"): update task statuses, create tasks for untracked remaining steps, list open task IDs in the note, and reference the task ID in NEXT ACTION. Under the hard cutoff (other tools blocked) the note carries the statuses instead.
- **After the handoff**: the first call gets a one-line transient hint to run `TaskList` once before the NEXT ACTION.

Without task tools nothing changes. Hints are transient (never persisted) and a retry with a saved note stays verbatim.

## Changes from upstream

This fork exists because upstream (v0.85.1 era) broke on Pi 1.x:

1. **Pi 1.x split-turn compaction fix** (`summary.ts`) — Pi 1.x wraps the turn-prefix summarization request as `# Conversation\n...\n\n# Instructions\n` instead of `<conversation>...</conversation>`. Upstream's instruction-replacement matcher recognized neither shape in that path and aborted with `Unrecognized Pi summary input; cannot replace instructions safely.` — bricking any session whose cut point fell mid-turn. This fork matches both the `<conversation>` (main history) and `# Conversation` (turn prefix) shapes.
2. **Fail-soft instruction replacement** (`summary.ts`) — if a summary request shape is ever unrecognized again, the extension keeps Pi's default instructions for that request and notifies, instead of throwing. Compaction always completes; the session can no longer get locked with a kept note.
3. **Tuned defaults** (`defaults.ts`) — notice 100k, warning 150k, buffer 100k (forced cutoff at 250k tokens). Absolute token counts so the lines stay put when a router (e.g. `ontoken/auto`) switches between models with different windows. Tuned for providers that bill cached tokens at full price: request size stays small without losing context, since the handoff note carries the work state verbatim.
4. **Pi 1.4 compatibility** (`summary.ts`) — no fixed 8192-token summary output cap (Pi 1.4 removed it, #9512: reasoning models failed with "generation hit the token cap"); summaries use the model's output limit with low reasoning. The "nothing to compact" check mirrors Pi 1.4's `prepareCompaction` on the canonical session projection (context edits, omitted recovery attempts); verified 0 mismatches against Pi over 972 real-session cases. `keepRecentTokens` honours per-model settings. Overflow-recovery compaction is no longer cancelled (only threshold auto-compaction is deferred to the handoff).
5. **Token savings** — the notice is injected once per crossing instead of on every LLM call; the warning is injected in full once, then as a one-line reminder; the summarizer receives the note_to_self and records only what the note omits (no duplicated state); no duplicated `<read-files>`/`<modified-files>` lists (Pi appends them); `note_to_self` capped at 12,000 chars; compact `view_context` JSON; the compactable check is memoized per branch head.

## Install

The repo is a proper Pi package (explicit `pi` manifest + host `peerDependencies`), so any of these work:

```bash
pi install git:github.com/priaculun/self-compact
pi install https://github.com/priaculun/self-compact   # URLs are treated as git sources
```

Updates flow through `pi update --extensions` — no more manual file copying, and a Pi upgrade cannot silently disable it (unlike a hand-added `settings.json` entry).

Then restart Pi (or `/reload`). Verify with `/self-compact-info` — you should see the resolved thresholds (soft 100k / warning 150k / forced 250k) and the prompt files. The three editable prompt files resolve from the package itself (`.pi/self-compact/` ships in the repo); drop files in `<cwd>/.pi/self-compact/` to override per project.

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
| `--compact-soft-at` | `100k` | soft heads-up, nothing changes |
| `--compact-at` | `150k` | time to write a note and compact soon |
| `--compact-buffer` | `100k` | extra allowance above warning before the hard cutoff (so forced = 250k) |

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
- `/self-compact-now` — force the handoff cycle immediately (sent as a custom message, not a user message, so virtual-model routers such as `ontoken/auto` treat it as a continuation and keep the model and its prompt cache)
