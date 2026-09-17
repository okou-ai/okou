import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import { messageCommand } from "../message";
import { uploadFileCommand } from "../upload-file";

const DOWNLOAD_URL =
  "http://localhost:3000/api/integrations/phone/download-file";
const MESSAGE_URL = "http://localhost:3000/api/integrations/phone/message";
const UPLOAD_INIT_URL =
  "http://localhost:3000/api/integrations/phone/upload-file/init";
const UPLOAD_COMPLETE_URL =
  "http://localhost:3000/api/integrations/phone/upload-file/complete";
const R2_UPLOAD_URL = "https://mock-r2.test/phone-upload";

describe("okou phone commands", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tmpDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    tmpDir = join(tmpdir(), `phone-command-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("downloads AgentPhone file bytes to the provided output path", async () => {
    const payload = Buffer.from("hello phone");
    const outPath = join(tmpDir, "photo.jpg");

    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("file_id")).toBe("apmsg_123");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return new HttpResponse(payload, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(payload.length),
            "x-file-mimetype": "image/jpeg",
          },
        });
      }),
    );

    await downloadFileCommand.parseAsync([
      "node",
      "cli",
      "apmsg_123",
      "-o",
      outPath,
    ]);

    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).equals(payload)).toBe(true);

    const parsed = JSON.parse(
      mockConsoleLog.mock.calls.flat().join("\n"),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      path: outPath,
      mimetype: "image/jpeg",
      size: payload.length,
    });
  });

  it("sends a text message", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(MESSAGE_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          messageId: "apmsg_sent",
          channel: "sms",
          toNumber: "+15551234567",
        });
      }),
    );

    await messageCommand.parseAsync([
      "node",
      "cli",
      "--to",
      "+15551234567",
      "--agent-id",
      "agt_123",
      "--text",
      "hello",
    ]);

    expect(capturedBody).toMatchObject({
      toNumber: "+15551234567",
      agentphoneAgentId: "agt_123",
      text: "hello",
    });
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Message sent",
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
    const testFilePath = join(tmpDir, "report.pdf");
    writeFileSync(testFilePath, "phone pdf content");
    let completeBody: Record<string, unknown> | undefined;

    server.use(
      http.post(UPLOAD_INIT_URL, async ({ request }) => {
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
        expect(request.headers.get("x-amz-meta-artifact-id")).toBe(
          "00000000-0000-4000-8000-000000000001",
        );
        const bytes = Buffer.from(await request.arrayBuffer());
        expect(bytes.toString()).toBe("phone pdf content");
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(UPLOAD_COMPLETE_URL, async ({ request }) => {
        completeBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          messageId: "apmsg_file",
          channel: "sms",
          toNumber: "+15551234567",
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
      "-f",
      testFilePath,
      "--to",
      "+15551234567",
      "--caption",
      "report",
    ]);

    expect(completeBody).toMatchObject({
      uploadId: "00000000-0000-4000-8000-000000000001",
      toNumber: "+15551234567",
      contentType: "application/pdf",
      caption: "report",
    });

    const parsed = JSON.parse(
      mockConsoleLog.mock.calls.flat().join("\n"),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      messageId: "apmsg_file",
      filename: "report.pdf",
      mimetype: "application/pdf",
      url: expectedUrl,
    });
  });
});
