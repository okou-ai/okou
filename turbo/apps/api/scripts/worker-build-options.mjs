import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { workerRequireBanner } from "./worker-bundle-banner.mjs";

export const builtins = new Set(
  builtinModules.map((name) => {
    return name.replace(/^node:/, "");
  }),
);

/**
 * esbuild options shared by the production Worker build and the Worker
 * contract boundary check, so the check sees the same module graph.
 */
export function workerBuildOptions(apiRoot) {
  return {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    minify: true,
    keepNames: true,
    // Keep Cloudflare's native modules intact; Wrangler must not rebundle this.
    external: ["cloudflare:*"],
    // Custom conditions drop esbuild's default `module` condition. Keep it so
    // packages' ESM builds (for example OpenTelemetry's) are tree-shaken
    // instead of CommonJS aggregates that initialize every export at startup.
    conditions: ["workerd", "worker", "module"],
    // Shared code imports @sentry/node, which cannot run on Workers. The Worker
    // never initializes Sentry, so these Workers SDK calls remain no-ops.
    alias: { "@sentry/node": "@sentry/cloudflare" },
    banner: {
      js: workerRequireBanner,
    },
    plugins: [
      {
        name: "worker-compatibility",
        setup(builder) {
          // --no-bundle skips Wrangler's normal builtin normalization. Workers
          // native imports require node: even when a dependency uses bare names.
          builder.onResolve({ filter: /^[^./]/ }, ({ path }) => {
            const name = path.replace(/^node:/, "");
            if (builtins.has(name)) {
              return { path: `node:${name}`, external: true };
            }
          });
          const unsupportedPackages = new Map([
            ["pg-native", "pg-native"],
            ["@react-email/render", "react-email"],
            // Vercel-only fallbacks; Workers use their RequestRuntime instead.
            ["@vercel/functions", "vercel-functions"],
            ["@vercel/oidc", "vercel-oidc"],
          ]);
          builder.onResolve(
            {
              filter:
                /^(pg-native|@react-email\/render|@vercel\/functions|@vercel\/oidc)$/,
            },
            ({ path }) => {
              return {
                path: resolve(
                  apiRoot,
                  `src/worker-unsupported-${unsupportedPackages.get(path)}.ts`,
                ),
              };
            },
          );
          builder.onLoad({ filter: /\.node$/ }, ({ path }) => {
            return {
              errors: [
                {
                  text: `Native addon ${path} cannot run on Cloudflare Workers. Provide a reviewed Worker-compatible implementation; do not externalize or silently stub it.`,
                },
              ],
            };
          });
        },
      },
    ],
  };
}
