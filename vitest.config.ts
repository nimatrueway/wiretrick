import { defineConfig } from "vitest/config";

// unit tests exercise the MV2 code paths: inject the build flag the
// rolldown build would provide (transform.define)
export default defineConfig({
    define: {
        __MV3__: "false",
    },
    esbuild: { jsx: "automatic", jsxImportSource: "preact" },
    test: {
        // UI component tests (*.test.tsx) need a DOM
        environmentMatchGlobs: [["test/**/*.test.tsx", "happy-dom"]],
    },
});
