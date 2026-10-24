import process from "node:process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import {
  apiRoot,
  workerBuildOptions,
  validateWorkerExternals,
} from "./worker-build-options.mjs";

const outputRoot = resolve(apiRoot, "dist-worker-ingress");
// Build the normal Worker first. This comparison keeps the experiment from
// silently changing business code while measuring a new ingress boundary.
const normalApi = await readFile(resolve(apiRoot, "dist-worker/worker.js"));
const sha256 = (bytes) => {
  return createHash("sha256").update(bytes).digest("hex");
};

function retainedModules(metafile) {
  const retained = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [path, input] of Object.entries(output.inputs)) {
      if (input.bytesInOutput > 0) {
        retained.add(path);
      }
    }
  }
  return retained;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
try {
  const summary = [];
  const manifest = { schemaVersion: 1, variants: {} };
  for (const name of ["ingress", "api"]) {
    const outputDirectory = resolve(outputRoot, name);
    await mkdir(outputDirectory, { recursive: true });
    // Ingress uses only Web APIs. Do not include the full API's Node require
    // banner or compatibility plugins in this dependency-free entry point.
    const options =
      name === "ingress"
        ? {
            absWorkingDir: apiRoot,
            entryPoints: ["src/worker-domains/ingress.ts"],
            outfile: resolve(outputDirectory, "worker.js"),
            bundle: true,
            platform: "browser",
            format: "esm",
            target: "es2022",
            minify: true,
            sourcemap: true,
            metafile: true,
            write: false,
          }
        : workerBuildOptions({
            entryPoint: "src/worker.ts",
            outputDirectory,
          });
    const result = await build(options);
    validateWorkerExternals(result);
    const retained = retainedModules(result.metafile);
    if (
      name === "ingress" &&
      (retained.size !== 1 ||
        !retained.has("src/worker-domains/ingress.ts") ||
        Object.values(result.metafile.outputs).some((output) => {
          return output.imports.length > 0;
        }))
    ) {
      throw new Error(
        "Ingress must retain only its dependency-free entry point",
      );
    }
    for (const output of result.outputFiles) {
      await writeFile(output.path, output.contents);
    }
    const bytes = await readFile(resolve(outputDirectory, "worker.js"));
    if (name === "api" && !bytes.equals(normalApi)) {
      throw new Error(
        "Ingress backend differs from the normal Worker; rebuild build:worker first and investigate the mismatch",
      );
    }
    const stats = {
      name,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      sha256: sha256(bytes),
      retainedModules: retained.size,
    };
    summary.push(stats);
    await writeFile(
      resolve(outputDirectory, "metafile.json"),
      `${JSON.stringify(result.metafile, null, 2)}\n`,
    );
    // These are templates, not deployment commands. The backend requires its
    // existing packed secrets and Hyperdrive binding to be supplied separately.
    const config = {
      name: `okou-api-ingress-${name}-experiment`,
      main: "worker.js",
      no_bundle: true,
      compatibility_date: "2026-09-02",
      compatibility_flags: name === "api" ? ["nodejs_compat"] : [],
      workers_dev: false,
      preview_urls: false,
      ...(name === "ingress"
        ? {
            services: [
              {
                binding: "API",
                service: "okou-api-ingress-api-experiment",
              },
            ],
          }
        : {}),
    };
    manifest.variants[name === "api" ? "full-api" : name] = {
      file: `${name}/worker.js`,
      sha256: stats.sha256,
      bytes: stats.bytes,
      retainedModules: stats.retainedModules,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
    };
    await writeFile(
      resolve(outputDirectory, "wrangler.template.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(stats)}\n`);
  }
  await writeFile(
    resolve(outputRoot, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFile(
    resolve(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
} catch (error) {
  await rm(outputRoot, { recursive: true, force: true });
  throw error;
}
