import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// pi's extension loader aliases "@earendil-works/pi-tui" (and pi-coding-agent)
// to the host's own copy at runtime, so the extension declares no runtime npm
// dep on them. Vitest has no such loader — alias both to minimal stubs so
// index.ts's imports resolve (and getAgentDir() is test-controllable).
export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-tui": fileURLToPath(
        new URL("./test/pi-tui-stub.ts", import.meta.url),
      ),
      "@earendil-works/pi-coding-agent": fileURLToPath(
        new URL("./test/pi-coding-agent-stub.ts", import.meta.url),
      ),
    },
  },
});
