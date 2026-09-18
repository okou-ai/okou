import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { artifactUrlSchema } from "@okouai/api-contracts/contracts/artifact-references";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { generateWebImage } from "../../lib/api/domains/web";
import { absoluteArtifactUrl } from "../../lib/artifact-url";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { assertPaidToolEnabled } from "../../lib/command/paid-tools";
import { generatedImageAsset } from "../shared/generated-image-asset";
import {
  ARTIFACT_PRESENTATION_CONTEXT,
  createArtifactPresentation,
} from "../shared/artifact-return";
import {
  applyArtifactVisibility,
  createArtifactVisibilityOption,
  prepareArtifactVisibility,
  type ArtifactVisibility,
} from "../shared/artifact-visibility";

const MAX_CONCURRENCY = 3;
const DEFAULT_SIZE = "816x816";
const POLL_INTERVAL_MS = 500;
const RETRY_DELAY_MS = 1_000;
const BATCH_PRESENTATION_CONTEXT =
  "asset identifies the material for authored HTML; local paths are relative to the batch directory and are only available inside the agent runtime. Use each item's stable artifact reference for chat. " +
  ARTIFACT_PRESENTATION_CONTEXT;

const imageBatchArtifactsSchema = z.object({
  resultsPath: z.string(),
  artifacts: z.array(
    z.object({
      assetId: z.string(),
      asset: z.string(),
      url: artifactUrlSchema,
      ownerUrl: artifactUrlSchema.optional(),
      visibility: z.enum(["only-me", "org", "public"]).optional(),
      privateArtifacts: z.boolean().optional(),
      inlineMarkdownLink: z.string(),
      previewMarkdownBlock: z.string(),
    }),
  ),
  artifactPresentationContext: z.string(),
});
type ImageBatchArtifact = z.infer<
  typeof imageBatchArtifactsSchema
>["artifacts"][number];

interface ImageBatchJob {
  readonly id: string;
  readonly prompt: string;
  readonly size: string;
}

interface ImageBatchWaitOptions {
  readonly timeout: number;
  readonly json?: boolean;
}

interface ImageBatchGenerationOptions {
  readonly visibility?: ArtifactVisibility;
}

function shellQuoteArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function parseTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("timeout must be a positive integer");
  }
  return parsed;
}

async function readManifest(manifestPath: string): Promise<ImageBatchJob[]> {
  const text = await readFile(manifestPath, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    throw new Error("Image batch manifest must contain at least one job");
  }
  const ids = new Set<string>();
  return lines.map((line, index) => {
    if (line.trim() === "") {
      throw new Error(`Image batch manifest line ${index + 1} is blank`);
    }
    const fields = line.split("\t");
    if (fields.length !== 2 && fields.length !== 3) {
      throw new Error(
        `Image batch manifest line ${index + 1} must be ID<TAB>PROMPT[<TAB>SIZE]`,
      );
    }

    const idField = fields[0];
    const promptField = fields[1];
    if (idField === undefined || promptField === undefined) {
      throw new Error(
        `Image batch manifest line ${index + 1} must be ID<TAB>PROMPT[<TAB>SIZE]`,
      );
    }
    const id = idField.trim();
    const prompt = promptField.trim();
    const size = fields[2]?.trim() || DEFAULT_SIZE;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(
        `Image batch manifest line ${index + 1} has an invalid ID: ${id}`,
      );
    }
    if (ids.has(id)) {
      throw new Error(`Image batch manifest has a duplicate ID: ${id}`);
    }
    if (prompt === "") {
      throw new Error(
        `Image batch manifest line ${index + 1} has an empty prompt`,
      );
    }
    ids.add(id);
    return { id, prompt, size };
  });
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return error.status === 429 || error.status >= 500;
  }
  return (
    error instanceof Error &&
    /temporar|timed? out|econnreset|fetch failed|rate limit/i.test(
      error.message,
    )
  );
}

