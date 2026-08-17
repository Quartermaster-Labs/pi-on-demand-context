import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolveCdDir, dirForToolEvent, pickNewFiles, discoverContextFiles } from "./index.ts";

const HOME = "/home/radu";
const CWD = "/proj/app";
const BASE = "/proj/app";

describe("discoverContextFiles", () => {
  it("returns files deepest-first across multiple depths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdoc-"));
    try {
      const mid = join(root, "mid");
      const deep = join(mid, "deep");
      await mkdir(deep, { recursive: true });
      await writeFile(join(root, "CLAUDE.md"), "top\n");
      await writeFile(join(mid, "CLAUDE.md"), "mid\n");
      await writeFile(join(deep, "CLAUDE.md"), "deep\n");
      const files = await discoverContextFiles(deep, root);
      expect(files.map((f) => f.path)).toEqual([
        join(deep, "CLAUDE.md"),
        join(mid, "CLAUDE.md"),
        join(root, "CLAUDE.md"),
      ]);
      expect(files.map((f) => f.content)).toEqual(["deep\n", "mid\n", "top\n"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveCdDir", () => {
  it("returns null for non-cd commands", () => {
    expect(resolveCdDir("ls -la", "", CWD, HOME)).toBeNull();
    expect(resolveCdDir("echo cd", "", CWD, HOME)).toBeNull();
  });

  it("bare `cd` goes home", () => {
    expect(resolveCdDir("cd", "", CWD, HOME)).toBe(HOME);
  });

  it("uses pwd output as the real dir", () => {
    expect(resolveCdDir("cd sub && pwd", "/proj/app/sub", CWD, HOME)).toBe("/proj/app/sub");
  });

  it("handles paths with spaces (the bug that bit us)", () => {
    const out = "/d/Projects/LLM Tests/qwen35b/tasktrack";
    expect(resolveCdDir("cd tasktrack && pwd", out, CWD, HOME)).toBe(out);
  });

  it("picks the last non-empty output line", () => {
    expect(resolveCdDir("cd x && pwd", "\n  /a/b  \n", CWD, HOME)).toBe("/a/b");
  });

  it("resolves a bare relative cd against the current dir", () => {
    expect(resolveCdDir("cd sub", "", CWD, HOME)).toBe(resolve(CWD, "sub"));
  });

  it("strips the `&& pwd` suffix from the target on the fallback path", () => {
    // No output -> falls back to resolve; target must NOT include "&& pwd"
    const got = resolveCdDir("cd sub && pwd", "", CWD, HOME)!;
    expect(got.endsWith("sub")).toBe(true);
    expect(got).not.toContain("pwd");
  });
});

describe("dirForToolEvent", () => {
  it("returns null for non-path tools", () => {
    expect(dirForToolEvent("bash", { command: "ls" }, BASE)).toBeNull();
    expect(dirForToolEvent("unknown", { path: "/x" }, BASE)).toBeNull();
  });

  it("file tools (read/edit/write) → dirname of an absolute path", () => {
    // Multi-char first segment → fromBashPath is a no-op, so dirname is stable
    // on both win32 and posix.
    const f = "/proj/app/pkg/__main__.py";
    expect(dirForToolEvent("read", { path: f }, BASE)).toBe(dirname(f));
    expect(dirForToolEvent("edit", { path: f }, BASE)).toBe(dirname(f));
    expect(dirForToolEvent("write", { path: f }, BASE)).toBe(dirname(f));
  });

  it("converts a bash drive path and keeps the spaced dir intact (the user's case)", () => {
    const f = "/d/Projects/LLM Tests/qwen35b/tasktrack/__main__.py";
    const got = dirForToolEvent("read", { path: f }, BASE)!;
    // win32 → D:\...\tasktrack ; posix → /d/.../tasktrack. Assert structurally.
    expect(got).toMatch(/tasktrack$/);
    expect(got).toContain("LLM Tests");
    expect(got).not.toContain("__main__.py");
  });

  it("accepts the file_path alias", () => {
    expect(dirForToolEvent("read", { file_path: "/proj/lib/c.ts" }, BASE)).toBe(dirname("/proj/lib/c.ts"));
  });

  it("file tools resolve a relative path against baseDir", () => {
    expect(dirForToolEvent("read", { path: "sub/x.ts" }, BASE)).toBe(resolve(BASE, "sub"));
  });

  it("file tools without a path return null", () => {
    expect(dirForToolEvent("read", {}, BASE)).toBeNull();
  });

  it("dir tools (grep/ls/find) → the dir itself", () => {
    expect(dirForToolEvent("ls", { path: "/some/dir" }, BASE)).toBe("/some/dir");
    expect(dirForToolEvent("grep", { path: "/some/dir", pattern: "x" }, BASE)).toBe("/some/dir");
  });

  it("dir tools default to baseDir when path omitted", () => {
    expect(dirForToolEvent("ls", {}, BASE)).toBe(BASE);
    expect(dirForToolEvent("grep", { pattern: "x" }, BASE)).toBe(BASE);
  });
});

describe("pickNewFiles", () => {
  const f = (path: string) => ({ path, content: `# ${path}` });

  it("drops files pi already loaded at startup", () => {
    const s = {
      piLoadedPaths: new Set(["/proj/claude.md"]), // pathKey lowercases
      injected: new Set<string>(),
    };
    const out = pickNewFiles(s, [f("/proj/app/CLAUDE.md"), f("/proj/CLAUDE.md")]);
    expect(out.map((x) => x.path)).toEqual(["/proj/app/CLAUDE.md"]);
  });

  it("dedups a parent file shared across two dirs (marks injected)", () => {
    const s = { piLoadedPaths: new Set<string>(), injected: new Set<string>() };
    const first = pickNewFiles(s, [f("/proj/a/CLAUDE.md"), f("/proj/CLAUDE.md")]);
    expect(first.map((x) => x.path)).toEqual(["/proj/a/CLAUDE.md", "/proj/CLAUDE.md"]);
    // Second dir shares /proj/CLAUDE.md — already injected, so only the new one
    const second = pickNewFiles(s, [f("/proj/b/CLAUDE.md"), f("/proj/CLAUDE.md")]);
    expect(second.map((x) => x.path)).toEqual(["/proj/b/CLAUDE.md"]);
  });

  it("preserves input order (caller passes deepest-first)", () => {
    const s = { piLoadedPaths: new Set<string>(), injected: new Set<string>() };
    const out = pickNewFiles(s, [f("/proj/a/b/CLAUDE.md"), f("/proj/CLAUDE.md")]);
    expect(out.map((x) => x.path)).toEqual(["/proj/a/b/CLAUDE.md", "/proj/CLAUDE.md"]);
  });
});
