import build from "@hono/vite-build/vercel";
import { defineConfig } from "vite";

import vercelConfig from "./vercel.json";

export default defineConfig({
  build: {
    copyPublicDir: false,
    rollupOptions: {
      output: {
        // Vercel only packages files inside the .func directory for a function.
        codeSplitting: false,
      },
    },
  },
  plugins: [
    build({
      emptyOutDir: true,
      entry: "./src/index.ts",
      // @hono/vite-build still emits the Vercel adapter removed in
      // @hono/node-server v2. Keep that build-only adapter on v1 while the
      // long-lived server runtime uses v2.
      entryContentAfterHooks: [
        () => {
          return "import { handle } from '@hono/node-server-v1/vercel'";
        },
      ],
      vercel: {
        // Hono currently builds one function for all routes. Its independent
        // Morning Brief waitUntil invocations need a platform deadline beyond
        // the 180s per-owner budget; the cron retains its own 45s bound.
        function: { maxDuration: 300 },
        config: {
          crons: vercelConfig.crons,
        },
      },
    }),
  ],
});