async function generateOne(
  job: ImageBatchJob,
  requirePrivateArtifact: true | undefined,
) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await generateWebImage({
        prompt: job.prompt,
        model: "seedream4",
        size: job.size,
        quality: "low",
        background: "auto",
        outputFormat: "png",
        moderation: "auto",
        safetyTolerance: "4",
        imageUrls: [],
        requirePrivateArtifact,
      });
      return result;
    } catch (error) {
      if (attempt === 2 || !shouldRetry(error)) throw error;
      console.log(`Retrying image batch job ${job.id} once`);
      await delay(RETRY_DELAY_MS);
    }
  }
  throw new Error(`Image batch job ${job.id} did not return a result`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, path);
}

async function runBatch(
  manifestPath: string,
  stateDirectory: string,
  options: ImageBatchGenerationOptions,
): Promise<void> {
  const jobs = await readManifest(manifestPath);
  const requirePrivateArtifact = await prepareArtifactVisibility(
    options.visibility,
  );
  const results: Array<ImageBatchArtifact | undefined> = Array.from({
    length: jobs.length,
  });
  const failures: string[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < jobs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const job = jobs[index];
      if (job === undefined) {
        throw new Error(`Image batch job ${index} is missing`);
      }
      try {
        const generated = await generateOne(job, requirePrivateArtifact);
        const result = await applyArtifactVisibility(
          generated,
          { kind: "file", id: generated.id },
          options.visibility,
        );
        const asset = await generatedImageAsset(
          generated,
          job.id,
          stateDirectory,
        );
        const presentation = createArtifactPresentation(job.id, result.url);
        results[index] = {
          assetId: job.id,
          asset,
          url: result.url,
          ...(result.ownerUrl ? { ownerUrl: result.ownerUrl } : {}),
          ...(result.visibility ? { visibility: result.visibility } : {}),
          ...(result.privateArtifacts === undefined
            ? {}
            : { privateArtifacts: result.privateArtifacts }),
          inlineMarkdownLink: presentation.json.inlineMarkdownLink,
          previewMarkdownBlock: presentation.json.previewMarkdownBlock,
        };
      } catch (error) {
        failures.push(`${job.id}: ${errorMessage(error)}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, jobs.length) }, async () => {
      await worker();
    }),
  );
  if (failures.length > 0) {
    throw new Error(`Image batch failed: ${failures.join("; ")}`);
  }

  const artifacts = jobs.map((job, index) => {
    const result = results[index];
    if (result === undefined) {
      throw new Error(`Image batch job ${job.id} has no result`);
    }
    return result;
  });
  const resultsPath = join(stateDirectory, "results.tsv");
  await writeAtomic(
    resultsPath,
    `${artifacts
      .map((artifact) => {
        return `${artifact.assetId}\t${artifact.asset}`;
      })
      .join("\n")}\n`,
  );
  await writeAtomic(
    join(stateDirectory, "artifacts.json"),
    JSON.stringify(
      {
        resultsPath,
        artifacts,
        artifactPresentationContext: BATCH_PRESENTATION_CONTEXT,
      },
      null,
      2,
    ) + "\n",
  );
}

async function runInternal(
  manifestPathValue: string,
  stateDirectoryValue: string,
  options: ImageBatchGenerationOptions,
): Promise<void> {
  await assertPaidToolEnabled("image-generation");
  const manifestPath = resolve(manifestPathValue);
  const stateDirectory = resolve(stateDirectoryValue);
  let exitCode = 0;
  try {
    await runBatch(manifestPath, stateDirectory, options);
    console.log(`Image batch complete: ${join(stateDirectory, "results.tsv")}`);
  } catch (error) {
    exitCode = 1;
    console.error(`Image batch failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  } finally {
    await writeAtomic(join(stateDirectory, "done"), `${exitCode}\n`);
  }
}

function childArguments(
  manifestPath: string,
  stateDirectory: string,
  options: ImageBatchGenerationOptions,
): string[] {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot locate the Okou CLI entrypoint");
  }
  const runtimeArguments = entrypoint.endsWith(".ts") ? process.execArgv : [];
  return [
    ...runtimeArguments,
    entrypoint,
    "generate",
    "image-batch",
    "__run",
    manifestPath,
    stateDirectory,
    ...(options.visibility ? ["--visibility", options.visibility] : []),
  ];
}

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  });
}

