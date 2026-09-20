import chalk from "chalk";
import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { avatarVideoCommand } from "../avatar-video";
import { generateCommand } from "../index";
import {
  GENERATION_ARTIFACT_ID,
  serveGenerationVisibility,
} from "./artifact-visibility-fixtures";

const AVATARS_URL = "http://localhost:3000/api/avatar-video/avatars";
const VOICES_URL = "http://localhost:3000/api/avatar-video/voices";
const GENERATE_URL = "http://localhost:3000/api/avatar-video/generate";

const AVATAR_VIDEO_RESULT = {
  id: "avatar-video-file-id",
  filename: "avatar-video-avatar-v.mp4",
  contentType: "video/mp4",
  size: 1234,
  url: "http://localhost:3000/f/user-1/avatar-video-file-id/avatar-video-avatar-v.mp4",
  durationSeconds: 42,
  creditsCharged: 623,
  provider: "joggai",
  model: "joggai-talking-avatar",
  providerVideoId: "jogg-video-123",
  avatarId: 81,
  voiceId: "en-US-ChristopherNeural",
  inputType: "script",
  aspectRatio: "landscape",
  screenStyle: 2,
  caption: false,
  sourceUrl: "https://res.jogg.ai/avatar-video.mp4",
} as const;

function stubBillingStatus() {
  return http.get("http://localhost:3000/api/billing/status", () => {
    return HttpResponse.json({
      showUsagePack: false,
      tier: "team",
      canBuyCredits: true,
      videoGenerationAllowed: true,
      credits: 10_000,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    });
  });
}

