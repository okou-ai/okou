import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { build } from "esbuild";
import { builtins, workerBuildOptions } from "./worker-build-options.mjs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(apiRoot, "dist-worker");

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
    ...workerBuildOptions(apiRoot),
    sourcemap: true,
    metafile: true,
    write: false,
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
