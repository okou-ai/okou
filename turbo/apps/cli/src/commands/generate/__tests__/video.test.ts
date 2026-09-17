import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
/**
 * Tests for okou generate video command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend video route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";
import { videoCommand } from "../video";
import {
  GENERATION_ARTIFACT_ID,
  serveGenerationVisibility,
} from "./artifact-visibility-fixtures";

const VIDEO_URL = "http://localhost:3000/api/video-io/generate";
const FIRST_FRAME_URL = "https://example.com/first.png";
const VIDEO_RESULT = {
  id: "video-file-id",
  filename: "video-video-fi.mp4",
  contentType: "video/mp4",
  size: 19,
  url: "http://localhost:3000/f/user-1/video-file-id/video-video-fi.mp4",
  durationSeconds: 6,
  creditsCharged: 720,
  model: "dreamina-seedance-2-0-fast-260128",
  aspectRatio: "9:16",
  duration: "6s",
  resolution: "1080p",
  generateAudio: false,
  sourceUrl: "https://ark-content.byteplus.example/files/video-output.mp4",
  requestId: "video-request",
};

function buildRunToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user-video",
      runId: "run-video",
      orgId: "org-video",
      scope: "okou",
      capabilities: ["file:write", "billing:read"],
      iat: 1000,
      exp: 2000,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function pngWithDimensions(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function imageResponse(width: number, height: number) {
  return new HttpResponse(pngWithDimensions(width, height), {
    headers: { "content-type": "image/png" },
  });
}

function stubBillingStatus(
  videoGenerationAllowed: boolean,
  tier = videoGenerationAllowed ? "pro" : "limited-free-1",
) {
  return http.get("http://localhost:3000/api/billing/status", () => {
    return HttpResponse.json({
      showUsagePack: false,
      tier,
      canBuyCredits: videoGenerationAllowed,
      videoGenerationAllowed,
      credits: 0,
      onboardingPaymentPending: false,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription:
        tier !== "free" && tier !== "limited-free-1" && tier !== "pro-suspend",
      autoRecharge: {
        enabled: false,
        threshold: null,
        amount: null,
      },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    });
  });
}

describe("okou generate video command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    videoCommand.setOptionValue("visibility", undefined);
    server.use(stubBillingStatus(true));
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should omit the model so the server picks the run's video model", async () => {
    // A client-side default made every request look like an explicit seedance
    // request, so a run pinned to another model produced a result the caller
    // never asked for. Runs first so no earlier parse leaves option state.
    let payload: unknown = null;
    server.use(
      http.post(VIDEO_URL, async ({ request }) => {
        payload = await request.json();
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "video",
      "--prompt",
      "A neon market tracking shot",
    ]);

    expect(payload).toEqual({
      prompt: "A neon market tracking shot",
      aspectRatio: "16:9",
      duration: "8s",
      generateAudio: true,
      autoFix: true,
      safetyTolerance: "4",
    });
  });

  it("publishes a generated video using the selected public URL", async () => {
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    const artifact = serveGenerationVisibility("video.mp4", "public");
    server.use(
      http.post(`${VIDEO_URL}/private`, async ({ request }) => {
        expect(await request.json()).toMatchObject({
          requirePrivateArtifact: true,
        });
        return HttpResponse.json({
          ...VIDEO_RESULT,
          id: GENERATION_ARTIFACT_ID,
          url: artifact.reference,
        });
      }),
    );
    await generateCommand.parseAsync([
      "node",
      "cli",
      "video",
      "--prompt",
      "A city panorama",
      "--visibility",
      "public",
      "--json",
    ]);
    expect(
      JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
    ).toMatchObject({
      url: artifact.url,
      ownerUrl: artifact.ownerUrl,
      visibility: "public",
      previewMarkdownBlock: `![${VIDEO_RESULT.filename}](<${artifact.url}>)`,
    });
  });

  it("carries template visibility only to the final built-in video command", async () => {
    serveGenerationVisibility("video.mp4", "public");
    await generateCommand.parseAsync([
      "node",
      "cli",
      "video",
      "--template",
      "video-template:epic-grandeur",
      "--prompt",
      "A city panorama",
      "--visibility",
      "public",
    ]);
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Pass --visibility public to the final built-in okou generate video command",
    );
    expect(stdout).toContain("keep intermediate assets private");
  });

  it("should send an explicit model inside an agent run", async () => {
    // The run's model is a default, so an explicit `--model` is the only way a
    // user who names a model in the prompt can get it. Dropping it here left
    // the agent unable to honour that request at all.
    vi.stubEnv("OKOU_TOKEN", buildRunToken());
    let payload: unknown = null;
    server.use(
      http.post(VIDEO_URL, async ({ request }) => {
        payload = await request.json();
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "video",
      "--prompt",
      "A neon market tracking shot",
      "--model",
      "kling-v3-4k",
    ]);

    expect(payload).toMatchObject({
      prompt: "A neon market tracking shot",
      model: "kling-v3-4k",
    });
  });

  it("should generate a video and print the /f file URL", async () => {
    server.use(
      stubBillingStatus(true),
      http.post(VIDEO_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          prompt: "A neon market tracking shot",
          model: "dreamina-seedance-2.0",
          aspectRatio: "9:16",
          duration: "6s",
          resolution: "1080p",
          generateAudio: false,
          seed: 123,
          autoFix: false,
          safetyTolerance: "5",
          imageUrls: ["https://example.com/reference.png"],
          videoUrls: ["https://example.com/reference.mp4"],
          audioUrls: ["https://example.com/reference.mp3"],
        });

        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "video",
      "--prompt",
      "A neon market tracking shot",
      "--model",
      "dreamina-seedance-2.0",
      "--aspect-ratio",
      "9:16",
      "--duration",
      "6s",
      "--resolution",
      "1080p",
      "--no-audio",
      "--seed",
      "123",
      "--no-auto-fix",
      "--safety-tolerance",
      "5",
      "--image-url",
      "https://example.com/reference.png",
      "--video-url",
      "https://example.com/reference.mp4",
      "--audio-url",
      "https://example.com/reference.mp3",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Video generated: ${VIDEO_RESULT.url}`);
    expect(stdout).toContain(`File: ${VIDEO_RESULT.filename}`);
    expect(stdout).toContain(
      `[${VIDEO_RESULT.filename}](<${VIDEO_RESULT.url}>)`,
    );
    expect(stdout).toContain(
      `\n\n![${VIDEO_RESULT.filename}](<${VIDEO_RESULT.url}>)\n\n`,
    );
    expect(stdout).toContain("creates two user-facing references");
    expect(stdout).toContain("Duration: 6s");
    expect(stdout).toContain("Resolution: 1080p");
    expect(stdout).toContain("Aspect ratio: 9:16");
    expect(stdout).toContain("Audio: off");
    expect(stdout).toContain("Credits charged: 720");
  });

  it("should print the complete video result as one JSON object", async () => {
    server.use(
      http.post(VIDEO_URL, () => {
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "video",
      "--prompt",
      "A neon market tracking shot",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual({
      ...VIDEO_RESULT,
      inlineMarkdownLink: `[${VIDEO_RESULT.filename}](<${VIDEO_RESULT.url}>)`,
      previewMarkdownBlock: `![${VIDEO_RESULT.filename}](<${VIDEO_RESULT.url}>)`,
      artifactPresentationContext: expect.stringContaining(
        "outside code fences",
      ),
    });
  });

  it.each([
    ["provider listing", ["video", "--json"]],
    ["connector guidance", ["video", "--provider", "heygen", "--json"]],
    [
      "template selection",
      [
        "video",
        "--template",
        "video-template:epic-grandeur",
        "--prompt",
        "A cinematic mountain reveal",
        "--json",
      ],
    ],
  ])("should reject JSON output for %s", async (_mode, args) => {
    await expect(async () => {
      await generateCommand.parseAsync(["node", "cli", ...args]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--json is only available for direct built-in generation",
      ),
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it.each([
    { ownedApi: true, absolute: false },
    { ownedApi: true, absolute: true },
    { ownedApi: false, absolute: false },
  ])(
    "validates frame dimensions without leaking credentials (owned=$ownedApi, absolute=$absolute)",
    async ({ ownedApi, absolute }) => {
      vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
      const origin = ownedApi
        ? "http://localhost:3000"
        : "https://foreign.example";
      const frame = ownedApi
        ? `${absolute ? "https://app.okou.ai" : ""}${artifactReferencePath(
            "00000000-0000-4000-8000-000000000021",
            "frame.png",
          )}`
        : `${origin}/api/web/download-file?file_id=private-frame&filename=frame.png`;
      let authorization: string | null = null;
      let videoInput: unknown;
      server.use(
        http.get(`${origin}/api/web/download-file`, ({ request }) => {
          authorization = request.headers.get("authorization");
          return imageResponse(1080, 1920);
        }),
        http.post(VIDEO_URL, async ({ request }) => {
          videoInput = await request.json();
          const { sourceUrl: _sourceUrl, ...result } = VIDEO_RESULT;
          return HttpResponse.json({
            ...result,
            url: artifactReferencePath(
              "00000000-0000-4000-8000-000000000022",
              "video.mp4",
            ),
          });
        }),
      );
      await generateCommand.parseAsync([
        "node",
        "cli",
        "video",
        "--prompt",
        "Animate this private frame",
        "--aspect-ratio",
        "9:16",
        "--first-frame-image-url",
        frame,
        "--json",
      ]);
      expect(authorization).toBe(ownedApi ? "Bearer test-token" : null);
      expect(videoInput).toMatchObject({ firstFrameImageUrl: frame });
      const output = mockConsoleLog.mock.calls
        .map(([value]) => {
          return String(value);
        })
        .join("\n");
      expect(output).toContain(
        `https://app.okou.ai${artifactReferencePath(
          "00000000-0000-4000-8000-000000000022",
          "video.mp4",
        )}`,
      );
      expect(output).not.toContain(VIDEO_RESULT.sourceUrl);
      expect(output).not.toContain("test-token");
    },
  );

  it("should reject frame images that do not match --aspect-ratio before generating", async () => {
    const postVideo = vi.fn();
    server.use(
      http.get(FIRST_FRAME_URL, () => {
        return imageResponse(1920, 1080);
      }),
      http.post(VIDEO_URL, () => {
        postVideo();
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "video",
        "--prompt",
        "Animate this frame",
        "--aspect-ratio",
        "9:16",
        "--first-frame-image-url",
        FIRST_FRAME_URL,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(postVideo).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--first-frame-image-url has aspect ratio 16:9 (1920x1080), but --aspect-ratio is 9:16",
      ),
    );
  });

  it("should print video template resource selection instructions with --template", async () => {
    const postVideo = vi.fn();
    server.use(
      http.post(VIDEO_URL, () => {
        postVideo();
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "video",
      "--template",
      "video-template:epic-grandeur",
      "--prompt",
      "A cinematic mountain reveal",
      "--model",
      "dreamina-seedance-2.0-fast",
      "--aspect-ratio",
      "9:16",
      "--duration",
      "8s",
      "--resolution",
      "720p",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(postVideo).not.toHaveBeenCalled();
    expect(stdout).toContain(
      "# Okou generate video --template video-template:epic-grandeur",
    );
    expect(stdout).toContain(
      "This is a federated generation source-selection packet",
    );
    expect(stdout).toContain('"videoTemplates": [');
    expect(stdout).toContain('"id": "video-template:epic-grandeur"');
    expect(stdout).toContain("vm0-ai/vm0-skills");
    expect(stdout).not.toContain("nexu-io/open-design");
    expect(stdout).not.toContain("skill:presentation-deck-tools");
    expect(stdout).not.toContain("image-style:");
    expect(stdout).not.toContain("previewVideo");
    expect(stdout).not.toContain(".mp4");
    expect(stdout).toContain(
      "safe for all audiences, nonviolent, no explicit content",
    );
    expect(stdout).not.toContain("positive and uplifting");
  });

  it("should describe video generation models in help", () => {
    let helpOutput = "";
    videoCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    videoCommand.outputHelp();

    expect(helpOutput).toContain("Models:");
    expect(helpOutput).toContain("dreamina-seedance-2.5");
    expect(helpOutput).toContain("dreamina-seedance-2.0-fast");
    expect(helpOutput).toContain("dreamina-seedance-2.0");
    expect(helpOutput).toContain("dreamina-seedance-2.0-mini");
    expect(helpOutput).toContain("seedance-1.5-pro");
    expect(helpOutput).toContain("minimax-h3");
    expect(helpOutput).toContain("veo3.1-fast");
    expect(helpOutput).toContain("kling-v3-4k");
    expect(helpOutput).not.toContain("seedance-1.0-pro");
    expect(helpOutput).toContain("4s-30s");
    expect(helpOutput).toContain("4s-15s");
    expect(helpOutput).toContain("21:9");
    expect(helpOutput).toContain("768p");
    expect(helpOutput).toContain("2k");
    expect(helpOutput).toContain("--template");
    expect(helpOutput).toContain("--image-url");
    expect(helpOutput).toContain("--first-frame-image-url");
    expect(helpOutput).toContain("--last-frame-image-url");
    expect(helpOutput).toContain("--json");
    expect(helpOutput).toContain(
      "first/last frame inputs cannot be combined with",
    );
    expect(helpOutput).toContain("Choose one input mode before generating.");
    expect(helpOutput).toContain("Provider: 'built-in' to run Okou's pipeline");
  });

  it("should surface API errors", async () => {
    server.use(
      http.post(VIDEO_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Not enough credits",
              code: "INSUFFICIENT_CREDITS",
            },
          },
          { status: 402 },
        );
      }),
    );

    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "video",
        "--prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });

  it("should stop before generation when the workspace plan blocks video", async () => {
    let generationRequests = 0;
    server.use(
      stubBillingStatus(false),
      http.post(VIDEO_URL, () => {
        generationRequests += 1;
        return HttpResponse.json(VIDEO_RESULT);
      }),
    );

    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "video",
        "--prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Paid plan required");
    expect(stderr).toContain("okou upgrade pro");
    expect(generationRequests).toBe(0);
  });

  it("names the catalog default as the model an omitted --model falls back to", () => {
    // The help used to spell the default out by hand, and kept naming
    // seedance 2.0 fast for a while after the catalog moved off it.
    let help = "";
    videoCommand.configureOutput({
      writeOut: (text: string) => {
        help += text;
      },
    });
    videoCommand.outputHelp();
    videoCommand.configureOutput({
      writeOut: (text: string) => {
        process.stdout.write(text);
      },
    });

    const collapsed = help.replace(/\s+/g, " ");
    expect(collapsed).toContain(
      "Omitting --model generates with dreamina-seedance-2.0 ",
    );
    expect(collapsed).not.toContain("dreamina-seedance-2.0-fast (default)");
  });
});
