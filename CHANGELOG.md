# Changelog

All notable changes to this project are documented in this file.

## [0.3.0] — 2026-08-17

### Added

- **`workingDirOnly` config option** ([#1](https://github.com/Quartermaster-Labs/pi-on-demand-context/issues/1)) —
  when `true`, context files are only loaded under pi's working (launch)
  directory. Touching files or `cd`-ing outside the project loads nothing
  (the tracked working dir still moves), so unrelated `CLAUDE.md` files —
  e.g. `~/CLAUDE.md` or a package manager's — no longer leak in from stray
  touches.
- **`hideContents` config option** ([#1](https://github.com/Quartermaster-Labs/pi-on-demand-context/issues/1)) —
  when `true`, the TUI never shows the injected file contents, even when tool
  output is expanded; the `loaded <paths>` line stays compact. The LLM still
  receives the full contents.
- Config files, project overrides global per key:
  `~/.pi/agent/on-demand-context.json` (global) and
  `<project>/.pi/on-demand-context.json` (per-project, honored only for
  trusted projects). Re-read at every session start, including `/reload`.
- `/list-context` now shows the active config next to the loaded files.

## [0.2.0] — 2026-08-17

### Added

- Compact TUI rendering: injections now show as a single line
  `loaded <path>, <path>` in the transcript (via
  `pi.registerMessageRenderer`); expanding tool output reveals the full text.
  Previously the entire markdown block was dumped into the transcript.
- `CHANGELOG.md` (this file).

### Fixed

- **Injection timing** — the `tool_result` hook now awaits discovery and
  injection. pi's agent loop drains the steering queue only at iteration
  boundaries (after tool execution, before the next LLM call); with the old
  fire-and-forget discovery the drain ran before the async file reads
  finished, so context landed one full assistant turn after the `cd` — after
  the model had already replied to the tool result. The `loaded ...` line now
  appears immediately after the tool result, before the model's next thinking
  block.
- **Deepest-first ordering** — removed a stray `.reverse()` in
  `discoverContextFiles` that flipped multi-depth results to shallowest-first,
  corrupting the "most specific" / "N level(s) up — broader" depth tags
  (deepest file was tagged as the broadest). Invisible in single-depth trees;
  a regression test with a 3-level tree now pins the ordering.

### Changed

- Dropped the `@earendil-works/pi-tui` npm dependency: pi's extension loader
  aliases pi packages (`pi-tui`, `pi-coding-agent`, `pi-agent-core`, `pi-ai`,
  `typebox`) to the host's own copy for every extension, so extensions never
  declare them. Vitest has no such loader and resolves the import via
  `test/pi-tui-stub.ts` instead.
- Rewrote the README; `CHANGELOG.md` is now shipped in the npm package.

## [0.1.4] — never published

Version was bumped in preparation for the changes that shipped as
[0.2.0]; nothing was released under this number.

## [0.1.3] — 2026-06-28

- No content changes (version bump).

## [0.1.2] — 2026-06-28

### Added

- Restored the MIT `LICENSE` file in the published package.

### Changed

- README notes the prior `@radu0120` scope.

## [0.1.1] — 2026-06-28

### Changed

- Republished under the `@quartermaster-labs` scope (formerly
  `@radu0120/pi-on-demand-context`).

## [0.1.0] — 2026-06-26

### Added

- Initial release: auto-loads `CLAUDE.md` / `AGENTS.md` when the model `cd`s
  into a new directory (bash `cd`, with `&& pwd` / `; pwd` support for
  `cd -`, `~`, `$VAR`, `$(...)`, and paths with spaces).
- File-tool triggers: `read` / `edit` / `write` load the file's directory;
  `grep` / `ls` / `find` load the searched directory. Neither moves the bash
  working dir.
- One-time, durable injection (never re-sent; deduped against pi's startup
  loader via `systemPromptOptions.contextFiles`).
- Walk-up from the touched dir to pi's launch dir; 64 KB per-file cap.
- `/list-context` command.
