/**
 * Tests for okou slack upload-file command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, Slack pre-signed URL via MSW
 * - Real (internal): All CLI code, file reading, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../upload-file";
import chalk from "chalk";

const UPLOAD_INIT_URL =
  "http://localhost:3000/api/integrations/slack/upload-file/init";
const UPLOAD_COMPLETE_URL =
  "http://localhost:3000/api/integrations/slack/upload-file/complete";
const UPLOAD_DELIVER_URL =
  "http://localhost:3000/api/integrations/slack/upload-file/deliver";
const SLACK_PRESIGNED_URL = "https://files.slack.com/upload/v1/test-presigned";
const CANONICAL_PRESIGNED_URL = "https://r2.example.com/upload/canonical-asset";

describe("okou slack upload-file command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockConsoleWarn = vi
    .spyOn(console, "warn")
    .mockImplementation(() => {});

  let tmpDir: string;
  let testFilePath: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    // Create temp file for tests
    tmpDir = join(tmpdir(), `upload-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    testFilePath = join(tmpDir, "test-report.pdf");
    writeFileSync(testFilePath, "fake pdf content for testing");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockConsoleWarn.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses Okou branding in upload help", () => {
    let helpOutput = "";
    uploadFileCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    uploadFileCommand.outputHelp();

    expect(helpOutput).toContain(
      "Run-scoped calls upload to Okou storage; the server uploads and shares the Slack file",
    );
  });

  describe("successful upload", () => {
    it("should upload a file and return file_id and permalink", async () => {
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json(
            { uploadUrl: SLACK_PRESIGNED_URL, fileId: "F0123ABC" },
            { status: 200 },
          );
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_COMPLETE_URL, () => {
          return HttpResponse.json(
            {
              fileId: "F0123ABC",
              permalink: "https://workspace.slack.com/files/F0123ABC",
              channel: "C1234567",
            },
            { status: 200 },
          );
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "--file",
        testFilePath,
        "--to",
        "C1234567",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("File uploaded (id: F0123ABC)");
      expect(logCalls).toContain("chat: C1234567");
      expect(logCalls).toContain(
        "permalink: https://workspace.slack.com/files/F0123ABC",
      );
    });

    it("should DM the current user when --to is me", async () => {
      let capturedInitBody: Record<string, unknown> | undefined;
      let capturedCompleteBody: Record<string, unknown> | undefined;
      server.use(
        http.post(UPLOAD_INIT_URL, async ({ request }) => {
          capturedInitBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { uploadUrl: SLACK_PRESIGNED_URL, fileId: "F0123ABC" },
            { status: 200 },
          );
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
          capturedCompleteBody = (await request.json()) as Record<
            string,
            unknown
          >;
          return HttpResponse.json(
            {
              fileId: "F0123ABC",
              permalink: "https://workspace.slack.com/files/F0123ABC",
              channel: "D0DMCHAN",
            },
            { status: 200 },
          );
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "--file",
        testFilePath,
        "--to",
        "me",
        "--json",
      ]);

      expect(capturedInitBody?.canonical).toMatchObject({ user: "me" });
      expect(capturedInitBody?.canonical).not.toHaveProperty("channel");
      expect(capturedCompleteBody).toMatchObject({ user: "me" });
      expect(capturedCompleteBody).not.toHaveProperty("channel");
      const output = JSON.parse(
        mockConsoleLog.mock.calls.flat().join("\n"),
      ) as Record<string, unknown>;
      expect(output.chatId).toBe("D0DMCHAN");
    });

    it("should pass reply-to, title, and text to complete", async () => {
      let capturedCompleteBody: Record<string, unknown> | undefined;

      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json(
            { uploadUrl: SLACK_PRESIGNED_URL, fileId: "F0456DEF" },
            { status: 200 },
          );
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
          capturedCompleteBody = (await request.json()) as Record<
            string,
            unknown
          >;
          return HttpResponse.json(
            {
              fileId: "F0456DEF",
              permalink: "https://slack.com/files/F0456DEF",
              channel: "C1234567",
            },
            { status: 200 },
          );
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "--file",
        testFilePath,
        "--to",
        "C1234567",
        "--reply-to",
        "1234567890.000000",
        "--title",
        "Daily Report",
        "--text",
        "Here is the report",
      ]);

      expect(capturedCompleteBody).toMatchObject({
        fileId: "F0456DEF",
        channel: "C1234567",
        threadTs: "1234567890.000000",
        title: "Daily Report",
        initialComment: "Here is the report",
      });
    });

    it("should send correct filename and length in init", async () => {
      let capturedInitBody: Record<string, unknown> | undefined;

      server.use(
        http.post(UPLOAD_INIT_URL, async ({ request }) => {
          capturedInitBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { uploadUrl: SLACK_PRESIGNED_URL, fileId: "F0789GHI" },
            { status: 200 },
          );
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_COMPLETE_URL, () => {
          return HttpResponse.json(
            {
              fileId: "F0789GHI",
              permalink: "https://slack.com/files/F0789GHI",
              channel: "C1234567",
            },
            { status: 200 },
          );
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "--file",
        testFilePath,
        "--to",
        "C1234567",
      ]);

      expect(capturedInitBody).toMatchObject({
        filename: "test-report.pdf",
        length: 28, // "fake pdf content for testing".length
      });
    });

    it.each([
      {
        url: "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf?download=1",
        expectedUrl:
          "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf?download=1",
        uploadRequired: true,
      },
      {
        url: "https://app.okou.ai/artifacts/a0000000-0000-4000-a000-000000000061",
        expectedUrl:
          "https://app.okou.ai/artifacts/a0000000-0000-4000-a000-000000000061",
        uploadRequired: false,
      },
    ])(
      "prints publication URL $url",
      async ({ url, expectedUrl, uploadRequired }) => {
        vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
        const assetId = "a0000000-0000-4000-a000-000000000061";
        const operationId = "a0000000-0000-4000-a000-000000000062";
        const sequence: string[] = [];
        let capturedInitBody: Record<string, unknown> | undefined;
        let capturedDeliveryBody: Record<string, unknown> | undefined;

        server.use(
          http.post(UPLOAD_INIT_URL, async ({ request }) => {
            capturedInitBody = (await request.json()) as Record<
              string,
              unknown
            >;
            return HttpResponse.json(
              {
                kind: "canonical",
                assetId,
                operationId,
                channel: "C1234567",
                ...(uploadRequired
                  ? { uploadUrl: CANONICAL_PRESIGNED_URL }
                  : {}),
                uploadHeaders: {
                  "x-amz-meta-artifact-id": assetId,
                },
                url,
              },
              { status: 200 },
            );
          }),
          http.put(CANONICAL_PRESIGNED_URL, ({ request }) => {
            expect(request.headers.get("x-amz-meta-artifact-id")).toBe(assetId);
            sequence.push("canonical-upload");
            return new HttpResponse(null, { status: 200 });
          }),
          http.post(UPLOAD_DELIVER_URL, async ({ request }) => {
            capturedDeliveryBody = (await request.json()) as Record<
              string,
              unknown
            >;
            sequence.push("server-delivery");
            return HttpResponse.json(
              {
                assetId,
                url,
                delivery: {
                  status: "delivered",
                  fileId: "F-CANONICAL",
                  permalink: "https://workspace.slack.com/files/F-CANONICAL",
                },
              },
              { status: 200 },
            );
          }),
        );

        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          testFilePath,
          "--to",
          "C1234567",
          "--operation-id",
          operationId,
          "--json",
        ]);

        expect(sequence).toStrictEqual(
          uploadRequired
            ? ["canonical-upload", "server-delivery"]
            : ["server-delivery"],
        );
        expect(capturedInitBody).toMatchObject({
          filename: "test-report.pdf",
          canonical: {
            operationId,
            contentType: "application/pdf",
            channel: "C1234567",
          },
        });
        if (!capturedInitBody) {
          throw new Error("Expected the upload init request to be captured");
        }
        expect(
          (capturedInitBody.canonical as { checksumSha256?: string })
            .checksumSha256,
        ).toMatch(/^[a-f0-9]{64}$/);
        expect(capturedDeliveryBody).toStrictEqual({
          assetId,
          operationId,
        });
        const stdout = mockConsoleLog.mock.calls.flat().join("\n");
        expect(JSON.parse(stdout)).toStrictEqual({
          integration: "slack",
          chatId: "C1234567",
          messages: [
            {
              id: "F-CANONICAL",
              url: "https://workspace.slack.com/files/F-CANONICAL",
            },
          ],
          file: {
            name: "test-report.pdf",
            contentType: "application/pdf",
            size: 28,
            url: expectedUrl,
          },
          delivery: { status: "delivered", operationId },
        });
      },
    );

    it("keeps canonical publication successful when Slack delivery fails", async () => {
      const assetId = "a0000000-0000-4000-a000-000000000063";
      const operationId = "a0000000-0000-4000-a000-000000000064";
      let capturedDeliveryBody: Record<string, unknown> | undefined;
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json({
            kind: "canonical",
            assetId,
            operationId,
            channel: "C1234567",
            uploadUrl: CANONICAL_PRESIGNED_URL,
            url: "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf",
          });
        }),
        http.put(CANONICAL_PRESIGNED_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_DELIVER_URL, async ({ request }) => {
          capturedDeliveryBody = (await request.json()) as Record<
            string,
            unknown
          >;
          return HttpResponse.json({
            assetId,
            url: "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf",
            delivery: {
              status: "failed",
              message: "Slack upload failed",
              retryable: true,
            },
          });
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "--file",
        testFilePath,
        "--to",
        "C1234567",
        "--operation-id",
        operationId,
      ]);

      expect(capturedDeliveryBody).toStrictEqual({
        assetId,
        operationId,
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("File uploaded");
      expect(logCalls).toContain(
        "url: https://cdn.vm7.io/artifacts/user/asset/test-report.pdf",
      );
      expect(logCalls).toContain("delivery: failed");
      const warnings = mockConsoleWarn.mock.calls.flat().join("\n");
      expect(warnings).toContain("Slack delivery failed: Slack upload failed");
      expect(warnings).not.toContain("--operation-id");
    });

    it.each([404, 503])(
      "keeps the operation identity without an external fallback after delivery HTTP %i",
      async (status) => {
        const assetId = "a0000000-0000-4000-a000-000000000065";
        const operationId = "a0000000-0000-4000-a000-000000000066";
        let providerUploads = 0;
        server.use(
          http.post(UPLOAD_INIT_URL, () => {
            return HttpResponse.json({
              kind: "canonical",
              assetId,
              operationId,
              channel: "C1234567",
              url: `https://app.okou.ai/artifacts/${assetId}`,
            });
          }),
          http.post(UPLOAD_DELIVER_URL, () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Server delivery unavailable",
                  code: "UNAVAILABLE",
                },
              },
              { status },
            );
          }),
          http.post("https://files.slack.com/*", () => {
            providerUploads++;
            return new HttpResponse("OK");
          }),
        );
        await expect(
          uploadFileCommand.parseAsync([
            "node",
            "cli",
            "--file",
            testFilePath,
            "--to",
            "C1234567",
            "--operation-id",
            operationId,
          ]),
        ).rejects.toThrow("process.exit called");
        expect(providerUploads).toBe(0);
        expect(mockConsoleLog).not.toHaveBeenCalled();
        expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
          "Server delivery unavailable",
        );
        expect(mockConsoleWarn).not.toHaveBeenCalled();
      },
    );
  });

  describe("validation errors", () => {
    it("should error when file does not exist", async () => {
      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          "/tmp/nonexistent-file.pdf",
          "--to",
          "C1234567",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File not found"),
      );
    });

    it("should error when file is empty", async () => {
      const emptyFile = join(tmpDir, "empty.txt");
      writeFileSync(emptyFile, "");

      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          emptyFile,
          "--to",
          "C1234567",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File is empty"),
      );
    });
  });

  describe("API errors", () => {
    it("should handle init 401 unauthorized", async () => {
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          testFilePath,
          "--to",
          "C1234567",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
    });

    it("should handle init 404 no Slack installation", async () => {
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "No Slack installation found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          testFilePath,
          "--to",
          "C1234567",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No Slack installation found"),
      );
    });

    it("should handle direct upload failure", async () => {
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json(
            { uploadUrl: SLACK_PRESIGNED_URL, fileId: "F0123ABC" },
            { status: 200 },
          );
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          testFilePath,
          "--to",
          "C1234567",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File upload failed"),
      );
    });

    it("should handle complete API failure", async () => {
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json(
            { uploadUrl: SLACK_PRESIGNED_URL, fileId: "F0123ABC" },
            { status: 200 },
          );
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_COMPLETE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Slack API error: channel_not_found",
                code: "SLACK_ERROR",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          testFilePath,
          "--to",
          "C1234567",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Slack API error: channel_not_found"),
      );
    });
  });
});
