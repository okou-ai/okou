import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Hosted Clerk components render through the Clerk core in a real
      // browser; page tests observe their mount contract instead.
      "@clerk/react": path.resolve(
        __dirname,
        "./src/test/mocks/clerk-react.ts",
      ),
      "@clerk/shared/loadClerkJsScript": path.resolve(
        __dirname,
        "./src/test/mocks/clerk-resource.ts",
      ),
      "@clerk/shared/loadScript": path.resolve(
        __dirname,
        "./src/test/mocks/clerk-resource.ts",
      ),
      "@sentry/browser": path.resolve(
        __dirname,
        "./src/test/mocks/sentry-browser.ts",
      ),
      "@sentry/react": path.resolve(
        __dirname,
        "./src/test/mocks/sentry-react.ts",
      ),
      // Mock ably in tests so setupRealtime$ creates a fake channel and
      // setAblyLoop$ uses the real subscribe/deferred code path.
      "ably/modular": path.resolve(__dirname, "./src/mocks/ably.ts"),
      ably: path.resolve(__dirname, "./src/mocks/ably.ts"),
      // Stub Mermaid rendering in tests: the real renderer needs the SVG
      // measurement APIs of a browser layout engine, which happy-dom does not
      // implement. Parsing has no such needs, so the stub delegates it to the
      // real supported-diagrams module via `mermaid-lite-real`.
      "@okouai/mermaid-lite": path.resolve(__dirname, "./src/mocks/mermaid.ts"),
      "mermaid-lite-real": path.resolve(
        __dirname,
        "../../packages/mermaid-lite/dist/mermaid.esm.min.mjs",
      ),
      "virtual:shared-database-worker": `${path.resolve(
        __dirname,
        "./src/shared-database-worker.ts",
      )}?sharedworker&url`,
    },
  },
  define: {
    __OKOU_APP_VERSION__: JSON.stringify("0.540.0"),
  },
  test: {
    coverage: {
      exclude: [
        "src/**/__tests__/**",
        "src/__tests__/**",
        "src/mocks/**",
        "src/test/**",
      ],
    },
    globals: true,
    environment: "happy-dom",
    env: {
      VITE_CLERK_PUBLISHABLE_KEY_PREVIEW: "test_preview_key",
      VITE_CLERK_PUBLISHABLE_KEY_PROD: "test_production_key",
      VITE_POSTHOG_KEY: "phc_platform_test",
    },
    environmentOptions: {
      happyDOM: {
        settings: {
          // Prevent happy-dom from making real TCP connections for iframe src
          // URLs. With this enabled, #loadPage() returns immediately with a
          // NotSupportedError instead of initiating a network request. The
          // error is suppressed in setup.ts.
          disableIframePageLoading: true,
          // Prevent happy-dom from making real TCP connections for
          // `<link rel="stylesheet">` hrefs. Tests that parse index.html into a
          // live document connect its Google Fonts stylesheet link, and
          // happy-dom starts a fetch that no test owns or awaits. Vitest only
          // aborts it when it tears the window down after the whole file, and
          // destroying the socket mid-TLS-write surfaces as an uncaught
          // `write ECANCELED Canceled because of SSL destruction`.
          disableCSSFileLoading: true,
          // Report the skipped stylesheet load as a `load` event instead of a
          // console error plus `error` event, so disabling the fetch does not
          // trade a leaked socket for teardown noise.
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    benchmark: {
      include: ["src/**/__benches__/**/*.bench.tsx"],
      retainSamples: true,
    },
  },
});
