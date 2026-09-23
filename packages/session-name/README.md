# @pi-archimedes/session-name

**Find the session you meant.**

Timestamps and raw hash names don't tell you what a session was *for*. Session-name gives every session a short, descriptive name based on its first exchange, so `pi -r` stops being a guessing game.

## Install

Standalone:

```bash
pi install npm:@pi-archimedes/session-name
```

Or the full suite instead:

```bash
pi install npm:pi-archimedes
```

New to Pi? Pi itself is a one-time global install and needs Node.js ≥ 22.19.0:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

After installing Pi, choose one installation command above, then `cd` into your project and run `pi`. Inside the session, `/login` signs you in and `/model` picks a model — the [setup section](https://github.com/danielcherubini/pi-archimedes#setup) covers the first run. `/reload` picks the extension up in a running session.

## How it works

- After the first user + assistant exchange settles, it takes that exchange (500 characters per side), asks a model to write a 3–8-word title, caps it at 80 characters, and sets the session name. With `recomputeEvery` enabled, each recurrence instead uses the latest complete exchange so the title follows the work.
- **Manual names win.** If you named the session (`--name` or `/name`), naming is skipped permanently, and it re-checks before writing. One case it cannot see: Pi's `session_info_changed` carries the new name and nothing else, so a rename to a string *identical* to the title just generated is indistinguishable from the extension's own write and does not stop updates. A rename to any other string always does.
- **It uses your current model unless you configure another.** The title is a separate model call outside the main run — with its own cost, **not reflected in the footer's totals**. It uses at most 500 characters from each side of the latest exchange, a fresh session ID and `cacheRetention: "none"`: it does **not** piggyback on the previous reply or reuse that reply's prompt cache. Every recurrence is another model call. A `model` setting (e.g. a cheap model) avoids spending your main model on titles.
- **Skips and retries** — Ephemeral sessions (no session file) are skipped; if the model has no configured auth, the call is skipped. Transient failures print to the console and re-try on later `agent_end` events, giving up for the session after three. A due exchange that lands while a title call is still in flight is deferred until it returns; the interval counts completed exchanges, not completed calls. When `minRecomputeMinutes` is set, even failed calls respect the time floor. No background timer starts a call merely because an hour elapsed: the next completed exchange checks again. It is non-blocking and unobtrusive, but "silent" is too strong: failures are logged.

## Settings

`~/.pi/agent/settings.json`, under `archimedes.sessionName` (strict JSON):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `model` | string | _(current model)_ | Model used for title generation (e.g. `openai/gpt-4o-mini`). Canonical `provider/id`, bare IDs, and thinking-suffix forms are all resolved. Empty = current model. |
| `recomputeEvery` | non-negative integer | `0` | Recompute after N *further* completed exchanges since the last title request. `0` keeps one-shot naming. |
| `minRecomputeMinutes` | non-negative integer | `0` | Minimum wall-clock minutes between title requests, including failed attempts. Both limits must be met on an exchange boundary; `0` disables the time floor. |

On/off is managed by the suite: toggle via `/plugins` (`archimedes.sessionName.enabled`, default on).

← [Back to pi-archimedes](https://github.com/danielcherubini/pi-archimedes)
