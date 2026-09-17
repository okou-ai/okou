/**
 * Integration tests for the click-driven camera command.
 *
 * Only ffmpeg and ffprobe are mocked. The command parses real sidecars, writes
 * real camera plans and command files, and exercises Commander end to end.
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraCommand } from "../camera";

/** What the fake ffprobe says about the video stream, adjustable per test. */
const probedStream = vi.hoisted(() => {
  return { avg_frame_rate: "30/1", r_frame_rate: "30/1" };
});

vi.mock("child_process", async () => {
  const { readFileSync, writeFileSync } =
    await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    execFileSync: vi.fn((command: string, args: readonly string[]) => {
      if (command === "ffprobe") {
        return JSON.stringify({
          streams: [{ width: 1920, height: 1080, ...probedStream }],
          format: { duration: "10.000000" },
        });
      }
      if (command === "ffmpeg") {
        const filterIndex = args.indexOf("-vf");
        const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined;
        const commandsPath = filter?.match(/sendcmd=f='([^']+)'/)?.[1];
        const outputPath = args.at(-1);
        if (commandsPath && outputPath) {
          writeFileSync(outputPath, readFileSync(commandsPath));
        }
        // the review pass writes one file per selected frame, named after the
        // frame index rather than its position in the output sequence
        if (args.includes("-frame_pts") && outputPath && filter) {
          for (const match of filter.matchAll(/eq\(n\\,(\d+)\)/gu)) {
            const frameIndex = match[1];
            if (frameIndex !== undefined) {
              writeFileSync(
                outputPath.replace("%d", frameIndex),
                Buffer.from(`frame-${frameIndex}`),
              );
            }
          }
        }
      }
      return Buffer.from("");
    }),
  };
});

const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => {
  return true;
});

function stdout(): string {
  return stdoutWrite.mock.calls
    .map((call) => {
      return call[0];
    })
    .join("");
}

