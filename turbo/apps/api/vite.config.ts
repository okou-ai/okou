import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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
    {
      name: "hosted-preview-native-assets",
      async writeBundle() {
        // Vercel prebuilt functions only include files inside their .func directory.
        // Sharp's JS is bundled, but its dynamic native imports must ship beside it.
        // Deployment builds run on Linux/glibc with the target architecture.
        const requireSharp = createRequire(import.meta.resolve("sharp"));
        const platform = `${process.platform}-${process.arch}`;
        const packages = [`@img/sharp-${platform}`];
        if (process.platform !== "win32") {
          packages.push(`@img/sharp-libvips-${platform}`);
        }
        for (const name of packages) {
          await cp(
            dirname(requireSharp.resolve(`${name}/package`)),
            resolve(".vercel/output/functions/__hono.func/node_modules", name),
            { recursive: true },
          );
        }
      },
    },
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
