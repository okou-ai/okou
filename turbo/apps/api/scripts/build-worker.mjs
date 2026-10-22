import { builtinModules } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { build } from "esbuild";
import { workerRequireBanner } from "./worker-bundle-banner.mjs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(apiRoot, "dist-worker");
const builtins = new Set(
  builtinModules.map((name) => {
    return name.replace(/^node:/, "");
  }),
);

// This is separate from Vite/Vercel: only the Worker artifact replaces
// unsupported image/native PostgreSQL/React email rendering operations.
// All routes still come from the production app imported by src/worker.ts.
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

try {
  const result = await build({
    absWorkingDir: apiRoot,
    entryPoints: ["src/worker.ts"],
    outfile: "dist-worker/worker.js",
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
  });

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

  for (const output of result.outputFiles) {
    await writeFile(output.path, output.contents);
  }
  await writeFile(
    resolve(outputDirectory, "metafile.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );
  process.stdout.write("Built full API Worker: dist-worker/worker.js\n");
} catch (error) {
  // Never leave a stale artifact that CI could deploy after a failed build.
  await rm(outputDirectory, { recursive: true, force: true });
  throw error;
}
