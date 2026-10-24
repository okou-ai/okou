import process from "node:process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { generateWorkerRouteManifest } from "./generate-worker-route-manifest.mjs";
import {
  apiRoot,
  workerBuildOptions,
  validateWorkerExternals,
} from "./worker-build-options.mjs";

const outputRoot = resolve(apiRoot, "dist-worker-domains");
const domains = ["core", "execution", "integrations", "data"];
const originalSlides = resolve(
  apiRoot,
  "src/signals/services/google-slides-import.service.ts",
);
const slidesClient = resolve(apiRoot, "src/worker-domains/slides-client.ts");

function domainBindings() {
  return domains.map((domain) => {
    return {
      binding: domain.toUpperCase(),
      service: `okou-api-split-${domain}`,
    };
  });
}

function retainedModules(metafile) {
  const retained = new Map();
  for (const output of Object.values(metafile.outputs)) {
    for (const [path, input] of Object.entries(output.inputs)) {
      if (input.bytesInOutput > 0) {
        retained.set(path, (retained.get(path) ?? 0) + input.bytesInOutput);
      }
    }
  }
  return retained;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
try {
  const manifest = await generateWorkerRouteManifest(outputRoot);
  const summary = [];
  for (const name of ["gateway", ...domains, "processor"]) {
    const outputDirectory = resolve(outputRoot, name);
    await mkdir(outputDirectory, { recursive: true });
    const plugins = [
      {
        name: "domain-composition",
        setup(builder) {
          builder.onResolve({ filter: /^okou:worker-route-manifest$/ }, () => {
            return {
              path: resolve(outputRoot, "route-manifest.ts"),
            };
          });
          if (domains.includes(name)) {
            builder.onResolve(
              { filter: /google-slides-import\.service(?:\.ts)?$/ },
              ({ path, resolveDir }) => {
                const target = resolve(
                  resolveDir,
                  path.replace(/\.ts$/, "") + ".ts",
                );
                if (target === originalSlides) {
                  return { path: slidesClient };
                }
              },
            );
          }
        },
      },
    ];
    const result = await build(
      workerBuildOptions({
        entryPoint: `src/worker-domains/${name}.ts`,
        outputDirectory,
        plugins,
      }),
    );
    validateWorkerExternals(result);
    for (const output of result.outputFiles) {
      await writeFile(output.path, output.contents);
    }
    await writeFile(
      resolve(outputDirectory, "metafile.json"),
      `${JSON.stringify(result.metafile, null, 2)}\n`,
    );
    const bytes = await readFile(resolve(outputDirectory, "worker.js"));
    const retained = retainedModules(result.metafile);
    if (
      name === "gateway" &&
      [...retained.keys()].some((path) => {
        return /signals\/routes\/|api-contracts\/|app-factory/.test(path);
      })
    ) {
      throw new Error("Gateway unexpectedly imports API handlers or schemas");
    }
    if (
      domains.includes(name) &&
      [...retained.keys()].some((path) => {
        return /fontkit|brotli|google-slides-preparation/.test(path);
      })
    ) {
      throw new Error(
        `${name} retained presentation processing code instead of the service binding`,
      );
    }
    const stats = {
      name,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      retainedModules: retained.size,
      routes: manifest.filter((entry) => {
        return entry.domain === name;
      }).length,
      completionCallerRetained: [...retained.keys()].some((path) => {
        return path.endsWith("/internal-chat-run-callback.service.ts");
      }),
      completionInitializerRetained: [...retained.keys()].some((path) => {
        return path.endsWith(
          "/chat-run-finished-event-registration.service.ts",
        );
      }),
    };
    if (
      stats.completionCallerRetained &&
      !stats.completionInitializerRetained
    ) {
      throw new Error(
        `${name} can dispatch Chat/Run completion but has no initializer`,
      );
    }
    summary.push(stats);
    const config = {
      name: `okou-api-split-${name}`,
      main: "worker.js",
      no_bundle: true,
      compatibility_date: "2026-09-02",
      compatibility_flags: ["nodejs_compat", "enable_request_signal"],
      workers_dev: false,
      preview_urls: false,
      ...(name === "gateway" ? { services: domainBindings() } : {}),
      ...(domains.includes(name)
        ? {
            services: [
              {
                binding: "SLIDES_PREPARER",
                service: "okou-api-split-processor",
              },
            ],
            hyperdrive: [
              {
                binding: "HYPERDRIVE",
                id: "00000000000000000000000000000000",
                localConnectionString:
                  "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
              },
            ],
          }
        : {}),
    };
    await writeFile(
      resolve(outputDirectory, "wrangler.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(stats)}\n`);
  }
  await writeFile(
    resolve(outputRoot, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
} catch (error) {
  // Incomplete groups must never be mistaken for a deployable release.
  await rm(outputRoot, { recursive: true, force: true });
  throw error;
}
