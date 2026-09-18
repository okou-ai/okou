import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../upload-file";
import chalk from "chalk";

const UPLOAD_INIT_URL =
  "http://localhost:3000/api/integrations/github/upload-file/init";
const UPLOAD_COMPLETE_URL =
  "http://localhost:3000/api/integrations/github/upload-file/complete";
const R2_UPLOAD_URL = "https://mock-r2.test/github-upload";

describe("okou github upload-file command", () => {
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

    tmpDir = join(tmpdir(), `github-upload-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    testFilePath = join(tmpDir, "report.pdf");
    writeFileSync(testFilePath, "github pdf content");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses Okou branding in upload help while preserving repository examples", () => {
    let helpOutput = "";
    uploadFileCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    uploadFileCommand.outputHelp();

    expect(helpOutput).toContain("Uploads through Okou storage first");
    expect(helpOutput).toContain("vm0-ai/vm0");
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
          length: 18,
        });
        return HttpResponse.json({
          uploadId: "00000000-0000-4000-8000-000000000101",
          uploadUrl: R2_UPLOAD_URL,
          fileUrl: url,
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 18,
          uploadHeaders: {
            "x-amz-meta-artifact-id": "00000000-0000-4000-8000-000000000101",
          },
        });
      }),
      http.put(R2_UPLOAD_URL, async ({ request }) => {
        putReceivedContentType = request.headers.get("content-type");
        expect(request.headers.get("x-amz-meta-artifact-id")).toBe(
          "00000000-0000-4000-8000-000000000101",
        );
        const bytes = Buffer.from(await request.arrayBuffer());
        expect(bytes.toString()).toBe("github pdf content");
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
        completeBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          commentId: "12345",
          repo: "vm0-ai/vm0",
          issueNumber: 42,
          filename: "report.pdf",
          mimetype: "application/pdf",
          size: 18,
          url,
        });
      }),
    );

    await uploadFileCommand.parseAsync([
      "node",
      "cli",
      "--file",
      testFilePath,
      "--repo",
      "vm0-ai/vm0",
      "--issue-number",
      "42",
      "--caption",
      "Daily report",
    ]);

    expect(putReceivedContentType).toBe("application/pdf");
    expect(completeBody).toMatchObject({
      uploadId: "00000000-0000-4000-8000-000000000101",
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      contentType: "application/pdf",
      caption: "Daily report",
    });

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      commentId: "12345",
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 18,
      url: expectedUrl,
    });
  });

  it("errors when issue-number is not a positive integer", async () => {
    await expect(async () => {
      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        testFilePath,
        "-r",
        "vm0-ai/vm0",
        "-i",
        "not-a-number",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("issue-number must be a positive integer"),
    );
  });
});