describe("okou generate avatar-video command", () => {
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
    avatarVideoCommand.setOptionValue("visibility", undefined);
    server.use(stubBillingStatus());
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("publishes the generated avatar video with the requested visibility", async () => {
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_CURRENT_INTEGRATION", "slack");
    const artifact = serveGenerationVisibility("avatar.mp4", "public");
    server.use(
      http.post(`${GENERATE_URL}/private`, async ({ request }) => {
        expect(await request.json()).toMatchObject({
          script: "Welcome to Okou",
          requirePrivateArtifact: true,
        });
        return HttpResponse.json({
          ...AVATAR_VIDEO_RESULT,
          privateArtifacts: true,
          id: GENERATION_ARTIFACT_ID,
          url: artifact.reference,
        });
      }),
    );
    await generateCommand.parseAsync([
      "node",
      "cli",
      "avatar-video",
      "--avatar-id",
      "81",
      "--voice-id",
      "en-US-ChristopherNeural",
      "--script",
      "Welcome to Okou",
      "--visibility",
      "public",
      "--json",
    ]);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toMatchObject({
      url: artifact.url,
      ownerUrl: artifact.ownerUrl,
      visibility: "public",
      previewMarkdownBlock: `![${AVATAR_VIDEO_RESULT.filename}](<${artifact.url}>)`,
      artifactPresentationContext: expect.not.stringContaining("upload-file"),
    });
    expect(output).not.toContain(artifact.sharingUrl);
  });

  it.each(["--list-avatars", "--list-voices"])(
    "rejects visibility with %s instead of listing resources",
    async (listing) => {
      await expect(
        generateCommand.parseAsync([
          "node",
          "cli",
          "avatar-video",
          listing,
          "--visibility",
          "public",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        "--visibility is only available for direct built-in generation",
      );
      expect(mockConsoleLog).not.toHaveBeenCalled();
    },
  );

  it("documents built-in and connector workflows in help", () => {
    let helpOutput = "";
    avatarVideoCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    avatarVideoCommand.outputHelp();

    expect(helpOutput).toContain("Provider: 'built-in' to use Okou credits");
    expect(helpOutput).toContain("Built-in workflow (Okou credits):");
    expect(helpOutput).toContain(
      "okou generate avatar-video --provider built-in --list-avatars",
    );
    expect(helpOutput).toContain(
      "okou generate avatar-video --provider built-in --list-voices",
    );
    expect(helpOutput).toContain("JoggAI connector workflow (BYOK):");
    expect(helpOutput).toContain("okou connector status joggai");
    expect(helpOutput).toContain(
      "okou generate avatar-video --provider joggai",
    );
    expect(helpOutput).toContain('--script "Welcome to Okou"');
    expect(helpOutput).toContain(
      "Built-in generation uses Okou-managed JoggAI credentials",
    );
  });

  it("lists filtered public avatars as JSON", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["avatar-video-generation"]');
    server.use(
      http.get(AVATARS_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        const url = new URL(request.url);
        expect(url.searchParams.get("page")).toBe("2");
        expect(url.searchParams.get("pageSize")).toBe("20");
        expect(url.searchParams.get("aspectRatio")).toBe("portrait");
        expect(url.searchParams.get("style")).toBe("professional");
        return HttpResponse.json({
          avatars: [
            {
              id: 81,
              name: "Ada",
              coverUrl: "https://res.jogg.ai/ada.jpg",
              style: "professional",
            },
          ],
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "avatar-video",
      "--list-avatars",
      "--page",
      "2",
      "--page-size",
      "20",
      "--aspect-ratio",
      "portrait",
      "--avatar-style",
      "professional",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toEqual([
      [
        JSON.stringify({
          avatars: [
            {
              id: 81,
              name: "Ada",
              coverUrl: "https://res.jogg.ai/ada.jpg",
              style: "professional",
            },
          ],
        }),
      ],
    ]);
  });

  it("lists voices in a human-readable form", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["avatar-video-generation"]');
    server.use(
      http.get(VOICES_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("language")).toBe("english");
        return HttpResponse.json({
          voices: [
            {
              id: "en-US-ChristopherNeural",
              name: "Christopher",
              sampleUrl: "https://res.jogg.ai/christopher.mp3",
              language: "english",
              gender: "male",
            },
          ],
          hasMore: true,
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "avatar-video",
      "--list-voices",
      "--voice-language",
      "english",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Public JoggAI voices");
    expect(stdout).toContain("en-US-ChristopherNeural  Christopher");
    expect(stdout).toContain("Sample: https://res.jogg.ai/christopher.mp3");
    expect(stdout).toContain("More voices are available");
  });

  it("generates an avatar video and prints its artifact metadata", async () => {
    server.use(
      http.post(GENERATE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(await request.json()).toStrictEqual({
          avatarId: 81,
          voiceId: "en-US-ChristopherNeural",
          script: "Welcome to Okou",
          aspectRatio: "landscape",
          screenStyle: 2,
          caption: false,
          videoName: "Okou introduction",
        });
        return HttpResponse.json(AVATAR_VIDEO_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "avatar-video",
      "--avatar-id",
      "81",
      "--voice-id",
      "en-US-ChristopherNeural",
      "--script",
      "Welcome to Okou",
      "--aspect-ratio",
      "landscape",
      "--screen-style",
      "2",
      "--no-caption",
      "--video-name",
      "Okou introduction",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      `Avatar video generated: ${AVATAR_VIDEO_RESULT.url}`,
    );
    expect(stdout).toContain(`File: ${AVATAR_VIDEO_RESULT.filename}`);
    expect(stdout).toContain(
      `[${AVATAR_VIDEO_RESULT.filename}](<${AVATAR_VIDEO_RESULT.url}>)`,
    );
    expect(stdout).toContain(
      `\n\n![${AVATAR_VIDEO_RESULT.filename}](<${AVATAR_VIDEO_RESULT.url}>)\n\n`,
    );
    expect(stdout).toContain("creates two user-facing references");
    expect(stdout).toContain("Duration: 42s");
    expect(stdout).toContain("Credits charged: 623");
  });

  it("prints a complete generation result as JSON", async () => {
    server.use(
      http.post(GENERATE_URL, () => {
        return HttpResponse.json(AVATAR_VIDEO_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "avatar-video",
      "--avatar-id",
      "81",
      "--voice-id",
      "en-US-ChristopherNeural",
      "--script",
      "Welcome to Okou",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual({
      ...AVATAR_VIDEO_RESULT,
      inlineMarkdownLink: `[${AVATAR_VIDEO_RESULT.filename}](<${AVATAR_VIDEO_RESULT.url}>)`,
      previewMarkdownBlock: `![${AVATAR_VIDEO_RESULT.filename}](<${AVATAR_VIDEO_RESULT.url}>)`,
      artifactPresentationContext: expect.stringContaining(
        "outside code fences",
      ),
    });
  });

  it("rejects mixed script and audio input before calling the API", async () => {
    const generate = vi.fn();
    server.use(
      http.post(GENERATE_URL, () => {
        generate();
        return HttpResponse.json(AVATAR_VIDEO_RESULT);
      }),
    );

    await expect(
      generateCommand.parseAsync([
        "node",
        "cli",
        "avatar-video",
        "--avatar-id",
        "81",
        "--voice-id",
        "en-US-ChristopherNeural",
        "--script",
        "Hello",
        "--audio-url",
        "https://example.com/voice.mp3",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(generate).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Use exactly one of --script and --audio-url"),
    );
  });
});
