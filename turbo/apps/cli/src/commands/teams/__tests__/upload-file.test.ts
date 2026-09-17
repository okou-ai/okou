/**
 * Tests for okou teams upload-file command.
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../upload-file";

const UPLOAD_INIT_URL =
  "http://localhost:3000/api/integrations/teams/upload-file/init";
const UPLOAD_COMPLETE_URL =
  "http://localhost:3000/api/integrations/teams/upload-file/complete";
const R2_UPLOAD_URL = "https://mock-r2.test/teams-upload";

describe("okou teams upload-file command", () => {
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
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `teams-upload-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    testFilePath = join(tmpDir, "report.pdf");
    writeFileSync(testFilePath, "teams pdf content");
  });

  afterEach(() => {
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
  });

  it.each([
    {
      url: "/artifacts/abcxyz1234.pdf",
      expectedUrl: "https://app.okou.ai/artifacts/abcxyz1234.pdf",
      appUrl: "https://app.okou.ai",
      activityId: undefined,
    },
    {
      url: "/artifacts/00000000000040008000000000000001.pdf#page=2",
      expectedUrl:
        "https://pr-123-app.omby.ai/artifacts/00000000000040008000000000000001.pdf#page=2",
      appUrl: "https://pr-123-app.omby.ai",
      activityId: "teams-activity-1",
    },
    {
      url: "https://files.example/report.pdf?download=1#page=2",
      expectedUrl: "https://files.example/report.pdf?download=1#page=2",
      appUrl: "https://app.okou.ai",
      activityId: "teams-activity-1",
    },
  ])("prints upload URL $url", async (testCase) => {
    const { url, expectedUrl, appUrl, activityId } = testCase;
    vi.stubEnv("OKOU_APP_URL", appUrl);
    let putReceivedContentType: string | null = null;
    let completeBody: Record<string, unknown> | undefined;

    server.use(
      http.post(UPLOAD_INIT_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          filename: "report.pdf",
          contentType: "application/pdf",
          length: 17,
        });
        return HttpResponse.json({
          uploadId: "00000000-0000-4000-8000-000000000001",
          uploadUrl: R2_UPLOAD_URL,
          fileUrl: url,
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 17,
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
        expect(bytes.toString()).toBe("teams pdf content");
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
        completeBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          activityId,
          conversationId: "19:thread@thread.tacv2",
          filename: "report.pdf",
          mimetype: "application/pdf",
          size: 17,
          url,
        });
      }),
    );

    await uploadFileCommand.parseAsync([
      "node",
      "cli",
      "--file",
      testFilePath,
      "--conversation-id",
      "19:thread@thread.tacv2",
      "--activity-id",
      "root-activity",
      "--text",
      "Daily report",
    ]);

    expect(putReceivedContentType).toBe("application/pdf");
    expect(completeBody).toStrictEqual({
      uploadId: "00000000-0000-4000-8000-000000000001",
      conversationId: "19:thread@thread.tacv2",
      activityId: "root-activity",
      contentType: "application/pdf",
      text: "Daily report",
    });

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      conversationId: "19:thread@thread.tacv2",
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 17,
      url: expectedUrl,
    });
    expect(parsed.activityId).toBe(activityId);
  });

  it("errors when the file does not exist", async () => {
    await expect(async () => {
      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "--file",
        join(tmpDir, "missing.pdf"),
        "--conversation-id",
        "19:thread@thread.tacv2",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("File not found"),
    );
  });
});
