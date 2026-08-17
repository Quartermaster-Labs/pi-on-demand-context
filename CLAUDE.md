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

- **`tool_result`** — fires after every tool run (via pi's `afterToolCall`,
  which **awaits** the handler). Two trigger paths, both ending in an **awaited**
  `discoverContextFiles` for any *new* dir:
  - `bash` → `resolveCdDir` derives the new working dir; this also **moves**
    `state.currentDir` (the tracked cwd).
  - `read`/`edit`/`write`/`grep`/`ls`/`find` → `dirForToolEvent` derives the
    target dir (file's dirname, or the searched dir) **without** moving
    `currentDir` — bash subshells own that. Relative paths resolve against
    `launchDir` because pi's file tools run from pi's process cwd, not the
    bash-tracked dir.
  Before discovery, the `workingDirOnly` config gate (#1): a target dir
  outside the `launchDir` subtree is skipped (`isUnderOrEqual`) — that's where
  `~/CLAUDE.md` / homebrew leak in from stray touches. Bash `cd` already moved
  `currentDir` before the gate, so tracked cwd still follows the model.
  Injection happens right here, **synchronously inside the hook**: `pickNewFiles`
  selects the not-yet-seen files, `buildContextBlock` renders them, and
  `pi.sendMessage` injects them **once, durably** with `deliverAs: "steer"`.
  **Timing matters — keep the `await`**: pi's agent loop only drains the
  steering queue at iteration boundaries (after tool execution, before the next
  LLM call). If discovery ran fire-and-forget, the boundary drain would beat the
  async file reads and the context would land one full assistant turn late
  (after the model already replied to the tool result). Awaiting inside the hook
  makes the `loaded <paths>` line appear immediately after the tool result —
  before the model's next thinking block. Cost: a few ms of local file reads.
  Steer lands the message in the running agent loop (before the model's next
  tool call); when the agent is idle, pi falls through to a durable
  `messages.push`. Either way it's persisted to session history and LLM-visible
  (custom messages serialize to a `role: "user"` message — see `messages.js`),
  so it is **never re-sent**. This mirrors how Claude Code injects nested
  context: once, durably, at touch time.
  The message's `details` carries `{ files: [paths] }` and a
  `registerMessageRenderer("on-demand-context")` shows the TUI only a compact
  `loaded <paths>` line (full text when tool output is expanded, unless
  `hideContents` is set — then expansion is a no-op) — without it, pi's
  default renderer dumps the whole markdown block into the transcript.
- **`before_agent_start`** — seed-only: records pi's own startup context files
  (`systemPromptOptions.contextFiles`) into `piLoadedPaths` so we never
  double-inject what pi already put in the system prompt. Returns nothing.
- **`session_start`** — resets `state` (handles `/new`, `/resume`, `/fork`)
  and re-reads config (also fires on `/reload`).
- **Config** — `loadConfig(cwd, projectTrusted)` merges
  `<agentDir>/on-demand-context.json` (global, `getAgentDir()`) with
  `<cwd>/.pi/on-demand-context.json` (project, `CONFIG_DIR_NAME`) — project
  wins per key. Defaults (zero-config, issue #1): `workingDirOnly` **on**,
  `hideContents` off. The project file is read only when
  `ctx.isProjectTrusted()` — an untrusted project must not steer a globally
  installed extension. At extension load time there is no ctx (no trust
  decision), so only the global file applies until the first `session_start`.
  `/odc-working-dir-only on|off` and `/odc-hide-contents on|off` mutate the
  live config and `persistGlobalConfig` writes the global file (commands are
  user-initiated, so that's safe even in untrusted projects).
- **`/list-context`** command — user-facing dump of loaded files + active
  config; no token cost.

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

- Exported, unit-tested helpers: `dirForToolEvent(toolName, input, baseDir)`
  (which dir a file/dir tool touches), `resolveCdDir(...)` below,
  `isUnderOrEqual(child, parent)` (subtree test behind `workingDirOnly` —
  normalizes bash→win + separators, case-insensitive only on win32),
  `mergeConfig(global, project)` (pure config merge; non-boolean values are
  ignored via `boolOr` — defaults: workingDirOnly on, hideContents off), and
  `loadConfig(cwd, trusted)` (fs-backed).
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
  aliases `pi-tui` to `test/pi-tui-stub.ts` and `pi-coding-agent` to
  `test/pi-coding-agent-stub.ts` (type imports are erased; the stub provides
  the runtime `CONFIG_DIR_NAME`/`getAgentDir`, and `getAgentDir()` honors
  `PI_TEST_AGENT_DIR` so `loadConfig` tests stay hermetic).
- **Windows/msys path handling**: `fromBashPath` converts `/c/Users/...` →
  `C:\Users\...`; `pathKey` normalizes for dedup comparison. Touch carefully —
  this repo runs on win32 where bash and node disagree on path format.
- The walk-up in `discoverContextFiles` stops at `state.launchDir` (pi's launch
  dir) so it never scans above the project.
- `MAX_FILE_BYTES` (64 KB) caps per-file size against a hostile/huge context file.
