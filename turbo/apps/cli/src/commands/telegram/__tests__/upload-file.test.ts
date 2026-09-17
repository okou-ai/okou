/**
 * Tests for okou telegram upload-file command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../upload-file";
import chalk from "chalk";

const UPLOAD_INIT_URL =
  "http://localhost:3000/api/integrations/telegram/upload-file/init";
const UPLOAD_COMPLETE_URL =
  "http://localhost:3000/api/integrations/telegram/upload-file/complete";
const R2_UPLOAD_URL = "https://mock-r2.test/telegram-upload";

describe("okou telegram upload-file command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tmpDir: string;
  let testFilePath: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `telegram-upload-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    testFilePath = join(tmpDir, "report.pdf");
    writeFileSync(testFilePath, "telegram pdf content");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
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

    expect(helpOutput).toContain("Uploads through Okou storage first");
    expect(helpOutput).toContain(
      "Okou does not apply file type or size restrictions",
    );
  });

  it.each([
    {
      url: "/artifacts/abcxyz1234.pdf",
      expectedUrl: "https://app.okou.ai/artifacts/abcxyz1234.pdf",
    },
    {
      url: "https://files.example/report.pdf?download=1",
      expectedUrl: "https://files.example/report.pdf?download=1",
    },
  ])("prints upload URL $url", async ({ url, expectedUrl }) => {
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    let putReceivedContentType: string | null = null;
    let completeBody: Record<string, unknown> | undefined;

    server.use(
      http.post(UPLOAD_INIT_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          filename: "report.pdf",
          contentType: "application/pdf",
          length: 20,
        });
        return HttpResponse.json({
          uploadId: "00000000-0000-4000-8000-000000000001",
          uploadUrl: R2_UPLOAD_URL,
          fileUrl: url,
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 20,
          uploadHeaders: {
            "x-amz-meta-artifact-id": "00000000-0000-4000-8000-000000000001",
          },
        });
      }),
      http.put(R2_UPLOAD_URL, async ({ request }) => {
        putReceivedContentType = request.headers.get("content-type");
        expect(request.headers.get("x-amz-meta-artifact-id")).toBe(
          "00000000-0000-4000-8000-000000000001",
        );
        const bytes = Buffer.from(await request.arrayBuffer());
        expect(bytes.toString()).toBe("telegram pdf content");
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
        completeBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          messageId: 321,
          chatId: "-1001234567890",
          fileId: "tg-file-id",
          filename: "report.pdf",
          mimetype: "application/pdf",
          size: 20,
          url,
        });
      }),
    );

    await uploadFileCommand.parseAsync([
      "node",
      "cli",
      "--file",
      testFilePath,
      "--bot-id",
      "123456789",
      "--chat-id",
      "-1001234567890",
      "--caption",
      "Daily report",
      "--message-thread-id",
      "42",
    ]);

    expect(putReceivedContentType).toBe("application/pdf");
    expect(completeBody).toMatchObject({
      uploadId: "00000000-0000-4000-8000-000000000001",
      botId: "123456789",
      chatId: "-1001234567890",
      contentType: "application/pdf",
      caption: "Daily report",
      messageThreadId: 42,
    });

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      messageId: 321,
      chatId: "-1001234567890",
      fileId: "tg-file-id",
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 20,
      url: expectedUrl,
    });
  });

  it("respects --content-type override", async () => {
    const dataPath = join(tmpDir, "data.bin");
    writeFileSync(dataPath, "a,b\n1,2");

    server.use(
      http.post(UPLOAD_INIT_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.contentType).toBe("text/csv");
        return HttpResponse.json({
          uploadId: "00000000-0000-4000-8000-000000000002",
          uploadUrl: R2_UPLOAD_URL,
          fileUrl:
            "https://app.example/f/user/00000000-0000-4000-8000-000000000002/data.bin",
          filename: "data.bin",
          contentType: "text/csv",
          size: 7,
        });
      }),
      http.put(R2_UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
        expect(await request.json()).toMatchObject({ contentType: "text/csv" });
        return HttpResponse.json({
          messageId: 322,
          chatId: "@channel",
          fileId: "tg-csv-id",
          filename: "data.bin",
          mimetype: "text/csv",
          size: 7,
          url: "https://app.example/f/user/00000000-0000-4000-8000-000000000002/data.bin",
        });
      }),
    );

    await uploadFileCommand.parseAsync([
      "node",
      "cli",
      "-f",
      dataPath,
      "--bot-id",
      "123456789",
      "-c",
      "@channel",
      "--content-type",
      "text/csv",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.mimetype).toBe("text/csv");
  });

  it("errors when the file does not exist", async () => {
    await expect(async () => {
      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        join(tmpDir, "missing.pdf"),
        "--bot-id",
        "123456789",
        "-c",
        "-1001234567890",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("File not found"),
    );
  });

  it("errors when message-thread-id is not a positive integer", async () => {
    await expect(async () => {
      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        testFilePath,
        "--bot-id",
        "123456789",
        "-c",
        "-1001234567890",
        "--message-thread-id",
        "not-a-number",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("message-thread-id must be a positive integer"),
    );
  });

  it("surfaces complete API errors", async () => {
    server.use(
      http.post(UPLOAD_INIT_URL, () => {
        return HttpResponse.json({
          uploadId: "00000000-0000-4000-8000-000000000003",
          uploadUrl: R2_UPLOAD_URL,
          fileUrl:
            "https://app.example/f/user/00000000-0000-4000-8000-000000000003/report.pdf",
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 20,
        });
      }),
      http.put(R2_UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(UPLOAD_COMPLETE_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Telegram API error: Bad Request: chat not found",
              code: "TELEGRAM_ERROR",
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
        "-f",
        testFilePath,
        "--bot-id",
        "123456789",
        "-c",
        "-1001234567890",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("chat not found"),
    );
  });
});
