import { builtinModules } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { build } from "esbuild";
import { workerRequireBanner } from "./worker-bundle-banner.mjs";
import { auditWorkerRole, selectWorkerBuilds } from "./worker-role-build.mjs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selections = selectWorkerBuilds();
const builtins = new Set(
  builtinModules.map((name) => {
    return name.replace(/^node:/, "");
  }),
);

// This is separate from Vite/Vercel: only the Worker artifact replaces
// unsupported image/native PostgreSQL/React email rendering operations.
// The default artifact still aggregates the complete production API. Explicit
// --role/--roles builds are experimental artifacts; no deployment selects them.
const outputDirectories = selections.map(({ directory }) => {
  return resolve(apiRoot, directory);
});
for (const directory of outputDirectories) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

try {
  for (const selection of selections) {
    const outputDirectory = resolve(apiRoot, selection.directory);
    const result = await build({
      absWorkingDir: apiRoot,
      entryPoints: [selection.entry],
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

    const audit = selection.role
      ? auditWorkerRole(apiRoot, selection.role, result)
      : undefined;
    for (const output of result.outputFiles) {
      await writeFile(output.path, output.contents);
    }
    if (audit) {
      await writeFile(
        resolve(outputDirectory, "audit.json"),
        `${JSON.stringify(audit, null, 2)}\n`,
      );
    }
    await writeFile(
      resolve(outputDirectory, "metafile.json"),
      `${JSON.stringify(result.metafile, null, 2)}\n`,
    );
    process.stdout.write(
      `Built ${selection.role ?? "full API"} Worker: ${selection.directory}/worker.js\n`,
    );
  }
} catch (error) {
  // Never leave a partially built selection or stale deployable artifact.
  for (const directory of outputDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  throw error;
}
