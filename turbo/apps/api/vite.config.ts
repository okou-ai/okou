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
      // Keep the prebuilt Vercel function's Node req/res entry on the same
      // adapter as the standalone server; v2 removed the /vercel export.
      entryContentAfterHooks: [
        () => {
          return "import { getRequestListener } from '@hono/node-server'";
        },
      ],
      entryContentDefaultExportHook: (appName) => {
        return `export default getRequestListener(${appName}.fetch)`;
      },
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
