# pi-on-demand-context

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
auto-loads `CLAUDE.md` / `AGENTS.md` context files when the model works in a
directory — by `cd`-ing into it, or by touching a file there with
`read` / `edit` / `write` / `grep` / `ls` / `find`. No special tools, no flags.

Pi loads context files for the **launch directory** (and its parents) at
startup. Deeper directories stay invisible: `cd services/api` mid-session and
its `CLAUDE.md` never enters the conversation. This extension closes that gap —
the moment the model touches a new directory, that directory's context files
are injected into the conversation, once, durably, before the model's next
response.

## How it works

- **Triggers** — after every tool result, the extension resolves which
  directory the tool touched:
  - `bash` — a `cd` moves the tracked working dir. A plain `cd <path>` is
    resolved against the last known dir; `cd ... && pwd` (or `; pwd`) trusts
    `pwd`'s output, which handles `cd -`, `~`, `$VAR`, `$(...)`, and paths
    with spaces.
  - `read` / `edit` / `write` — the touched **file's** directory.
  - `grep` / `ls` / `find` — the searched directory.

  File tools do **not** move the bash working dir (bash subshells own that);
  they just load context.
- **Discovery** — walks from the touched dir **upwards**, collecting
  `CLAUDE.md` / `AGENTS.md` (64 KB cap per file), stopping at pi's launch
  dir so it never scans above the project. Files are ordered deepest-first —
  deeper files override broader parents where they conflict.
- **Injection** — not-yet-seen files are sent as one **durable** message
  (`sendMessage`, `deliverAs: "steer"`), awaited inside the `tool_result` hook
  so it lands right after the tool result — before the model's next thinking
  block. Being durable session history, it is never re-sent: no per-call token
  tax, and revisiting a dir costs nothing.
- **TUI** — the injection renders as a single compact line,
  `loaded <path>, <path>`; expanding tool output shows the full text
  (disable with `hideContents` — see Configuration).
- **Dedup** — files pi already loaded at startup
  (`systemPromptOptions.contextFiles`) and files injected via a shared parent
  are never re-sent. The extension complements pi's loader instead of
  replacing it — no `--no-context-files` needed.

## Install

> Formerly published as `@radu0120/pi-on-demand-context`. Same package,
> republished under the `@quartermaster-labs` scope.

```bash
pi install npm:@quartermaster-labs/pi-on-demand-context
```

Or manually:

```bash
npm install -g @quartermaster-labs/pi-on-demand-context
```

and register it in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["@quartermaster-labs/pi-on-demand-context"]
}
```

Then restart pi, or run `/reload` in a running session.

## Usage

### For the model

```bash
cd some/dir          # plain cd works — resolved against the last known dir
cd some/dir && pwd   # recommended — pwd reports the exact dir, no guessing
```

Append `&& pwd` when the target can't be computed from the string alone —
`cd -`, `cd ~user`, `cd $VAR`, `cd $(...)`. Either way, context is injected
before the model's next turn.

### For the user

- `/list-context` — show every context file loaded so far, plus the active
  config (no token cost).
- Context state resets on `/new`, `/resume`, `/fork`.

## Configuration

Optional JSON config. Project-local values override global, per key. The
project file is honored only for **trusted** projects (an untrusted project
must not steer a globally installed extension).

| File | Scope |
|---|---|
| `~/.pi/agent/on-demand-context.json` | global (all projects) |
| `<project>/.pi/on-demand-context.json` | per-project |

```json
{
  "workingDirOnly": true,
  "hideContents": true
}
```

- `workingDirOnly` (default `false`) — only load context files under pi's
  working (launch) directory. When `true`, `cd`-ing or touching files outside
  the project loads nothing (the tracked working dir still moves), so
  unrelated `CLAUDE.md` files — e.g. `~/CLAUDE.md` or a package manager's —
  never leak in. ([#1](https://github.com/Quartermaster-Labs/pi-on-demand-context/issues/1))
- `hideContents` (default `false`) — the TUI never shows the injected file
  contents, even when tool output is expanded; the `loaded <paths>` line stays
  compact. The LLM still receives the full contents.

Config is re-read at every session start, including `/reload`.

## Behavior notes

- A dir's context includes **that dir and all parents** up to pi's launch dir.
- Touching a dir **outside** the launch dir walks up to the filesystem root
  by default (so `~/CLAUDE.md` etc. can load); `workingDirOnly: true` turns
  that off.
- `cd`-ing back into a visited dir loads nothing (dedup).
- Visiting multiple dirs accumulates context; each new dir contributes only
  its not-yet-seen files.
- Windows (git-bash / msys) and Unix both work — bash-style `/c/Users/...`
  paths are normalized for the filesystem.

## Development

```bash
npm install
npm test             # vitest — no build step (pi loads index.ts directly)
```

Local dev loop (no publish needed):

```bash
pi install /path/to/pi-on-demand-context   # forward slashes on Windows
# then /reload in a running session
```

Contributor notes (full details in `CLAUDE.md`):

- `index.ts` is the entire extension. `resolveCdDir`, `dirForToolEvent`,
  `pickNewFiles`, and `discoverContextFiles` are exported, unit-tested helpers.
  Keep the deepest-first ordering contract (`files[0]` = deepest).
- The `@earendil-works/pi-tui` import needs **no** npm dependency — pi's
  extension loader aliases pi packages to the host's own copy. Vitest has no
  such loader, so `vitest.config.ts` aliases it to `test/pi-tui-stub.ts`.
- **Keep the `await` in the `tool_result` handler.** pi drains the steering
  queue only at iteration boundaries; fire-and-forget discovery would land the
  context one full assistant turn late.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
