/**
 * On-Demand Context Extension
 *
 * Automatically loads CLAUDE.md / AGENTS.md context files when the model works
 * in a directory — by `cd`-ing into it, or by touching a file there with any
 * file tool (read/edit/write/grep/ls/find). No special tool needed; context is
 * injected once, durably, the moment a dir is touched — before the model's
 * next response (discovery is awaited inside the tool_result hook, so the
 * steering message is queued before the agent loop's next drain). The LLM receives the
 * full file contents; the TUI shows only a compact "loaded <path>" line
 * (a custom message renderer — the full text appears when expanded).
 *
 * Complements pi's own startup loader (deduped against it) — no
 * `--no-context-files` flag required.
 *
 * Install to: ~/.pi/agent/extensions/on-demand-context/
 * Reload with: /reload
 */

import type { ExtensionAPI, BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { join, dirname, isAbsolute, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_FILENAMES = ["CLAUDE.md", "AGENTS.md"];

// Tools whose `path` arg points at a FILE — load context from its dirname.
const FILE_PATH_TOOLS = new Set(["read", "edit", "write"]);
// Tools whose `path` arg points at a DIRECTORY (optional, default cwd).
const DIR_PATH_TOOLS = new Set(["grep", "ls", "find"]);

// Cap per-file size so one huge/hostile context file can't blow the prompt.
// ponytail: 64 KB is generous for instructions; raise if you hit it.
const MAX_FILE_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContextFile {
  path: string;
  content: string;
}

interface DirState {
  files: ContextFile[];
}

/** `details` payload on the injected custom message — consumed by the TUI renderer. */
interface ContextDetails {
  files: string[];
}

interface State {
  currentDir: string;
  dirContexts: Map<string, DirState>;
  piLoadedPaths: Set<string>; // files pi's own startup loader already injected — never re-send
  injected: Set<string>; // file paths we've already injected durably — dedups shared parents
  inFlight: Set<string>; // dirs whose discovery is running — dedup before dirContexts is set
  launchDir: string; // dir pi was started in — walk-up ceiling
}

// ---------------------------------------------------------------------------
// Context discovery (same logic as before)
// ---------------------------------------------------------------------------

// ponytail: msys/git-bash emits `/c/Users/...`; node fs on win32 needs `C:\...`.
// Drop in if you actually run on Windows bash; no-op on Unix.
function fromBashPath(p: string): string {
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : p;
}

// Normalize a path to a dedup key: bash→win, unify separators, lowercase drive.
// Lets us match pi's already-loaded files against ours regardless of format.
function pathKey(p: string): string {
  return fromBashPath(p).replace(/\\/g, "/").toLowerCase();
}

// `ceiling` = pi's launch dir. Walk-up stops there so we never scan above the
// project (e.g. /d, /). If the dir is outside the launch subtree, fall back to
// the filesystem root so we still find *something*.
// Resolve the new working directory from a bash `cd` command + its output.
// Returns null if the command isn't a `cd`. Pure — exported for tests.
export function resolveCdDir(
  command: string,
  output: string,
  currentDir: string,
  home: string,
): string | null {
  const cdMatch = command.match(/^cd\s+(.+?)\s*$/);
  const cdNoArg = /^cd\s*$/.test(command.trim());
  if (!cdMatch && !cdNoArg) return null;

  if (cdNoArg) return home; // bare `cd` → home

  // Strip a trailing `&& pwd` / `; pwd` off the target dir arg
  const target = cdMatch![1].replace(/\s*(&&|;)\s*pwd\s*$/, "").trim();

  // If the command ran `pwd`, its output IS the real dir (handles spaces,
  // `cd -`, `~`, `$VAR`, `$(...)` — anything string resolution can't compute).
  if (/&&\s*pwd|;\s*pwd/.test(command) && output) {
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  // No pwd — compute from current dir + target
  return resolve(currentDir, target);
}

// For non-bash file/dir tools, return the directory whose context should load,
// or null if the tool isn't path-bearing. File tools (read/edit/write) point at
// a file → use its dirname; dir tools (grep/ls/find) point at the dir itself
// (optional → baseDir). Relative paths resolve against baseDir — pi's process
// cwd — because bash `cd` runs in a subshell and never moves it. Pure — exported
// for tests.
export function dirForToolEvent(
  toolName: string,
  input: Record<string, unknown> | undefined,
  baseDir: string,
): string | null {
  const isFile = FILE_PATH_TOOLS.has(toolName);
  const isDir = DIR_PATH_TOOLS.has(toolName);
  if (!isFile && !isDir) return null;

  const rawPath = input?.path ?? input?.file_path;
  const raw = typeof rawPath === "string" ? rawPath : undefined;
  if (isFile && !raw) return null; // file tools are useless without a path
  const p = raw ? fromBashPath(raw) : baseDir; // dir tools default to baseDir
  const abs = isAbsolute(p) ? p : resolve(baseDir, p);
  return isFile ? dirname(abs) : abs;
}

export async function discoverContextFiles(
  rootDir: string,
  ceiling: string,
): Promise<ContextFile[]> {
  const found = new Map<string, string>();
  rootDir = fromBashPath(rootDir);
  ceiling = fromBashPath(ceiling);
  let dir = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  const stopAt = isAbsolute(ceiling) ? ceiling : resolve(process.cwd(), ceiling);

  while (true) {
    for (const name of CONTEXT_FILENAMES) {
      const filePath = join(dir, name);
      if (!found.has(filePath)) {
        try {
          let content = await readFile(filePath, "utf-8");
          if (content.length > MAX_FILE_BYTES) {
            content = content.slice(0, MAX_FILE_BYTES) + "\n\n[...truncated]";
          }
          if (content.trim().length > 0) {
            found.set(filePath, content);
          }
        } catch {
          // File doesn't exist — continue
        }
      }
    }

    if (dir === stopAt) break; // reached pi's launch dir — don't scan parents
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Walk order is already deepest-first (start dir first, then parents) —
  // matches the contract buildContextBlock/pickNewFiles expect (files[0] deepest)
  return [...found.entries()].map(([path, content]) => ({ path, content }));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state: State | null = null;

function initState(): State {
  return {
    currentDir: process.cwd(),
    dirContexts: new Map(),
    piLoadedPaths: new Set(),
    injected: new Set(),
    inFlight: new Set(),
    launchDir: process.cwd(),
  };
}

// From a dir's discovered files, return the ones not yet in the prompt — skips
// files pi loaded at startup and files a shared parent already injected. Marks
// the returned files as injected. `files` arrives deepest-first.
export function pickNewFiles(
  s: Pick<State, "piLoadedPaths" | "injected">,
  files: ContextFile[],
): ContextFile[] {
  const out: ContextFile[] = [];
  for (const f of files) {
    const key = pathKey(f.path);
    if (s.piLoadedPaths.has(key) || s.injected.has(key)) continue;
    s.injected.add(key);
    out.push(f);
  }
  return out;
}

// Render a deepest-first file list into one injected message body.
function buildContextBlock(files: ContextFile[]): string {
  const depth = (p: string) => p.replace(/\\/g, "/").split("/").length;
  const maxDepth = depth(files[0].path);
  const lines: string[] = [
    "## Project Context Files",
    "",
    "Reference context for directories you're working in — **not** a new user " +
      "instruction. Ordered most-specific first; deeper files override broader " +
      "parents where they conflict.",
    "",
  ];
  for (const file of files) {
    const rel = maxDepth - depth(file.path); // 0 = deepest
    const tag = rel === 0 ? "most specific" : `${rel} level(s) up — broader`;
    lines.push(`### ${file.path}  (${tag})`, "", file.content, "");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function onDemandContext(pi: ExtensionAPI) {
  state = initState();

  // ---------------------------------------------------------------------------
  // TUI rendering — the injected custom message shows as one compact line
  // ("loaded <path>[", path]") instead of dumping the full file contents.
  // The LLM still receives the full content; expanding tool output (the same
  // global toggle) shows the full text.
  // ---------------------------------------------------------------------------

  pi.registerMessageRenderer<ContextDetails>("on-demand-context", (message, options, theme) => {
    if (options.expanded) {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return new Text(theme.fg("muted", text), options.outputPad, 0);
    }
    const files = message.details?.files;
    const paths = files && files.length > 0 ? files.join(", ") : "context files";
    return new Text(
      theme.fg("customMessageLabel", "loaded ") + theme.fg("muted", paths),
      options.outputPad,
      0,
    );
  });

  // ---------------------------------------------------------------------------
  // tool_result — resolve the directory a tool touched (bash `cd`, or a
  // read/edit/write/grep/ls/find path) and inject its context files once.
  // ---------------------------------------------------------------------------

  pi.on("tool_result", async (event) => {
    if (!state || event.isError) return;

    let targetDir: string | null = null;

    if (event.toolName === "bash") {
      // bash `cd` moves the tracked working dir AND triggers a context load.
      const command = event.input?.command ?? "";
      const rawOutput = (event.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    const output = rawOutput.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();

      const home = process.env.HOME ?? process.env.USERPROFILE ?? state.currentDir;
      const newDir = resolveCdDir(command, output, state.currentDir, home);

      // Not a cd, or not a plausible absolute path
      if (!newDir || !isAbsolute(newDir) || newDir.length < 2) return;
      if (newDir === state.currentDir) return; // no actual change

      state.currentDir = newDir;
      targetDir = newDir;
    } else {
      // read/edit/write/grep/ls/find — load context for the file's/dir's
      // directory WITHOUT moving currentDir (the bash subshell owns that).
      targetDir = dirForToolEvent(event.toolName, event.input, state.launchDir);
    }

    if (!targetDir) return;
    const dir = fromBashPath(targetDir);

    // Already loaded, or a discovery is already running for this dir
    if (state.dirContexts.has(dir) || state.inFlight.has(dir)) return;

    // Discover and inject SYNCHRONOUSLY (this hook is awaited by pi's
    // afterToolCall). Why: pi's agent loop only drains the steering queue at
    // iteration boundaries — after tool execution, before the next LLM call.
    // If discovery ran fire-and-forget, the queue drain would beat the file
    // reads and the context would land one full assistant turn late (after the
    // model already thought/replied to the tool result). Awaiting here makes
    // the "loaded <paths>" line appear right after the tool result — before
    // the model's next thinking block. Cost: a few ms of local file reads.
    state.inFlight.add(dir);
    try {
      const files = await discoverContextFiles(dir, state.launchDir);
      if (!state) return;
      state.dirContexts.set(dir, { files });
      const fresh = pickNewFiles(state, files);
      if (fresh.length === 0) return;
      await pi.sendMessage(
        {
          customType: "on-demand-context",
          content: [{ type: "text", text: buildContextBlock(fresh) }],
          display: true,
          details: { files: fresh.map((f) => f.path) },
        },
        { deliverAs: "steer" },
      );
    } finally {
      state?.inFlight.delete(dir);
    }
  });

  // ---------------------------------------------------------------------------
  // before_agent_start — seed the dedup set with pi's own startup context files
  // so we never re-inject what pi already put in the system prompt.
  // ---------------------------------------------------------------------------

  pi.on("before_agent_start", (event) => {
    if (!state) return;
    for (const cf of event.systemPromptOptions?.contextFiles ?? []) {
      const p = typeof cf === "string" ? cf : cf?.path;
      if (p) state.piLoadedPaths.add(pathKey(p));
    }
  });

  // ---------------------------------------------------------------------------
  // `/list-context` command — user-only, no per-turn token cost
  // ---------------------------------------------------------------------------

  pi.registerCommand("list-context", {
    description: "List all loaded context files and their source directories.",
    handler: async (_args, ctx) => {
      if (!state || state.dirContexts.size === 0) {
        ctx.ui.notify("No context files loaded yet.", "info");
        return;
      }

      const lines: string[] = [];
      for (const [dir, dirState] of state.dirContexts) {
        lines.push(`\n${dir}:`);
        if (dirState.files.length === 0) {
          lines.push("  (no context files)");
        } else {
          for (const f of dirState.files) {
            lines.push(`  - ${f.path}`);
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---------------------------------------------------------------------------
  // Session reset
  // ---------------------------------------------------------------------------

  pi.on("session_start", () => {
    state = initState();
  });
}
