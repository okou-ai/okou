import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Command } from "commander";
import { z } from "zod";
import {
  introVideoRenderRequestSchema,
  type IntroVideoRenderRequest,
  type IntroVideoRenderResponse,
} from "@okouai/api-contracts/contracts/intro-video-render";
import {
  createWebIntroVideoRender,
  getWebIntroVideoRender,
  uploadWebFile,
} from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createArtifactPresentation } from "../shared/artifact-return";
import { packageRenderProject } from "./render-project";

interface RenderOptions {
  readonly composition?: string;
  readonly requestId?: string;
  readonly title?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}
const localStateSchema = z.object({
  requestId: z.uuid(),
  digest: z.string(),
  composition: z.string(),
  title: z.string().optional(),
  input: introVideoRenderRequestSchema.optional(),
});

function printRender(
  result: IntroVideoRenderResponse,
  json?: boolean,
  timings?: Record<string, number>,
): void {
  const presentation =
    result.status === "completed" && result.result
      ? createArtifactPresentation(result.result.filename, result.result.url)
      : undefined;
  const resumeCommand = `okou video render resume ${result.generationId} --json`;
  if (json) {
    console.log(
      JSON.stringify({
        ...result,
        ...(timings ? { timings } : {}),
        ...(result.status === "queued" || result.status === "running"
          ? { resumeCommand }
          : {}),
        ...presentation?.json,
      }),
    );
  } else {
    console.log(`Cloud render: ${result.status} (${result.phase})`);
    console.log(`Generation ID: ${result.generationId}`);
    if (result.notice) console.log(result.notice);
    if (result.error)
      console.error(`${result.error.code}: ${result.error.message}`);
    if (presentation) console.log(presentation.text);
    else if (result.status !== "failed")
      console.log(`Resume: ${resumeCommand}`);
    if (result.billing.creditsCharged !== null)
      console.log(`Credits charged: ${result.billing.creditsCharged}`);
  }
}

async function resumeRender(id: string): Promise<IntroVideoRenderResponse> {
  const existing = await getWebIntroVideoRender(z.uuid().parse(id));
  return existing.recovery.action === "replay_submission"
    ? await createWebIntroVideoRender(existing.input)
    : existing;
}

async function render(project: string, options: RenderOptions): Promise<void> {
  const root = resolve(project);
  const composition = options.composition ?? "index.html";
  const started = performance.now();
  const packed = await packageRenderProject(root, composition);
  const packMs = Math.round(performance.now() - started);
  if (options.dryRun) {
    const result = {
      dryRun: true,
      fileCount: packed.fileCount,
      sizeBytes: packed.bytes.length,
      sourceBytes: packed.sourceBytes,
      composition,
      aspectRatio: packed.aspectRatio,
      largestFiles: packed.largestFiles,
      packMs,
    };
    console.log(
      options.json
        ? JSON.stringify(result)
        : `Project ready: ${packed.fileCount} files, ${packed.bytes.length} bytes, ${packed.aspectRatio}. Nothing uploaded.`,
    );
    return;
  }
  const stateDir = join(root, ".okou");
  const statePath = join(stateDir, "cloud-render.json");
  const previous = existsSync(statePath)
    ? localStateSchema.parse(
        JSON.parse(readFileSync(statePath, "utf8")) as unknown,
      )
    : undefined;
  const requestId = options.requestId
    ? z.uuid().parse(options.requestId)
    : (previous?.requestId ?? randomUUID());
  const same = previous?.requestId === requestId;
  if (
    same &&
    (previous.digest !== packed.digest ||
      previous.composition !== composition ||
      previous.title !== options.title)
  ) {
    throw new Error(
      `Project input changed. Resume ${requestId} for its original input, or supply a new --request-id for an intentional new render.`,
    );
  }
  console.error(
    `Generation ID: ${requestId}. Keep this ID; use okou video render resume ${requestId} --json after an interruption.`,
  );
  if (same && previous.input) {
    printRender(await createWebIntroVideoRender(previous.input), options.json, {
      packMs,
    });
    return;
  }
  mkdirSync(stateDir, { recursive: true });
  const localState = {
    requestId,
    digest: packed.digest,
    composition,
    ...(options.title ? { title: options.title } : {}),
  };
  writeFileSync(statePath, JSON.stringify(localState), { mode: 0o600 });
  const dir = mkdtempSync(join(tmpdir(), "okou-cloud-render-"));
  try {
    const path = join(dir, "project.zip");
    writeFileSync(path, packed.bytes);
    const uploadStarted = performance.now();
    const file = await uploadWebFile(path, { contentType: "application/zip" });
    const uploadMs = Math.round(performance.now() - uploadStarted);
    const input: IntroVideoRenderRequest = {
      requestId,
      projectFileId: file.id,
      composition,
      output: {
        format: "mp4",
        resolution: "1080p",
        fps: 30,
        quality: "standard",
        aspectRatio: packed.aspectRatio,
      },
      ...(options.title ? { title: options.title } : {}),
    };
    writeFileSync(statePath, JSON.stringify({ ...localState, input }), {
      mode: 0o600,
    });
    printRender(await createWebIntroVideoRender(input), options.json, {
      packMs,
      uploadMs,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const renderCommand = new Command("render")
  .description(
    "Render an authored HyperFrames project through Okou's managed cloud",
  )
  .argument("[project]", "Project directory", ".")
  .option("--composition <path>", "HTML entry inside the archive")
  .option(
    "--request-id <uuid>",
    "Durable request ID; reuse it to recover the same submission",
  )
  .option("--title <title>", "Video title")
  .option(
    "--dry-run",
    "Package and inspect locally without uploading or spending render credits",
  )
  .option("--json", "Print structured output")
  .action(
    withErrorHandler(
      async (project: string, _options: unknown, command: Command) => {
        await render(project, command.opts<RenderOptions>());
      },
    ),
  )
  .addCommand(
    new Command("status")
      .argument("<generationId>")
      .option("--json")
      .action(
        withErrorHandler(
          async (id: string, _options: unknown, command: Command) => {
            printRender(
              await getWebIntroVideoRender(z.uuid().parse(id)),
              command.optsWithGlobals<RenderOptions>().json,
            );
          },
        ),
      ),
  )
  .addCommand(
    new Command("resume")
      .argument("<generationId>")
      .option("--json")
      .action(
        withErrorHandler(
          async (id: string, _options: unknown, command: Command) => {
            printRender(
              await resumeRender(id),
              command.optsWithGlobals<RenderOptions>().json,
            );
          },
        ),
      ),
  )
  .addHelpText(
    "after",
    "\nUses the platform HeyGen account and Intro Video access. Output is 1080p/30fps MP4. No personal HeyGen credentials are used. A timeout never authorizes a replacement render.",
  );