async function startBatch(
  manifestPathValue: string,
  stateDirectoryValue: string,
  options: ImageBatchGenerationOptions,
): Promise<void> {
  await assertPaidToolEnabled("image-generation");
  const manifestPath = resolve(manifestPathValue);
  const stateDirectory = resolve(stateDirectoryValue);
  await readManifest(manifestPath);
  if (await pathExists(stateDirectory)) {
    throw new Error(
      `Image batch state directory already exists: ${stateDirectory}`,
    );
  }

  await prepareArtifactVisibility(options.visibility);
  await mkdir(stateDirectory, { recursive: false });
  const copiedManifest = join(stateDirectory, "manifest.tsv");
  const logHandle = await open(join(stateDirectory, "output.log"), "a");
  try {
    await copyFile(manifestPath, copiedManifest);
    const child = spawn(
      process.execPath,
      childArguments(copiedManifest, stateDirectory, options),
      {
        detached: true,
        env: process.env,
        stdio: ["ignore", logHandle.fd, logHandle.fd],
      },
    );
    await waitForSpawn(child);
    if (child.pid === undefined) {
      throw new Error("Image batch worker did not report a process ID");
    }
    await writeFile(join(stateDirectory, "pid"), `${child.pid}\n`, "utf8");
    child.unref();
  } catch (error) {
    await logHandle.close();
    await rm(stateDirectory, { recursive: true, force: true });
    throw error;
  }
  await logHandle.close();
  console.log(`Image batch started: ${stateDirectory}`);
  console.log(
    [
      "The images are being generated in the background.",
      "Wait for this batch before using its results:",
      `okou generate image-batch wait ${shellQuoteArg(stateDirectory)}`,
      "Continue authoring while it runs; reuse this batch instead of starting another one.",
    ].join("\n"),
  );
}

async function readBatchArtifacts(stateDirectory: string) {
  try {
    const metadata = imageBatchArtifactsSchema.parse(
      JSON.parse(
        await readFile(join(stateDirectory, "artifacts.json"), "utf8"),
      ),
    );
    const artifacts = await Promise.all(
      metadata.artifacts.map(async (artifact) => {
        const url = await absoluteArtifactUrl(artifact.url);
        const presentation = createArtifactPresentation(
          artifact.assetId,
          url,
          undefined,
          artifact,
        ).json;
        return {
          ...artifact,
          url,
          ...(artifact.ownerUrl === undefined
            ? {}
            : { ownerUrl: await absoluteArtifactUrl(artifact.ownerUrl) }),
          inlineMarkdownLink:
            url === artifact.url
              ? artifact.inlineMarkdownLink
              : presentation.inlineMarkdownLink,
          previewMarkdownBlock:
            url === artifact.url
              ? artifact.previewMarkdownBlock
              : presentation.previewMarkdownBlock,
          ...(artifact.privateArtifacts === undefined
            ? {}
            : {
                artifactPresentationContext:
                  presentation.artifactPresentationContext,
              }),
        };
      }),
    );
    return { ...metadata, artifacts };
  } catch (error) {
    // Persisted batches created before presentation metadata still contain usable
    // TSV assets. Retain until support for those stored batch directories is retired.
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function missingBatchArtifactsContext(stateDirectory: string): string {
  return [
    "This batch has no artifact presentation metadata.",
    `Local asset paths in results.tsv are relative to ${stateDirectory}.`,
    "To present a selected local image in chat, upload it with okou web upload-file -f <selected-local-file>.",
    "The upload result provides inline-link and rich-preview Markdown forms.",
  ].join("\n");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "EPERM"
    );
  }
}

