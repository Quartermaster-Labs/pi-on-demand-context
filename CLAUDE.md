# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run the vitest suite (`vitest run`).
- `npx vitest run -t "uses pwd output"` — run a single test by name.
- `npx vitest` — watch mode.

No build step: the extension ships as raw `index.ts` (pi loads TypeScript directly).

## What this is

A single-file [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent
extension. It auto-loads `CLAUDE.md` / `AGENTS.md` context files when the model
navigates directories with bash `cd`, so deep dirs get their context without a
dedicated tool.

Install: `npm install -g @quartermaster-labs/pi-on-demand-context`, then register in
`~/.pi/agent/settings.json` with `"@quartermaster-labs/pi-on-demand-context"`.
Reload in a running pi with `/reload`.

## Architecture

Everything lives in `index.ts`. The extension is the default-exported
`onDemandContext(pi: ExtensionAPI)` function, wired to pi's event hooks:

- **`tool_result`** — fires after every tool run. Two trigger paths, both
  ending in a fire-and-forget `discoverContextFiles` for any *new* dir:
  - `bash` → `resolveCdDir` derives the new working dir; this also **moves**
    `state.currentDir` (the tracked cwd).
  - `read`/`edit`/`write`/`grep`/`ls`/`find` → `dirForToolEvent` derives the
    target dir (file's dirname, or the searched dir) **without** moving
    `currentDir` — bash subshells own that. Relative paths resolve against
    `launchDir` because pi's file tools run from pi's process cwd, not the
    bash-tracked dir.
  Injection happens right here in the discovery `.then`: `pickNewFiles` selects
  the not-yet-seen files, `buildContextBlock` renders them, and `pi.sendMessage`
  injects them **once, durably** with `deliverAs: "steer"`. Steer lands the
  message in the running agent loop (before the model's next tool call); when the
  agent is idle, pi falls through to a durable `messages.push`. Either way it's
  persisted to session history and LLM-visible (custom messages serialize to a
  `role: "user"` message — see `messages.js`), so it is **never re-sent**. This
  mirrors how Claude Code injects nested context: once, durably, at touch time.
  The message's `details` carries `{ files: [paths] }` and a
  `registerMessageRenderer("on-demand-context")` shows the TUI only a compact
  `loaded <paths>` line (full text when tool output is expanded) — without it,
  pi's default renderer dumps the whole markdown block into the transcript.
- **`before_agent_start`** — seed-only: records pi's own startup context files
  (`systemPromptOptions.contextFiles`) into `piLoadedPaths` so we never
  double-inject what pi already put in the system prompt. Returns nothing.
- **`session_start`** — resets `state` (handles `/new`, `/resume`, `/fork`).
- **`/list-context`** command — user-facing dump of loaded files; no token cost.

### Key data flow

`state` (module-level singleton) holds `currentDir`, `dirContexts` (dir → files
found), plus the dedup machinery:

- `inFlight` — dirs whose async discovery is running, so a second touch of the
  same dir before discovery resolves doesn't kick off a duplicate scan.
- `injected` — normalized paths already sent durably. `pickNewFiles` skips these
  (and `piLoadedPaths`) so a parent `CLAUDE.md` shared by two visited dirs is
  injected only once.
- `piLoadedPaths` — paths pi's startup loader already injected, seeded in
  `before_agent_start`. Why no `--no-context-files` flag is needed: the extension
  complements pi's loader instead of replacing it.

Because injection is durable and once-per-file, there's no per-call token tax and
no transient `context`-hook rebuild — the earlier `transformContext` approach was
replaced precisely because `sendMessage`/`steer` can write durable history that
the transient hook cannot.

### Things to know before editing

- Two exported, unit-tested pure helpers: `dirForToolEvent(toolName, input,
  baseDir)` (which dir a file/dir tool touches) and `resolveCdDir(...)` below.
- `resolveCdDir(command, output, currentDir, home)` parses a `cd` command:
  bare `cd` → home,
  `&& pwd` / `; pwd` → trust the pwd output (handles spaces, `cd -`, `~`, `$VAR`),
  else `resolve(currentDir, target)`. Keep it pure — tests in `index.test.ts`
  depend on it.
- **`@earendil-works/pi-tui` import in `index.ts` needs NO npm dependency** —
  pi's extension loader aliases it (and pi-coding-agent, pi-ai, typebox) to the
  host's own copy for every extension, in all runtime modes (Node dist, bun
  binary, TS source — see `loader.js` `getAliases`/`VIRTUAL_MODULES`). Don't
  add it to package.json. Vitest has no such loader: `vitest.config.ts`
  aliases it to `test/pi-tui-stub.ts` so `index.ts` resolves under test.
- **Windows/msys path handling**: `fromBashPath` converts `/c/Users/...` →
  `C:\Users\...`; `pathKey` normalizes for dedup comparison. Touch carefully —
  this repo runs on win32 where bash and node disagree on path format.
- The walk-up in `discoverContextFiles` stops at `state.launchDir` (pi's launch
  dir) so it never scans above the project.
- `MAX_FILE_BYTES` (64 KB) caps per-file size against a hostile/huge context file.
