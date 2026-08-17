// Minimal stand-in for @earendil-works/pi-coding-agent under vitest (see
// vitest.config.ts). pi's extension loader aliases the real package to the
// host's own copy at runtime, so the extension declares it only as a peer
// dep. index.ts's type-only imports are erased; this stub provides the two
// runtime values it imports:
//
//   CONFIG_DIR_NAME — ".pi" (project-local config dir)
//   getAgentDir()   — honors PI_TEST_AGENT_DIR so loadConfig tests can point
//                     the global config lookup at a temp dir (hermetic);
//                     falls back to a throwaway path outside any real config.
import { join } from "node:path";
import { tmpdir } from "node:os";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
  return (
    process.env.PI_TEST_AGENT_DIR || join(tmpdir(), "pi-test-agent-stub")
  );
}
