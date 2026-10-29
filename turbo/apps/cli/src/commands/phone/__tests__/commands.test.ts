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
const GROUP_UPLOAD_COMPLETE_URL =
  "http://localhost:3000/api/integrations/phone/upload-file/complete-group";
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
    uploadFileCommand.setOptionValue("to", "me");
    uploadFileCommand.setOptionValue("as", undefined);
    uploadFileCommand.setOptionValue("text", undefined);
    uploadFileCommand.setOptionValue("json", false);
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

  it("downloads an authorized owned artifact through its signed URL", async () => {
    const outPath = join(tmpDir, "direct.txt");
    const target = "https://static.vm0.io/phone/direct.txt";
    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return new HttpResponse(null, {
          status: 302,
          headers: {
            location: target,
            "x-file-mimetype": "text/plain",
            "x-file-size": "5",
          },
        });
      }),
      http.get(target, () => {
        return new HttpResponse("hello", {
          headers: { "content-type": "text/plain", "content-length": "5" },
        });
      }),
    );
    await downloadFileCommand.parseAsync([
      "node",
      "okou",
      "artifact-id",
      "-o",
      outPath,
    ]);
    expect(readFileSync(outPath, "utf8")).toBe("hello");
    expect(JSON.parse(mockConsoleLog.mock.calls.flat().join("\n"))).toEqual({
      path: outPath,
      size: 5,
      mimetype: "text/plain",
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
      "--as",
      "agt_123",
      "--text",
      "hello",
    ]);

    expect(capturedBody).not.toHaveProperty("toNumber");
    expect(capturedBody).toMatchObject({
      agentphoneAgentId: "agt_123",
      text: "hello",
    });
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Message sent (id: apmsg_sent)",
    );
  });

  it("accepts --to me for the connected phone and prints the --json envelope", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(MESSAGE_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          messageId: "apmsg_sent",
          channel: "imessage",
          toNumber: "someone@example.com",
        });
      }),
    );

    await messageCommand.parseAsync([
      "node",
      "cli",
      "--to",
      "me",
      "--text",
      "hello",
      "--json",
    ]);

    expect(capturedBody).not.toHaveProperty("toNumber");
    expect(capturedBody).toMatchObject({ text: "hello" });
    expect(
      JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
    ).toStrictEqual({
      integration: "phone",
      chatId: "someone@example.com",
      messages: [{ id: "apmsg_sent", url: null }],
    });
  });

  it.each([
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
      "--text",
      "report",
      "--json",
    ]);

    expect(completeBody).not.toHaveProperty("toNumber");
    expect(completeBody).toMatchObject({
      uploadId: "00000000-0000-4000-8000-000000000001",
      contentType: "application/pdf",
      caption: "report",
    });

    expect(
      JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
    ).toStrictEqual({
      integration: "phone",
      chatId: "+15551234567",
      messages: [{ id: "apmsg_file", url: null }],
      file: {
        name: "report.pdf",
        contentType: "application/pdf",
        size: 17,
        url: expectedUrl,
      },
    });
  });

  it.each(["grp_upload", "chat:grp_upload"])(
    "uploads an image to %s and prints the group destination",
    async (target) => {
      const path = join(tmpDir, "photo.png");
      writeFileSync(path, "image bytes");
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json({
            uploadId: "00000000-0000-4000-8000-000000000001",
            uploadUrl: R2_UPLOAD_URL,
            fileUrl: "https://files.example/photo.png",
            filename: "photo.png",
            contentType: "image/png",
            size: 11,
            uploadHeaders: {},
          });
        }),
        http.put(R2_UPLOAD_URL, async ({ request }) => {
          expect(await request.text()).toBe("image bytes");
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(GROUP_UPLOAD_COMPLETE_URL, async ({ request }) => {
          expect(await request.json()).toEqual({
            uploadId: "00000000-0000-4000-8000-000000000001",
            groupId: "grp_upload",
            agentphoneAgentId: "agt_group",
            contentType: "image/png",
            caption: "For the team",
          });
          return HttpResponse.json({
            messageId: "apmsg_group_file",
            channel: "imessage",
            toNumber: "grp_upload",
            filename: "photo.png",
            mimetype: "image/png",
            size: 11,
            url: "https://files.example/photo.png",
          });
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "okou",
        "--to",
        target,
        "-f",
        path,
        "--as",
        "agt_group",
        "--text",
        "For the team",
        "--json",
      ]);
      expect(JSON.parse(mockConsoleLog.mock.calls.flat().join("\n"))).toEqual({
        integration: "phone",
        chatId: "grp_upload",
        messages: [{ id: "apmsg_group_file", url: null }],
        file: {
          name: "photo.png",
          contentType: "image/png",
          size: 11,
          url: "https://files.example/photo.png",
        },
      });
    },
  );

  it.each([
    {
      status: 403,
      code: "FORBIDDEN",
      message:
        "Your connected phone must be a current member of this iMessage group",
    },
    { status: 404, code: "NOT_FOUND", message: "Not found" },
  ])(
    "reports a group error ($status) without sending to the linked phone",
    async ({ status, code, message }) => {
      const path = join(tmpDir, "photo.png");
      writeFileSync(path, "image bytes");
      let directSends = 0;
      server.use(
        http.post(UPLOAD_INIT_URL, () => {
          return HttpResponse.json({
            uploadId: "00000000-0000-4000-8000-000000000001",
            uploadUrl: R2_UPLOAD_URL,
            fileUrl: "https://files.example/photo.png",
            filename: "photo.png",
            contentType: "image/png",
            size: 11,
            uploadHeaders: {},
          });
        }),
        http.put(R2_UPLOAD_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(GROUP_UPLOAD_COMPLETE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                code,
                message,
              },
            },
            { status },
          );
        }),
        http.post(UPLOAD_COMPLETE_URL, () => {
          directSends++;
          return new HttpResponse(null, { status: 500 });
        }),
      );
      await expect(
        uploadFileCommand.parseAsync([
          "node",
          "okou",
          "--to",
          "grp_upload",
          "-f",
          path,
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(message);
      expect(directSends).toBe(0);
    },
  );

  it("rejects arbitrary recipient phone numbers for file uploads", async () => {
    await expect(
      uploadFileCommand.parseAsync([
        "node",
        "okou",
        "--to",
        "+15551234567",
        "-f",
        "/unused/photo.png",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Use --to me or --to chat:grp_<id>",
    );
  });
});
