import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { workerRequireBanner } from "./worker-bundle-banner.mjs";

export const apiRoot = resolve(import.meta.dirname, "..");
const builtins = new Set(
  builtinModules.map((name) => {
    return name.replace(/^node:/, "");
  }),
);

export function workerBuildOptions({
  entryPoint,
  outputDirectory,
  plugins = [],
}) {
  return {
    absWorkingDir: apiRoot,
    entryPoints: [entryPoint],
    outfile: resolve(outputDirectory, "worker.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    minify: true,
    keepNames: true,
    sourcemap: true,
    metafile: true,
    write: false,
    // Keep Cloudflare's native modules intact; Wrangler must not rebundle this.
    external: ["cloudflare:*"],
    conditions: ["workerd", "worker"],
    // Preserve real error reporting using Sentry's Workers-native SDK.
    alias: { "@sentry/node": "@sentry/cloudflare" },
    banner: {
      js: workerRequireBanner,
    },
    plugins: [
      ...plugins,
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
          ]);
          builder.onResolve(
            { filter: /^(pg-native|@react-email\/render)$/ },
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

export function validateWorkerExternals(result) {
  // A no-bundle deployment cannot resolve third-party packages at runtime.
  // Only Workers native modules and nodejs_compat builtins may stay external.
  const unresolvedDependencies = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (
        dependency.external &&
        !dependency.path.startsWith("cloudflare:") &&
        !builtins.has(dependency.path.replace(/^node:/, ""))
      ) {
        unresolvedDependencies.add(dependency.path);
      }
    }
  }
  if (unresolvedDependencies.size > 0) {
    throw new Error(
      `Unbundled dependencies ${[...unresolvedDependencies].join(", ")} are not Workers native modules or Node builtins. Resolve these Worker compatibility blockers before deploying.`,
    );
  }
}
