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
const UPLOAD_MATERIALIZE_URL =
  "http://localhost:3000/api/integrations/slack/upload-file/materialize";
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
      "Run-scoped calls publish to Okou storage before Slack delivery",
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
        "--channel",
        "C1234567",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("File uploaded");
      expect(logCalls).toContain("F0123ABC");
      expect(logCalls).toContain("https://workspace.slack.com/files/F0123ABC");
    });

    it("should pass thread, title, and comment to complete", async () => {
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
        "--channel",
        "C1234567",
        "--thread",
        "1234567890.000000",
        "--title",
        "Daily Report",
        "--comment",
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
        "--channel",
        "C1234567",
      ]);

      expect(capturedInitBody).toMatchObject({
        filename: "test-report.pdf",
        length: 28, // "fake pdf content for testing".length
      });
    });

    it.each([
      {
        url: "/artifacts/abcxyz1234.pdf",
        expectedUrl: "https://app.okou.ai/artifacts/abcxyz1234.pdf",
      },
      {
        url: "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf?download=1",
        expectedUrl:
          "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf?download=1",
      },
    ])("prints publication URL $url", async ({ url, expectedUrl }) => {
      vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
      const assetId = "a0000000-0000-4000-a000-000000000061";
      const operationId = "a0000000-0000-4000-a000-000000000062";
      const sequence: string[] = [];
      let capturedInitBody: Record<string, unknown> | undefined;
      let capturedCompleteBody: Record<string, unknown> | undefined;

      server.use(
        http.post(UPLOAD_INIT_URL, async ({ request }) => {
          capturedInitBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              kind: "canonical",
              assetId,
              operationId,
              uploadUrl: CANONICAL_PRESIGNED_URL,
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
        http.post(UPLOAD_MATERIALIZE_URL, () => {
          sequence.push("canonical-materialize");
          return HttpResponse.json(
            {
              assetId,
              url,
              delivery: {
                status: "pending",
                uploadUrl: SLACK_PRESIGNED_URL,
                fileId: "F-CANONICAL",
              },
            },
            { status: 200 },
          );
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          sequence.push("slack-upload");
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
          sequence.push("slack-complete");
          capturedCompleteBody = (await request.json()) as Record<
            string,
            unknown
          >;
          return HttpResponse.json(
            {
              fileId: "F-CANONICAL",
              permalink: "https://workspace.slack.com/files/F-CANONICAL",
              assetId,
              deliveryStatus: "delivered",
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
        "--channel",
        "C1234567",
        "--operation-id",
        operationId,
      ]);

      expect(sequence).toStrictEqual([
        "canonical-upload",
        "canonical-materialize",
        "slack-upload",
        "slack-complete",
      ]);
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
      expect(capturedCompleteBody).toMatchObject({
        fileId: "F-CANONICAL",
        channel: "C1234567",
        canonicalAssetId: assetId,
        operationId,
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`File published (asset_id: ${assetId})`);
      expect(logCalls).toContain(`  url: ${expectedUrl}`);
      expect(logCalls).toContain("Delivered to Slack");
    });

    it("keeps canonical publication successful when Slack delivery fails", async () => {
      const assetId = "a0000000-0000-4000-a000-000000000063";
      const operationId = "a0000000-0000-4000-a000-000000000064";
      let capturedCompleteBody: Record<string, unknown> | undefined;
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json({
            kind: "canonical",
            assetId,
            operationId,
            uploadUrl: CANONICAL_PRESIGNED_URL,
            url: "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf",
          });
        }),
        http.put(CANONICAL_PRESIGNED_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(UPLOAD_MATERIALIZE_URL, () => {
          return HttpResponse.json({
            assetId,
            url: "https://cdn.vm7.io/artifacts/user/asset/test-report.pdf",
            delivery: {
              status: "pending",
              uploadUrl: SLACK_PRESIGNED_URL,
              fileId: "F-FAILED",
            },
          });
        }),
        http.post(SLACK_PRESIGNED_URL, () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
        http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
          capturedCompleteBody = (await request.json()) as Record<
            string,
            unknown
          >;
          return HttpResponse.json({
            fileId: "F-FAILED",
            permalink: "",
            assetId,
            deliveryStatus: "failed",
            deliveryError: "Slack upload failed",
          });
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "--file",
        testFilePath,
        "--channel",
        "C1234567",
        "--operation-id",
        operationId,
      ]);

      expect(capturedCompleteBody).toMatchObject({
        canonicalAssetId: assetId,
        operationId,
        uploadError: expect.stringContaining("Slack upload failed"),
      });
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `File published (asset_id: ${assetId})`,
      );
      expect(mockConsoleWarn.mock.calls.flat().join("\n")).toContain(
        "Slack delivery failed",
      );
    });
  });

  describe("validation errors", () => {
    it("should error when file does not exist", async () => {
      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "--file",
          "/tmp/nonexistent-file.pdf",
          "--channel",
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
          "--channel",
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
          "--channel",
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
          "--channel",
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
          "--channel",
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
          "--channel",
          "C1234567",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Slack API error: channel_not_found"),
      );
    });
  });
});
