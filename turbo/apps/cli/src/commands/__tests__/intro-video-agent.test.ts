import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntroVideoAgentResponse } from "@okouai/api-contracts/contracts/intro-video-agent";
import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";

import { server } from "../../mocks/server";
import { introVideoAgentCommand } from "../__intro-video-agent";

const GENERATE_URL = "http://localhost:3000/api/intro-video/agent/generate";
const REQUEST_ID = "9680b69a-52c0-41e6-905f-dfb213226059";
const STATUS_URL = `http://localhost:3000/api/intro-video/agent/${REQUEST_ID}`;
const PENDING_RESULT: IntroVideoAgentResponse = {
  generationId: REQUEST_ID,
  status: "queued",
  sessionId: null,
  videoId: null,
};
const COMPLETED_RESULT: IntroVideoAgentResponse = {
  generationId: REQUEST_ID,
  status: "completed",
  sessionId: "native-session",
  videoId: "native-video",
  providerStatus: "completed",
  filename: "intro.mp4",
  contentType: "video/mp4",
  size: 1234,
  url: "https://api.okou.ai/f/user-1/intro-id/intro.mp4",
  durationSeconds: 42,
  creditsCharged: 400,
  styleId: "editorial-style",
  avatarId: "public-avatar-look",
  voiceId: "avatar-default-voice",
  orientation: "landscape",
};

const PENDING_OUTPUT = {
  ...PENDING_RESULT,
  resumeCommand: `okou __intro-video-agent status ${REQUEST_ID} --json`,
  continuationContext: expect.stringContaining("do not submit another video"),
};
const COMPLETED_OUTPUT = {
  ...COMPLETED_RESULT,
  inlineMarkdownLink: `[intro.mp4](<${COMPLETED_RESULT.url}>)`,
  previewMarkdownBlock: `![intro.mp4](<${COMPLETED_RESULT.url}>)`,
  artifactPresentationContext: expect.stringContaining("outside code fences"),
};

function submitArgs(...extra: string[]): string[] {
  return [
    "node",
    "okou",
    "--prompt",
    "Introduce the launch using the source facts.",
    "--style-id",
    "editorial-style",
    "--orientation",
    "landscape",
    "--request-id",
    REQUEST_ID,
    ...extra,
  ];
}

