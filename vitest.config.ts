import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// pi's extension loader aliases "@earendil-works/pi-tui" to the host's own
// copy at runtime, so the extension declares no npm dep on it. Vitest has no
// such loader — alias it to a minimal stub so index.ts's import resolves.
export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-tui": fileURLToPath(
        new URL("./test/pi-tui-stub.ts", import.meta.url),
      ),
    },
  },
});