describe("okou video camera command", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-video-camera-test-"));
    stdoutWrite.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    probedStream.avg_frame_rate = "30/1";
    probedStream.r_frame_rate = "30/1";
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates a camera plan and renders an automatic first cut", async () => {
    const videoPath = join(directory, "recording.mp4");
    const eventsPath = join(directory, "recording.clicks.json");
    const outputPath = join(directory, "draft.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      eventsPath,
      JSON.stringify({
        version: 1,
        recording: {
          durationMs: 10_000,
          video: { width: 1920, height: 1080, frameRate: 30 },
        },
        clicks: [
          { tMs: 2_000, normalized: { x: 0.12, y: 0.22 } },
          { tMs: 4_500, normalized: { x: 0.82, y: 0.8 } },
        ],
        pointerEvents: [
          { tMs: 1_700, kind: "move", normalized: { x: 0.1, y: 0.2 } },
          { tMs: 2_000, kind: "click", normalized: { x: 0.12, y: 0.22 } },
          { tMs: 2_300, kind: "move", normalized: { x: 0.15, y: 0.25 } },
          { tMs: 3_000, kind: "move", normalized: { x: 0.8, y: 0.8 } },
          { tMs: 4_500, kind: "click", normalized: { x: 0.82, y: 0.8 } },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--events", eventsPath, "--output", outputPath],
      { from: "user" },
    );

    const result = JSON.parse(stdout()) as {
      outputPath: string;
      planPath: string;
      reviewPath: string;
      reviewFrames: number;
      cameraShots: number;
      cameraMoves: number;
      clicksOutsideFrame: number;
    };
    expect(result).toMatchObject({
      outputPath,
      cameraShots: 1,
      clicksOutsideFrame: 0,
    });
    expect(result.cameraMoves).toBeGreaterThanOrEqual(2);
    const plan = JSON.parse(readFileSync(result.planPath, "utf8")) as {
      algorithm: string;
      content: { x: number; y: number; width: number; height: number };
      shots: {
        startMs: number;
        endMs: number;
        baseZoom: number;
        keys: { startMs: number; durationMs: number; clickMs?: number }[];
      }[];
    };
    expect(plan.algorithm).toBe("click-camera-v2");
    // no letterbox detected through the mocked ffmpeg: the whole frame is content
    expect(plan.content).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(plan.shots).toHaveLength(1);
    const shot = plan.shots[0];
    // the pointer settled on the first click's spot 300 ms early, so the
    // zoom-in lands 150 ms after that instead of on the click: it starts at
    // 1700 + 150 - 800; the shot holds 2.2 s past the last click
    expect(shot?.startMs).toBe(1_050);
    expect(shot?.endMs).toBe(4_500 + 2_200);
    expect(shot?.keys[0]).toMatchObject({ durationMs: 800, clickMs: 2_000 });
    expect(
      shot?.keys.some((key) => {
        return key.clickMs === 4_500;
      }),
    ).toBe(true);
    const review = JSON.parse(readFileSync(result.reviewPath, "utf8")) as {
      clicks: { tMs: number; inFrame: boolean }[];
      clicksOutsideFrame: number;
      checkpoints: {
        timeMs: number;
        reasons: { kind: string; offsetMs?: number }[];
        sourceFramePath: string;
        outputFramePath: string;
      }[];
    };
    expect(review.checkpoints).toHaveLength(result.reviewFrames);
    expect(review.clicksOutsideFrame).toBe(0);
    expect(review.clicks).toEqual([
      { tMs: 2_000, inFrame: true },
      { tMs: 4_500, inFrame: true },
    ]);
    expect(
      review.checkpoints.flatMap((checkpoint) => {
        return checkpoint.reasons;
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "click-before" }),
        expect.objectContaining({ kind: "click", inFrame: true }),
        expect.objectContaining({ kind: "click-after", offsetMs: 400 }),
        expect.objectContaining({ kind: "move-start" }),
        expect.objectContaining({ kind: "move-end" }),
        expect.objectContaining({ kind: "shot-end" }),
        expect.objectContaining({ kind: "maximum-camera-speed" }),
      ]),
    );
    expect(review.checkpoints[0]).toEqual(
      expect.objectContaining({
        sourceFramePath: expect.stringMatching(/-source\.jpg$/u),
        outputFramePath: expect.stringMatching(/-output\.jpg$/u),
      }),
    );
    for (const checkpoint of review.checkpoints) {
      expect(existsSync(checkpoint.sourceFramePath)).toBe(true);
      expect(existsSync(checkpoint.outputFramePath)).toBe(true);
    }
    // Checkpoint frames cost one decode pass per video, not one seek per
    // frame: extracting them used to take longer than rendering the cut.
    const frameCalls = vi.mocked(execFileSync).mock.calls.filter((call) => {
      return call[0] === "ffmpeg" && call[1]?.includes("-frame_pts");
    });
    expect(frameCalls).toHaveLength(2);
    expect(review.checkpoints.length).toBeGreaterThan(frameCalls.length);
    for (const call of frameCalls) {
      // a variable-rate capture is resampled onto the render's frame grid so
      // that both videos are addressed by the same frame index
      expect(call[1]).toEqual(
        expect.arrayContaining([
          "-vf",
          expect.stringContaining("fps=30,select="),
        ]),
      );
    }

    const generatedCommands = readFileSync(outputPath, "utf8");
    // the wide shot before the first click, and the 2.2x focus on the click
    expect(generatedCommands).toContain("crop@camera w 1920.000000");
    // 1920 / 2.2, as the plan stores it (three decimals)
    expect(generatedCommands).toContain("crop@camera w 872.727000");
    const ffmpegCall = vi.mocked(execFileSync).mock.calls.find((call) => {
      return call[0] === "ffmpeg" && call[1]?.includes("libx264");
    });
    expect(ffmpegCall?.[1]).toEqual(
      expect.arrayContaining([
        "-vf",
        expect.stringContaining("sendcmd="),
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
      ]),
    );
  });

  it("renders at the frame rate the recording declares, not the probed average", async () => {
    // A screen capture only stores a frame when the picture changes, so
    // ffprobe averages a mostly still recording to well under one frame per
    // second. That figure is valid as far as ffprobe is concerned, and it
    // used to become the output frame rate.
    probedStream.avg_frame_rate = "150/241";
    probedStream.r_frame_rate = "1/2";
    const videoPath = join(directory, "recording.mp4");
    const eventsPath = join(directory, "recording.clicks.json");
    const outputPath = join(directory, "draft.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      eventsPath,
      JSON.stringify({
        version: 1,
        recording: {
          durationMs: 10_000,
          video: { width: 1920, height: 1080, frameRate: 30 },
        },
        clicks: [{ tMs: 2_000, normalized: { x: 0.12, y: 0.22 } }],
        pointerEvents: [
          { tMs: 1_700, kind: "move", normalized: { x: 0.1, y: 0.2 } },
          { tMs: 2_000, kind: "click", normalized: { x: 0.12, y: 0.22 } },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--events", eventsPath, "--output", outputPath],
      { from: "user" },
    );

    const result = JSON.parse(stdout()) as {
      planPath: string;
      frameRate: number;
    };
    expect(result.frameRate).toBe(30);
    const plan = JSON.parse(readFileSync(result.planPath, "utf8")) as {
      source: { frameRate: number };
    };
    expect(plan.source.frameRate).toBe(30);
    const ffmpegCall = vi.mocked(execFileSync).mock.calls.find((call) => {
      return call[0] === "ffmpeg" && call[1]?.includes("libx264");
    });
    expect(ffmpegCall?.[1]).toEqual(
      expect.arrayContaining(["-vf", expect.stringMatching(/^fps=30,/u)]),
    );
  });

  it("keeps a pass-through stage between the moving crop and the scaler", async () => {
    // Wired straight into `scale`, a crop whose size changes mid-stream never
    // gets rescaled and the encoder segfaults on the first zoomed frame; the
    // `null` stage in between is what makes `scale` notice the change.
    const videoPath = join(directory, "recording.mp4");
    const eventsPath = join(directory, "recording.clicks.json");
    const outputPath = join(directory, "draft.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      eventsPath,
      JSON.stringify({
        version: 1,
        recording: {
          durationMs: 10_000,
          video: { width: 1920, height: 1080, frameRate: 30 },
        },
        clicks: [{ tMs: 2_000, normalized: { x: 0.12, y: 0.22 } }],
        pointerEvents: [
          { tMs: 2_000, kind: "click", normalized: { x: 0.12, y: 0.22 } },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--events", eventsPath, "--output", outputPath],
      { from: "user" },
    );

    const ffmpegCall = vi.mocked(execFileSync).mock.calls.find((call) => {
      return call[0] === "ffmpeg" && call[1]?.includes("libx264");
    });
    const filterIndex = ffmpegCall?.[1]?.indexOf("-vf") ?? -1;
    const filter = ffmpegCall?.[1]?.[filterIndex + 1];
    expect(filter).toMatch(/crop@camera=[^,]*,null,scale=1920:1080:/u);
  });

  it("uses the existing demo capture event format", async () => {
    const videoPath = join(directory, "browser-recording.webm");
    const eventsPath = join(directory, "browser-recording.events.json");
    const outputPath = join(directory, "browser-draft.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      eventsPath,
      JSON.stringify({
        schemaVersion: 1,
        generator: { name: "Okou Demo Capture", version: "0.3.0" },
        session: {
          durationMs: 10_000,
          recording: {
            durationMs: 10_000,
            goOffsetMs: 500,
            width: 1920,
            height: 1080,
            frameRate: 30,
          },
        },
        events: [
          { type: "session-start", t: 0 },
          { type: "pointermove", t: 1_700, nx: 0.1, ny: 0.2 },
          { type: "pointerdown", t: 2_000, nx: 0.12, ny: 0.22 },
          { type: "click", t: 2_100, nx: 0, ny: 0 },
          { type: "pointermove", t: 3_000, nx: 0.8, ny: 0.8 },
          { type: "pointerdown", t: 5_000, nx: 0.82, ny: 0.8 },
          { type: "session-stop", t: 10_500 },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--events", eventsPath, "--output", outputPath],
      { from: "user" },
    );

    const result = JSON.parse(stdout()) as {
      planPath: string;
      cameraShots: number;
    };
    expect(result.cameraShots).toBe(1);
    const plan = JSON.parse(readFileSync(result.planPath, "utf8")) as {
      shots: {
        startMs: number;
        endMs: number;
        keys: { clickMs?: number; rect: { width: number } }[];
      }[];
    };
    // pointerdown at 2000 and 5000 ms (after the 500 ms go offset: 1500 and 4500)
    expect(plan.shots).toEqual([
      expect.objectContaining({
        endMs: 4_500 + 2_200,
        keys: expect.arrayContaining([
          expect.objectContaining({ clickMs: 1_500 }),
          expect.objectContaining({ clickMs: 4_500 }),
        ]),
      }),
    ]);
    expect(plan.shots[0]?.startMs).toBeLessThan(1_500);
  });

  it("renders an AI-edited camera plan without regenerating it", async () => {
    const videoPath = join(directory, "recording.mp4");
    const planPath = join(directory, "edited.camera-plan.json");
    const outputPath = join(directory, "final.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      planPath,
      JSON.stringify({
        version: 2,
        algorithm: "click-camera-v2",
        source: {
          durationMs: 10_000,
          width: 1920,
          height: 1080,
          frameRate: 30,
        },
        content: { x: 0, y: 0, width: 1920, height: 1080 },
        shots: [
          {
            id: "shot-001",
            startMs: 1_000,
            endMs: 4_000,
            baseZoom: 1.5,
            keys: [
              {
                id: "shot-001-key-001",
                startMs: 1_000,
                durationMs: 800,
                rect: { x: 320, y: 180, width: 1280 },
                reason: "zoom in on click at 1800 ms",
                clickMs: 1_800,
              },
            ],
          },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--plan", planPath, "--output", outputPath],
      { from: "user" },
    );

    const result = JSON.parse(stdout()) as { planPath: string };
    expect(result.planPath).toBe(planPath);
    expect(readFileSync(outputPath, "utf8")).toContain(
      "crop@camera w 1280.000000",
    );
    const unchangedPlan = JSON.parse(readFileSync(planPath, "utf8")) as {
      shots: { baseZoom: number }[];
    };
    expect(unchangedPlan.shots[0]?.baseZoom).toBe(1.5);
  });
});
