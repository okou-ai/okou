import { readFileSync } from "node:fs";
import path from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "vite";
import type { PluginOption } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf8"),
) as {
  version: string;
};
const sentryProject =
  process.env.SENTRY_PROJECT_DESKTOP ?? process.env.SENTRY_PROJECT;
const sentryRelease = `desktop@${pkg.version}`;
const shouldUploadSentrySourceMaps = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && sentryProject,
);
const plugins: PluginOption[] = [react()];

if (shouldUploadSentrySourceMaps) {
  plugins.push(
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: sentryProject,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      telemetry: false,
      release: {
        name: sentryRelease,
      },
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/renderer/**/*.map"],
      },
    }),
  );
}

export default defineConfig({
  root: path.join(__dirname, "src", "renderer"),
  base: "./",
  plugins,
  build: {
    rollupOptions: {
      input: {
        index: path.join(__dirname, "src", "renderer", "index.html"),
      },
    },
    outDir: path.join(__dirname, "dist", "renderer"),
    emptyOutDir: true,
    sourcemap: shouldUploadSentrySourceMaps,
  },
  define: {
    __DESKTOP_SENTRY_ENABLED__: JSON.stringify(
      Boolean(process.env.SENTRY_DSN_DESKTOP),
    ),
  },
});