describe("internal Intro Video Agent command", () => {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let tempDir: string;

  beforeEach(async () => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-run-token");
    for (const command of [
      introVideoAgentCommand,
      ...introVideoAgentCommand.commands,
    ]) {
      for (const option of command.options) {
        command.setOptionValue(option.attributeName(), undefined);
      }
    }
    introVideoAgentCommand.setOptionValue("fileUrl", []);
    tempDir = await mkdtemp(join(tmpdir(), "intro-video-agent-"));
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    { selection: "explicit", styleId: "selected-catalog-style" },
    {
      selection: "Auto resolved from the live catalog",
      styleId: "auto-chosen-catalog-style",
    },
  ])(
    "submits the concrete $selection style and exact choices once",
    async ({ styleId }) => {
      vi.stubEnv(
        DISABLED_PAID_TOOLS_ENV_VAR,
        '["voice-generation", "avatar-video-generation", "video-rendering"]',
      );
      let submissions = 0;
      server.use(
        http.post(GENERATE_URL, async ({ request }) => {
          submissions++;
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-run-token",
          );
          await expect(request.json()).resolves.toStrictEqual({
            requestId: REQUEST_ID,
            prompt: "Introduce the launch using the source facts.",
            styleId,
            avatarId: "public-avatar-look",
            avatarGroupId: "public-avatar-group",
            voiceId: "chosen-voice",
            orientation: "portrait",
            fileUrls: [
              "https://api.okou.ai/f/user-1/deck-id/source.pdf",
              "https://api.okou.ai/f/user-1/recording-id/source.webm",
              `http://localhost:3000/api/web/download-file?file_id=${REQUEST_ID}&filename=reference.png`,
            ],
          });
          return HttpResponse.json(PENDING_RESULT, { status: 202 });
        }),
      );

      await introVideoAgentCommand.parseAsync(
        submitArgs(
          "--style-id",
          styleId,
          "--avatar-id",
          "public-avatar-look",
          "--avatar-group-id",
          "public-avatar-group",
          "--voice-id",
          "chosen-voice",
          "--orientation",
          "portrait",
          "--file-url",
          "https://api.okou.ai/f/user-1/deck-id/source.pdf",
          "--file-url",
          "https://api.okou.ai/f/user-1/recording-id/source.webm",
          "--file-url",
          `http://localhost:3000/api/web/download-file?file_id=${REQUEST_ID}&filename=reference.png`,
          "--json",
        ),
      );

      expect(submissions).toBe(1);
      expect(mockConsoleLog.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual(
        PENDING_OUTPUT,
      );
    },
  );

  it("reads a UTF-8 prompt file, preserves avatar default voice resolution, and reuses the request ID", async () => {
    const promptFile = join(tempDir, "intro.txt");
    await writeFile(promptFile, "Introduce the launch.\n保留来源事实。\n");
    let submissions = 0;
    server.use(
      http.post(GENERATE_URL, async ({ request }) => {
        submissions++;
        await expect(request.json()).resolves.toStrictEqual({
          requestId: REQUEST_ID,
          prompt: "Introduce the launch.\n保留来源事实。",
          styleId: "editorial-style",
          avatarId: "public-avatar-look",
          orientation: "landscape",
          fileUrls: [],
        });
        return submissions === 1
          ? HttpResponse.json(PENDING_RESULT, { status: 202 })
          : HttpResponse.json(COMPLETED_RESULT);
      }),
    );
    const args = [
      "node",
      "okou",
      "--prompt-file",
      promptFile,
      "--style-id",
      "editorial-style",
      "--avatar-id",
      "public-avatar-look",
      "--orientation",
      "landscape",
      "--request-id",
      REQUEST_ID,
      "--json",
    ];

    await introVideoAgentCommand.parseAsync(args);
    await introVideoAgentCommand.parseAsync(args);

    expect(submissions).toBe(2);
    expect(
      mockConsoleLog.mock.calls.map(([output]) => {
        return JSON.parse(String(output));
      }),
    ).toEqual([PENDING_OUTPUT, COMPLETED_OUTPUT]);
  });

  it.each([
    {
      ...PENDING_RESULT,
      status: "running",
      sessionId: "native-session",
      providerStatus: "thinking",
    },
    COMPLETED_RESULT,
  ])(
    "reads a $status job without submission options or another POST",
    async (result) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["video-generation"]');
      let statusRequests = 0;
      server.use(
        http.get(STATUS_URL, ({ request }) => {
          statusRequests++;
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-run-token",
          );
          return HttpResponse.json(result);
        }),
      );

      await introVideoAgentCommand.parseAsync([
        "node",
        "okou",
        "status",
        REQUEST_ID,
        "--json",
      ]);

      expect(statusRequests).toBe(1);
      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual(
        result.status === "completed"
          ? COMPLETED_OUTPUT
          : { ...PENDING_OUTPUT, ...result },
      );
    },
  );

  it("prints the completed video preview forms from a status query", async () => {
    server.use(
      http.get(STATUS_URL, () => {
        return HttpResponse.json(COMPLETED_RESULT);
      }),
    );
    await introVideoAgentCommand.parseAsync([
      "node",
      "okou",
      "status",
      REQUEST_ID,
    ]);
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`[intro.mp4](<${COMPLETED_RESULT.url}>)`);
    expect(stdout).toContain(`\n\n![intro.mp4](<${COMPLETED_RESULT.url}>)\n\n`);
    expect(stdout).toContain("outside a code fence");
  });

  it("keeps a failed job's error available without claiming a preview", async () => {
    const failed = {
      ...PENDING_RESULT,
      status: "failed",
      error: { code: "PROVIDER_ERROR", message: "Generation failed" },
    };
    server.use(
      http.get(STATUS_URL, () => {
        return HttpResponse.json(failed);
      }),
    );
    await introVideoAgentCommand.parseAsync([
      "node",
      "okou",
      "status",
      REQUEST_ID,
      "--json",
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual(
      failed,
    );
  });

  it.each([false, true])(
    "prints a new recovery ID before submitting (JSON: %s)",
    async (json) => {
      let submittedRequestId: unknown;
      server.use(
        http.post(GENERATE_URL, async ({ request }) => {
          const body: unknown = await request.json();
          expect(body).toEqual(
            expect.objectContaining({ requestId: expect.any(String) }),
          );
          if (typeof body !== "object" || !body || !("requestId" in body)) {
            throw new Error("Missing request ID");
          }
          submittedRequestId = body.requestId;
          const output = json ? mockConsoleError : mockConsoleLog;
          expect(output.mock.calls.flat().join("\n")).toContain(
            `Request ID: ${submittedRequestId}`,
          );
          return HttpResponse.json(
            { ...PENDING_RESULT, generationId: submittedRequestId },
            { status: 202 },
          );
        }),
      );

      await introVideoAgentCommand.parseAsync([
        "node",
        "okou",
        "--prompt",
        "Introduce this product.",
        "--style-id",
        "editorial-style",
        "--orientation",
        "landscape",
        ...(json ? ["--json"] : []),
      ]);

      expect(submittedRequestId).toEqual(expect.any(String));
      const output = json ? mockConsoleError : mockConsoleLog;
      expect(output.mock.calls.flat().join("\n")).toContain(
        `okou __intro-video-agent status ${submittedRequestId} --json`,
      );
    },
  );

  it("preserves the request ID and recovery command after a transport failure without retrying", async () => {
    let submissions = 0;
    server.use(
      http.post(GENERATE_URL, () => {
        submissions++;
        return HttpResponse.error();
      }),
    );

    await expect(
      introVideoAgentCommand.parseAsync(submitArgs("--json")),
    ).rejects.toThrow("process.exit called");

    expect(submissions).toBe(1);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        requestId: REQUEST_ID,
        generationId: REQUEST_ID,
        error: { message: "Failed to fetch" },
        resumeCommand: `okou __intro-video-agent status ${REQUEST_ID} --json`,
        notice:
          "Submission was not confirmed. Check this generation ID before retrying. Reuse the same --request-id and input; do not submit a new request ID.",
      }),
    );
  });

  it.each([
    {
      name: "unresolved style",
      omit: "styleId",
      extra: [],
      error: "--style-id is required",
    },
    {
      name: "missing output orientation",
      omit: "orientation",
      extra: [],
      error: "--orientation is required",
    },
    {
      name: "two prompt sources",
      extra: ["--prompt-file", "other.txt"],
      error: "exactly one",
    },
    {
      name: "malformed avatar ID",
      extra: ["--avatar-id", "group id is not a look"],
      error: "avatarId",
    },
    {
      name: "malformed reference URL",
      extra: ["--file-url", "not a URL"],
      error: "fileUrls",
    },
    {
      name: "insecure reference URL",
      extra: ["--file-url", "http://api.okou.ai/f/source.pdf"],
      error: "fileUrls",
    },
    {
      name: "reference URL with credentials",
      extra: ["--file-url", "https://user:password@api.okou.ai/f/source.pdf"],
      error: "fileUrls",
    },
    {
      name: "private reference URL",
      extra: ["--file-url", "https://127.0.0.1/source.pdf"],
      error: "fileUrls",
    },
  ])("rejects $name before submitting", async ({ omit, extra, error }) => {
    let submissions = 0;
    server.use(
      http.post(GENERATE_URL, () => {
        submissions++;
        return HttpResponse.json(PENDING_RESULT, { status: 202 });
      }),
    );
    const args = submitArgs(...extra);
    const optionName =
      omit === "styleId"
        ? "--style-id"
        : omit === "orientation"
          ? "--orientation"
          : undefined;
    if (optionName) {
      args.splice(args.indexOf(optionName), 2);
    }

    await expect(introVideoAgentCommand.parseAsync(args)).rejects.toThrow(
      "process.exit called",
    );

    expect(submissions).toBe(0);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(error);
  });
});
