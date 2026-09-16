/**
 * Tests for okou generate voice command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend speech route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";
import { voiceCommand } from "../voice";

const SPEECH_URL = "http://localhost:3000/api/voice-io/speech";
const VOICE_RESULT = {
  id: "voice-file-id",
  filename: "voice-voice-fi.wav",
  contentType: "audio/wav",
  size: 19,
  url: "http://localhost:3000/f/user-1/voice-file-id/voice-voice-fi.wav",
  durationSeconds: 3,
  creditsCharged: 1,
  model: "gpt-4o-mini-tts",
  voice: "cedar",
};

describe("okou generate voice command", () => {
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
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should use Okou branding in voice help", () => {
    let helpOutput = "";
    voiceCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    voiceCommand.outputHelp();

    expect(helpOutput).toContain('--prompt "Hello from Okou"');
    expect(helpOutput).toContain("Provider: 'built-in' to run Okou's pipeline");
  });

  it("should generate speech and print the /f file URL", async () => {
    server.use(
      http.post(SPEECH_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          text: "Hello from Okou",
          voice: "cedar",
          instructions: "warm",
        });

        return HttpResponse.json(VOICE_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "voice",
      "--text",
      "Hello from Okou",
      "--voice",
      "cedar",
      "--instructions",
      "warm",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Voice generated: ${VOICE_RESULT.url}`);
    expect(stdout).toContain(`File: ${VOICE_RESULT.filename}`);
    expect(stdout).toContain(
      `[${VOICE_RESULT.filename}](<${VOICE_RESULT.url}>)`,
    );
    expect(stdout).toContain(
      `\n\n![${VOICE_RESULT.filename}](<${VOICE_RESULT.url}>)\n\n`,
    );
    expect(stdout).toContain("creates two user-facing references");
    expect(stdout).toContain("Duration: 3s");
    expect(stdout).toContain("Credits charged: 1");
  });

  it.each([VOICE_RESULT.url, "/artifacts/abcxyz1234.wav"])(
    "prints the complete voice result for %s as one JSON object",
    async (url) => {
      vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
      const expectedUrl = url.startsWith("/artifacts/")
        ? `https://app.okou.ai${url}`
        : url;
      server.use(
        http.post(SPEECH_URL, () => {
          return HttpResponse.json({ ...VOICE_RESULT, url });
        }),
      );

      await generateCommand.parseAsync([
        "node",
        "cli",
        "voice",
        "--text",
        "Hello from Okou",
        "--json",
      ]);

      expect(mockConsoleLog.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual({
        ...VOICE_RESULT,
        url: expectedUrl,
        inlineMarkdownLink: `[${VOICE_RESULT.filename}](<${expectedUrl}>)`,
        previewMarkdownBlock: `![${VOICE_RESULT.filename}](<${expectedUrl}>)`,
        artifactPresentationContext: expect.stringContaining(
          "outside code fences",
        ),
      });
    },
  );

  it.each([
    ["provider listing", ["voice", "--json"]],
    ["connector guidance", ["voice", "--provider", "elevenlabs", "--json"]],
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

  it("should surface API errors", async () => {
    server.use(
      http.post(SPEECH_URL, () => {
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
        "voice",
        "--text",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
