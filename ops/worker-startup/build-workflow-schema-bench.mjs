// Run from any directory with the repository's installed toolchain:
// First run pnpm --dir turbo/apps/api build:worker from the repository root.
// node ops/worker-startup/build-workflow-schema-bench.mjs --out <directory>
// Builds two complete API Workers without deploying or making HTTP requests.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  workerBuildOptions,
  validateWorkerExternals,
} from "../../turbo/apps/api/scripts/worker-build-options.mjs";

const repository = resolve(import.meta.dirname, "../..");
const require = createRequire(
  resolve(repository, "turbo/apps/api/package.json"),
);
const { build } = require("esbuild");
const baselineRevision = "197b2bc9d1e88e777dfe0882c503eba06bbb2012";
const baselineBundleHash =
  "520e49d8695eee198c79a6cc71336197d8d2a5b835153f4fc20b28df0841726d";
const contractPath = "turbo/packages/api-contracts/src/contracts/workflows.ts";
const contractAbsolute = resolve(repository, contractPath);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

if (process.argv.length !== 4 || process.argv[2] !== "--out") {
  throw new Error("Usage: build-workflow-schema-bench.mjs --out <directory>");
}
const outputRoot = resolve(process.argv[3]);
const sourceRevision = git("rev-parse", "HEAD");
const baselineContract = execFileSync(
  "git",
  ["show", `${baselineRevision}:${contractPath}`],
  { cwd: repository, encoding: "utf8" },
);
const optimizedContract = await readFile(contractAbsolute, "utf8");
const variants = {};

for (const [name, contents] of [
  ["baseline", baselineContract],
  ["optimized", optimizedContract],
]) {
  const outputDirectory = resolve(outputRoot, name);
  await mkdir(outputDirectory, { recursive: true });
  const result = await build(
    workerBuildOptions({
      entryPoint: "src/worker.ts",
      outputDirectory,
      plugins: [
        {
          name: "workflow-schema-comparison",
          setup(builder) {
            builder.onLoad(
              { filter: /[/\\]contracts[/\\]workflows\.ts$/ },
              ({ path }) => {
                if (path === contractAbsolute)
                  return { contents, loader: "ts" };
              },
            );
          },
        },
      ],
    }),
  );
  validateWorkerExternals(result);
  const bundle = result.outputFiles.find(
    (file) => file.path === resolve(outputDirectory, "worker.js"),
  );
  if (!bundle)
    throw new Error("Full API Worker build did not produce worker.js");
  const digest = sha256(bundle.contents);
  if (name === "baseline" && digest !== baselineBundleHash) {
    throw new Error("Baseline differs from the frozen complete API Worker");
  }
  if (name === "optimized") {
    const normalBundle = await readFile(
      resolve(repository, "turbo/apps/api/dist-worker/worker.js"),
    );
    if (digest !== sha256(normalBundle)) {
      throw new Error("Candidate differs from the normal complete API Worker");
    }
  }
  for (const file of result.outputFiles)
    await writeFile(file.path, file.contents);
  await writeFile(
    resolve(outputDirectory, "metafile.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );
  variants[name] = {
    file: `${name}/worker.js`,
    sha256: digest,
    bytes: bundle.contents.length,
    contractSha256: sha256(contents),
  };
}

await writeFile(
  resolve(outputRoot, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      baselineRevision,
      sourceRevision,
      sourceTree: git("rev-parse", "HEAD^{tree}"),
      trackedWorktreeClean:
        git("status", "--porcelain", "--untracked-files=no") === "",
      lockfileSha256: sha256(
        await readFile(resolve(repository, "turbo/pnpm-lock.yaml")),
      ),
      variants,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `${JSON.stringify({ baselineRevision, sourceRevision, variants })}\n`,
);