async function waitForBatch(
  stateDirectoryValue: string,
  options: ImageBatchWaitOptions,
): Promise<void> {
  const stateDirectory = resolve(stateDirectoryValue);
  const pidText = await readFile(join(stateDirectory, "pid"), "utf8");
  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Image batch has an invalid PID: ${pidText.trim()}`);
  }

  const donePath = join(stateDirectory, "done");
  const deadline = Date.now() + options.timeout * 1_000;
  while (!(await pathExists(donePath))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Image batch is still running after ${options.timeout}s; rerun wait on ${stateDirectory}`,
      );
    }
    if (!isProcessAlive(pid)) {
      await delay(200);
      if (!(await pathExists(donePath))) {
        throw new Error(
          `Image batch worker ${pid} exited without writing completion state`,
        );
      }
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }

  const exitCode = Number((await readFile(donePath, "utf8")).trim());
  if (exitCode !== 0) {
    const log = await readFile(join(stateDirectory, "output.log"), "utf8");
    throw new Error(`Image batch worker failed\n${log.trimEnd()}`);
  }
  const resultsPath = join(stateDirectory, "results.tsv");
  const results = await readFile(resultsPath, "utf8");
  const metadata = await readBatchArtifacts(stateDirectory);
  if (options.json) {
    console.log(
      JSON.stringify(
        metadata
          ? { ...metadata, resultsPath }
          : {
              resultsPath,
              artifactPresentationContext:
                missingBatchArtifactsContext(stateDirectory),
            },
      ),
    );
    return;
  }
  console.log(results.trimEnd());
  console.log(`Image batch joined: ${resultsPath}`);
  console.log(
    metadata
      ? [
          "",
          "Artifact presentation context:",
          `results.tsv lists assets for authored HTML. Resolve local paths against ${stateDirectory} and copy those files into the authored bundle.`,
          `For chat presentation, read ${join(stateDirectory, "artifacts.json")}. Each image includes its stable artifact reference, inlineMarkdownLink, and previewMarkdownBlock.`,
          metadata.artifactPresentationContext,
          ...new Set(
            metadata.artifacts.flatMap((artifact) => {
              return artifact.artifactPresentationContext
                ? [artifact.artifactPresentationContext]
                : [];
            }),
          ),
        ].join("\n")
      : `\n${missingBatchArtifactsContext(stateDirectory)}`,
  );
}

const startCommand = new Command("start")
  .description("Start a detached image batch")
  .argument("<manifest.tsv>", "ID, raw prompt, and optional size per line")
  .argument("<state-dir>", "New directory for batch state and results")
  .addOption(createArtifactVisibilityOption())
  .action(withErrorHandler(startBatch));

const waitCommand = new Command("wait")
  .description("Wait for an image batch and print its results")
  .argument("<state-dir>", "State directory returned by start")
  .option("--timeout <seconds>", "Maximum wait time", parseTimeout, 300)
  .option("--json", "Print batch artifacts and presentation guidance as JSON")
  .action(withErrorHandler(waitForBatch));

const runCommand = new Command("__run")
  .argument("<manifest.tsv>")
  .argument("<state-dir>")
  .addOption(createArtifactVisibilityOption())
  .action(withErrorHandler(runInternal));

export const imageBatchCommand = new Command("image-batch")
  .description(
    "Run image jobs with at most three concurrent requests and one transient retry",
  )
  .addCommand(startCommand)
  .addCommand(waitCommand)
  .addCommand(runCommand, { hidden: true })
  .addHelpText(
    "after",
    `\nManifest format:\n  asset-id<TAB>raw prompt[<TAB>size]\n  Size is optional per image and defaults to ${DEFAULT_SIZE}; the image API validates it.\n\nResult format:\n  asset-id<TAB>image URL or relative asset path\n  results.tsv retains the asset index; artifacts.json adds stable chat references and Markdown forms.\n  Use wait --json for the presentation metadata as one JSON object.\n  Private images are downloaded to <state-dir>/assets/ and optimized as WebP without resizing. Requires ffmpeg with libwebp on PATH. Resolve relative paths against <state-dir>, then copy assets into the authored bundle. Never embed preview signatures in HTML.\n\nExamples:\n  okou generate image-batch start images.tsv .image-batch\n  okou generate image-batch wait .image-batch`,
  );
