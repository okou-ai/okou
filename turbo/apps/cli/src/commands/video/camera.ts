import { execFileSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Command } from "commander";
import { z } from "zod";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  cameraPlanSchema,
  createCameraPlan,
  createFfmpegCameraCommands,
  inputTrackClickTimes,
  inputTrackSchema,
  inputTrackVideoSource,
  REACTION_DELAY_MS,
  verifyPlanClicks,
} from "./camera-plan";
import type {
  CameraPlan,
  PixelRect,
  PlanClickVerification,
  SourceAnalysis,
  VideoSource,
} from "./camera-plan";
import {
  createCameraReviewCheckpoints,
  type CameraReviewCheckpoint,
} from "./camera-review";

const ffprobeSchema = z.object({
  streams: z
    .array(
      z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .min(1),
  format: z.object({ duration: z.string().optional() }),
});

interface CameraCommandOptions {
  readonly file: string;
  readonly events?: string;
  readonly plan?: string;
  readonly output: string;
  readonly planOutput?: string;
  readonly force?: boolean;
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * `ffprobe` genuinely omits `format.duration` for some containers, so the
 * duration falls back to the value the recording sidecar or plan declares.
 * Width and height always come from the probe, because a mismatch there means
 * the wrong file.
 *
 * The frame rate is never probed. A screen capture only stores a frame when
 * the picture changes, so for a recording with long still stretches `ffprobe`
 * reports an average of well under one frame per second. That number looks
 * valid, and rendering at it turned the cut into a slideshow and left the
 * camera motion with almost no frames to move on. The recording declares the
 * rate it was captured at, and that is the rate the cut plays back at.
 */
function probeVideo(path: string, declared: VideoSource): VideoSource {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const result = ffprobeSchema.parse(JSON.parse(raw) as unknown);
  const video = result.streams[0];
  if (!video) {
    throw new Error("Source file has no video stream");
  }
  const durationSeconds = Number(result.format.duration);
  return {
    durationMs:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds * 1_000)
        : declared.durationMs,
    width: video.width,
    height: video.height,
    frameRate: declared.frameRate,
  };
}

const REACTION_PROBE_WIDTH = 160;
const REACTION_PIXEL_DELTA = 40;

/**
 * Where the content sits in the frame. A window that was narrowed while it was
 * recorded leaves a black band the camera must never zoom into; ffmpeg's crop
 * detector finds the band from the first seconds of the video.
 */
function detectContentRect(
  inputPath: string,
  source: VideoSource,
): PixelRect | null {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-t",
      "5",
      "-i",
      inputPath,
      "-vf",
      "cropdetect=limit=24:round=2:reset=0,metadata=print:file=-",
      "-f",
      "null",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const values = new Map<string, number>();
  for (const line of raw.toString("utf8").split("\n")) {
    const match = /lavfi\.cropdetect\.(w|h|x|y)=(-?\d+)/u.exec(line);
    if (match?.[1] && match[2]) {
      values.set(match[1], Number(match[2]));
    }
  }
  const width = values.get("w");
  const height = values.get("h");
  const x = values.get("x");
  const y = values.get("y");
  if (
    width === undefined ||
    height === undefined ||
    x === undefined ||
    y === undefined ||
    width < source.width * 0.8 ||
    height < source.height * 0.8
  ) {
    return null;
  }
  return { x, y, width, height };
}

function probeFrame(inputPath: string, timeMs: number): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      (timeMs / 1_000).toFixed(3),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${String(REACTION_PROBE_WIDTH)}:-2,format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

/**
 * How much of the picture changed right after each click. A click that
 * closed a menu or navigated away leaves nothing to look at where it landed,
 * so the camera pulls back early instead of dwelling on the spot.
 */
function measureClickReactions(
  inputPath: string,
  clickTimes: readonly number[],
  source: VideoSource,
): ReadonlyMap<number, number> {
  const reactions = new Map<number, number>();
  for (const clickMs of clickTimes) {
    if (clickMs + REACTION_DELAY_MS > source.durationMs) {
      continue;
    }
    const before = probeFrame(inputPath, clickMs);
    const after = probeFrame(inputPath, clickMs + REACTION_DELAY_MS);
    const length = Math.min(before.length, after.length);
    if (length === 0) {
      continue;
    }
    let changed = 0;
    for (let index = 0; index < length; index += 1) {
      const left = before[index] ?? 0;
      const right = after[index] ?? 0;
      if (Math.abs(left - right) > REACTION_PIXEL_DELTA) {
        changed += 1;
      }
    }
    reactions.set(clickMs, changed / length);
  }
  return reactions;
}

function analyzeSource(
  inputPath: string,
  clickTimes: readonly number[],
  source: VideoSource,
): SourceAnalysis {
  return {
    contentRect: detectContentRect(inputPath, source),
    reactions: measureClickReactions(inputPath, clickTimes, source),
  };
}

function defaultPlanPath(outputPath: string): string {
  const output = parse(outputPath);
  return join(output.dir, `${output.name}.camera-plan.json`);
}

function defaultReviewPath(outputPath: string): string {
  const output = parse(outputPath);
  return join(output.dir, `${output.name}.camera-review.json`);
}

function reviewFramesDirectory(reviewPath: string): string {
  const review = parse(reviewPath);
  return join(review.dir, review.name);
}

function assertPlanMatchesVideo(plan: CameraPlan, source: VideoSource): void {
  if (
    plan.source.width !== source.width ||
    plan.source.height !== source.height
  ) {
    throw new Error("Camera plan does not match the source video dimensions");
  }
  if (Math.abs(plan.source.durationMs - source.durationMs) > 1_000) {
    throw new Error("Camera plan does not match the source video duration");
  }
}

function assertWritableOutput(path: string, force: boolean): void {
  if (!force && existsSync(path)) {
    throw new Error(
      `Output already exists: ${path}. Pass --force to replace it`,
    );
  }
}

function renderVideo(
  inputPath: string,
  outputPath: string,
  plan: CameraPlan,
  force: boolean,
): void {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "okou-camera-"));
  try {
    const commandsPath = join(temporaryDirectory, "camera.commands");
    writeFileSync(commandsPath, createFfmpegCameraCommands(plan));
    // The `null` stage between the crop and the scaler is load-bearing. When
    // a command changes the crop's w or h, `crop` rewrites the size of its
    // own output link, and `scale` decides whether to reconfigure by comparing
    // each frame with the link it reads from. Wired directly, that link is the
    // one `crop` just rewrote, so `scale` never sees a change; and because the
    // first frames are full size it never built a scaler at all, so it hands
    // the shrunken frames straight to the encoder, which was opened for the
    // full size, reads past the end of their buffer and dies with SIGSEGV.
    // `null` keeps its own link size, so `scale` sees every size change and
    // rescales the frame. Reproduced on ffmpeg 6.1 and 7.0 (#31169).
    const filter = [
      `fps=${plan.source.frameRate.toString()}`,
      `sendcmd=f='${commandsPath}'`,
      `crop@camera=w=${plan.source.width.toString()}:h=${plan.source.height.toString()}:x=0:y=0:exact=1`,
      "null",
      `scale=${plan.source.width.toString()}:${plan.source.height.toString()}:flags=lanczos`,
      "setsar=1",
    ].join(",");
    execFileSync(
      "ffmpeg",
      [
        force ? "-y" : "-n",
        "-v",
        "error",
        "-i",
        inputPath,
        "-vf",
        filter,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

interface ReviewFrameRequest {
  readonly frameIndex: number;
  readonly outputPath: string;
}

/**
 * The frame the checkpoint is showing, placed on the render's own frame grid
 * and clamped to the last frame.
 *
 * A screen capture only stores a frame when the picture changes, so seeking to
 * the checkpoint time returned the next stored frame instead. On a measured
 * recording that frame sat up to 340 ms in the future, which paired a source
 * frame with an output frame rendered from a different moment.
 */
function reviewFrameIndex(
  timeMs: number,
  frameRate: number,
  durationMs: number,
): number {
  const lastFrameIndex = Math.max(
    0,
    Math.floor((durationMs / 1_000) * frameRate) - 1,
  );
  return Math.min(
    Math.max(0, Math.ceil((timeMs / 1_000) * frameRate)),
    lastFrameIndex,
  );
}

/**
 * Extracts every checkpoint frame of one video in a single decode pass.
 * Seeking per checkpoint reopened and re-decoded the file once per frame,
 * which cost more than rendering the video itself.
 *
 * `fps` normalizes a variable-rate capture onto the render's own frame grid,
 * so `select` addresses frames by the same index the plan uses, and
 * `-frame_pts` names each file after that index rather than after its
 * position in the output sequence.
 */
function extractReviewFrames(
  videoPath: string,
  frameRate: number,
  requests: readonly ReviewFrameRequest[],
): void {
  if (requests.length === 0) {
    return;
  }
  const frameIndexes = [
    ...new Set(
      requests.map((request) => {
        return request.frameIndex;
      }),
    ),
  ].sort((left, right) => {
    return left - right;
  });
  const selectExpression = frameIndexes
    .map((frameIndex) => {
      return `eq(n\\,${frameIndex.toString()})`;
    })
    .join("+");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "okou-camera-review-"));
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-i",
        videoPath,
        "-vf",
        `fps=${frameRate.toString()},select='${selectExpression}'`,
        "-fps_mode",
        "passthrough",
        "-frame_pts",
        "1",
        "-q:v",
        "2",
        join(temporaryDirectory, "%d.jpg"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    for (const request of requests) {
      copyFileSync(
        join(temporaryDirectory, `${request.frameIndex.toString()}.jpg`),
        request.outputPath,
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function writeCameraReview(args: {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly planPath: string;
  readonly reviewPath: string;
  readonly frameRate: number;
  readonly durationMs: number;
  readonly checkpoints: readonly CameraReviewCheckpoint[];
  readonly clicks: readonly PlanClickVerification[];
}): void {
  const framesDirectory = reviewFramesDirectory(args.reviewPath);
  mkdirSync(framesDirectory, { recursive: true });
  const frames = args.checkpoints.map((checkpoint) => {
    return {
      checkpoint,
      frameIndex: reviewFrameIndex(
        checkpoint.timeMs,
        args.frameRate,
        args.durationMs,
      ),
      sourceFramePath: join(framesDirectory, `${checkpoint.id}-source.jpg`),
      outputFramePath: join(framesDirectory, `${checkpoint.id}-output.jpg`),
    };
  });
  extractReviewFrames(
    args.sourcePath,
    args.frameRate,
    frames.map((frame) => {
      return {
        frameIndex: frame.frameIndex,
        outputPath: frame.sourceFramePath,
      };
    }),
  );
  extractReviewFrames(
    args.outputPath,
    args.frameRate,
    frames.map((frame) => {
      return {
        frameIndex: frame.frameIndex,
        outputPath: frame.outputFramePath,
      };
    }),
  );
  const checkpoints = frames.map((frame) => {
    return {
      ...frame.checkpoint,
      sourceFramePath: frame.sourceFramePath,
      outputFramePath: frame.outputFramePath,
    };
  });
  writeFileSync(
    args.reviewPath,
    `${JSON.stringify(
      {
        version: 1,
        sourcePath: args.sourcePath,
        outputPath: args.outputPath,
        planPath: args.planPath,
        clicks: args.clicks,
        clicksOutsideFrame: args.clicks.filter((click) => {
          return !click.inFrame;
        }).length,
        checkpoints,
      },
      null,
      2,
    )}\n`,
  );
}

export const cameraCommand = new Command()
  .name("camera")
  .description(
    "Apply automatic click-driven camera moves to a screen recording",
  )
  .requiredOption("--file <path>", "Local source video")
  .option("--events <path>", "Recording event sidecar to generate a plan")
  .option("--plan <path>", "Existing camera plan to render")
  .requiredOption("--output <path>", "Rendered MP4 path")
  .option(
    "--plan-output <path>",
    "Generated plan path (defaults beside the rendered video)",
  )
  .option("--force", "Replace existing output files")
  .addHelpText(
    "after",
    `
Examples:
  Automatic first cut:
    okou video camera --file recording.mp4 --events recording.clicks.json --output draft.mp4

  Render an AI-edited plan:
    okou video camera --file recording.mp4 --plan draft.camera-plan.json --output final.mp4 --force

Output:
  Writes the rendered MP4, editable plan, and a review manifest with paired source/output checkpoint frames.
  Prints their paths and render metadata as JSON.

Notes:
  - Exactly one of --events or --plan is required
  - The generated camera plan is editable JSON: each shot lists timed moves (keys) with the viewport they land on; edit and render again
  - Requires ffmpeg and ffprobe on PATH`,
  )
  .action(
    withErrorHandler(async (options: CameraCommandOptions) => {
      if (Boolean(options.events) === Boolean(options.plan)) {
        throw new Error(
          "Provide exactly one of --events <path> or --plan <path>",
        );
      }
      if (options.plan && options.planOutput) {
        throw new Error("--plan-output can only be used with --events");
      }

      const inputPath = resolve(options.file);
      const outputPath = resolve(options.output);
      const force = options.force === true;
      if (!existsSync(inputPath)) {
        throw new Error(`Source video does not exist: ${inputPath}`);
      }
      if (inputPath === outputPath) {
        throw new Error(
          "Source video and output video must use different paths",
        );
      }
      assertWritableOutput(outputPath, force);
      mkdirSync(dirname(outputPath), { recursive: true });

      let plan: CameraPlan;
      let planPath: string;
      let clickTimes: readonly number[] = [];
      let eventsPath: string | null = null;
      let generatedPlan = false;
      if (options.events) {
        eventsPath = resolve(options.events);
        if (eventsPath === outputPath) {
          throw new Error(
            "Rendered video must not overwrite the event sidecar",
          );
        }
        const track = inputTrackSchema.parse(parseJsonFile(eventsPath));
        clickTimes = inputTrackClickTimes(track);
        const source = probeVideo(inputPath, inputTrackVideoSource(track));
        plan = createCameraPlan(
          track,
          source,
          analyzeSource(inputPath, clickTimes, source),
        );
        planPath = resolve(options.planOutput ?? defaultPlanPath(outputPath));
        if (
          planPath === eventsPath ||
          planPath === inputPath ||
          planPath === outputPath
        ) {
          throw new Error(
            "Generated plan must use a path distinct from all input and output files",
          );
        }
        assertWritableOutput(planPath, force);
        generatedPlan = true;
      } else {
        planPath = resolve(options.plan as string);
        if (planPath === outputPath) {
          throw new Error("Rendered video must not overwrite the camera plan");
        }
        plan = cameraPlanSchema.parse(parseJsonFile(planPath));
        const source = probeVideo(inputPath, plan.source);
        assertPlanMatchesVideo(plan, source);
      }

      const reviewPath = defaultReviewPath(outputPath);
      if (
        reviewPath === inputPath ||
        reviewPath === outputPath ||
        reviewPath === planPath ||
        reviewPath === eventsPath
      ) {
        throw new Error(
          "Camera review must use a path distinct from all inputs and outputs",
        );
      }
      assertWritableOutput(reviewPath, force);
      const checkpoints = createCameraReviewCheckpoints(plan);
      const clickChecks = verifyPlanClicks(plan);
      const reviewDirectory = reviewFramesDirectory(reviewPath);
      for (const checkpoint of checkpoints) {
        assertWritableOutput(
          join(reviewDirectory, `${checkpoint.id}-source.jpg`),
          force,
        );
        assertWritableOutput(
          join(reviewDirectory, `${checkpoint.id}-output.jpg`),
          force,
        );
      }
      if (generatedPlan) {
        mkdirSync(dirname(planPath), { recursive: true });
        writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      }

      const renderStartedAt = performance.now();
      renderVideo(inputPath, outputPath, plan, force);
      writeCameraReview({
        sourcePath: inputPath,
        outputPath,
        planPath,
        reviewPath,
        frameRate: plan.source.frameRate,
        durationMs: plan.source.durationMs,
        checkpoints,
        clicks: clickChecks,
      });
      const renderMs = Math.round(performance.now() - renderStartedAt);
      process.stdout.write(
        `${JSON.stringify({
          outputPath,
          planPath,
          reviewPath,
          reviewFrames: checkpoints.length,
          clicksOutsideFrame: clickChecks.filter((click) => {
            return !click.inFrame;
          }).length,
          durationMs: plan.source.durationMs,
          width: plan.source.width,
          height: plan.source.height,
          frameRate: plan.source.frameRate,
          cameraShots: plan.shots.length,
          cameraMoves: plan.shots.reduce((count, shot) => {
            return count + shot.keys.length;
          }, 0),
          sizeBytes: statSync(outputPath).size,
          renderMs,
        })}\n`,
      );
    }),
  );
