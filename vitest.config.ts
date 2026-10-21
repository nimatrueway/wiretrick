import { defineConfig } from "vitest/config";

// unit tests exercise the MV2 code paths: inject the build flag the
// rolldown build would provide (transform.define)
export default defineConfig({
    define: {
        __MV3__: "false",
        __COMMIT__: JSON.stringify("test"),
        __BUILD_TIME__: JSON.stringify("1970-01-01T00:00:00.000Z"),
    },
    esbuild: { jsx: "automatic", jsxImportSource: "preact" },
    test: {
        // UI component tests (*.test.tsx) need a DOM
        environmentMatchGlobs: [["test/**/*.test.tsx", "happy-dom"]],
    },
});
