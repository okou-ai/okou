import process from "node:process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
  apiRoot,
  workerBuildOptions,
  validateWorkerExternals,
} from "./worker-build-options.mjs";

const outputDirectory = resolve(apiRoot, "dist-worker");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
try {
  const result = await build(
    workerBuildOptions({ entryPoint: "src/worker.ts", outputDirectory }),
  );
  validateWorkerExternals(result);
  for (const output of result.outputFiles) {
    await writeFile(output.path, output.contents);
  }
  await writeFile(
    resolve(outputDirectory, "metafile.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );
  process.stdout.write("Built full API Worker: dist-worker/worker.js\n");
} catch (error) {
  await rm(outputDirectory, { recursive: true, force: true });
  throw error;
}
