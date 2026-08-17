# On-Demand Context Extension

Loads `CLAUDE.md` and `AGENTS.md` context files when the model works in a
directory — by `cd`-ing into it, or by touching a file there with
`read`/`edit`/`write`/`grep`/`ls`/`find`.

## How it works

- pi auto-loads context files for the launch dir + parents at startup (unchanged)
- Model `cd some/dir`, or reads/edits/greps a file anywhere — no special tool needed
- Extension resolves the target directory and injects context from it (+ parents)
- A `read`/`edit`/`write` loads the **file's** directory; `grep`/`ls`/`find` load
  the searched directory; these do **not** move the bash working dir
- Context is injected **once, durably** the moment a dir is touched (via
  `sendMessage` with `deliverAs: "steer"`), so a dir's `CLAUDE.md` is in view
  before the model acts there — same agent loop, no per-call re-send
- In the TUI the injection shows as one compact line — `loaded <path>[/path]` —
  not the file contents (expand tool output to see the full text)
- Files pi already loaded (or a shared parent) are **not** re-sent
- Multiple directories can be visited — context accumulates across the session

## Install

> Formerly published as `@radu0120/pi-on-demand-context`. Same package, republished under the `@quartermaster-labs` scope.

```bash
npm install -g @quartermaster-labs/pi-on-demand-context
```

## Setup

Register the extension in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["@quartermaster-labs/pi-on-demand-context"]
}
```

Or use the local path:

```json
{
  "extensions": ["~/.npm-global/lib/node_modules/@quartermaster-labs/pi-on-demand-context"]
}
```

No `--no-context-files` / `noContextFiles` needed — the extension complements
pi's default loader instead of replacing it, deduping against what pi already
injected via `systemPromptOptions.contextFiles`.

After modifying `index.ts`, run `/reload`.

## Usage

### For the model

```bash
cd some/dir          # plain cd works — new dir is resolved from the path
cd some/dir && pwd   # recommended — pwd gives the exact dir, no guessing
```

A plain `cd <path>` is enough for ordinary relative/absolute paths; the new
directory is resolved against the last known one. Append `&& pwd` when the path
can't be computed from the string alone — `cd -`, `cd ~user`, `cd $VAR`, or
`cd $(...)` — so `pwd` reports the real directory. Either way context files are
injected before the next turn; no special tool needed.

### For the user

- `/list-context` — show all loaded context files
- Context resets on `/new`, `/resume`, `/fork`

## Notes

- Context files are loaded from the target directory **and all parent directories**
- Files are not re-loaded if you `cd` back to a visited directory
- Uses `&& pwd` (or `; pwd`) to reliably detect the actual new working directory
- Works on Windows (WSL/bash) and Unix systems
