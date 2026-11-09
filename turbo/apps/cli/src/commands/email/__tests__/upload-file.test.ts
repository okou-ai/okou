import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { MAX_EMAIL_ATTACHMENT_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-email";
import { server } from "../../../mocks/server";
import { createEmailCommand } from "../index";

const fileId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const threadId = "00000000-0000-4000-8000-000000000003";
const fileUrl = `https://app.okou.ai${artifactReferencePath(fileId, "report.txt")}`;
const api = "http://localhost:3000";
const putUrl = "https://email-upload.example/report.txt";
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("CLI exited");
});
let directory: string;
let emailCommand: ReturnType<typeof createEmailCommand>;

beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", api);
  vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
  vi.stubEnv("OKOU_CURRENT_INTEGRATION", "email");
  directory = mkdtempSync(join(tmpdir(), "email-upload-"));
  emailCommand = createEmailCommand();
  output.mockClear();
  warnings.mockClear();
  errors.mockClear();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function receipt(delivery: object) {
  return {
    uploadId: fileId,
    operationId,
    chatThreadId: threadId,
    emailAddress: "verified@example.com",
    filename: "report.txt",
    contentType: "text/plain",
    size: 6,
    url: fileUrl,
    delivery,
  };
}

function mockPublication() {
  server.use(
    http.post(`${api}/api/uploads/prepare/private`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      expect(await request.json()).toMatchObject({
        filename: "report.txt",
        purpose: "artifact",
        requirePrivateArtifact: true,
        size: 6,
      });
      return HttpResponse.json({
        id: fileId,
        filename: "report.txt",
        contentType: "text/plain",
        size: 6,
        url: fileUrl,
        uploadUrl: putUrl,
        uploadHeaders: {},
      });
    }),
    http.put(putUrl, async ({ request }) => {
      expect(request.headers.get("authorization")).toBeNull();
      expect(await request.text()).toBe("report");
      return new HttpResponse(null, { status: 200 });
    }),
    http.post(`${api}/api/uploads/complete`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      expect(await request.json()).toMatchObject({ id: fileId });
      return HttpResponse.json({
        id: fileId,
        filename: "report.txt",
        contentType: "text/plain",
        size: 6,
        url: fileUrl,
      });
    }),
  );
}

describe("okou email upload-file", () => {
  it("publishes a private file and prints the queued Email receipt without treating it as sent", async () => {
    const path = join(directory, "report.txt");
    writeFileSync(path, "report");
    mockPublication();
    server.use(
      http.post(
        `${api}/api/integrations/email/upload-file/complete`,
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(await request.json()).toStrictEqual({
            uploadId: fileId,
            text: "Requested report",
          });
          return HttpResponse.json(receipt({ status: "pending" }));
        },
      ),
    );
    await emailCommand.parseAsync([
      "node",
      "okou email",
      "upload-file",
      "--file",
      path,
      "--text",
      "Requested report",
      "--json",
    ]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toMatchObject({
      integration: "email",
      chatId: threadId,
      messages: [],
      file: { url: fileUrl },
      delivery: { status: "pending", operationId },
    });
    expect(warnings.mock.calls.flat().join("\n")).toContain(
      `--upload-id ${fileId}`,
    );
  });

  it("resumes the original uploaded file and reports provider acceptance without another publication", async () => {
    server.use(
      http.post(
        `${api}/api/integrations/email/upload-file/complete`,
        async ({ request }) => {
          expect(await request.json()).toStrictEqual({ uploadId: fileId });
          return HttpResponse.json(
            receipt({ status: "accepted", providerId: "resend-receipt" }),
          );
        },
      ),
    );
    await emailCommand.parseAsync([
      "node",
      "okou email",
      "upload-file",
      "--upload-id",
      fileId,
      "--json",
    ]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toMatchObject({
      file: { url: fileUrl },
      delivery: { status: "accepted", operationId },
      messages: [{ id: "resend-receipt", url: null }],
    });
  });

  it("rejects an oversized local attachment before uploading", async () => {
    const path = join(directory, "large.txt");
    writeFileSync(path, "x");
    truncateSync(path, MAX_EMAIL_ATTACHMENT_SIZE_BYTES + 1);
    await expect(
      emailCommand.parseAsync([
        "node",
        "okou email",
        "upload-file",
        "-f",
        path,
      ]),
    ).rejects.toThrow("CLI exited");
    expect(errors.mock.calls.flat().join("\n")).toContain("at most 25 MiB");
  });

  it("rejects another integration before trying to publish or send", async () => {
    vi.stubEnv("OKOU_CURRENT_INTEGRATION", "web");
    await expect(
      emailCommand.parseAsync([
        "node",
        "okou email",
        "upload-file",
        "--upload-id",
        fileId,
      ]),
    ).rejects.toThrow("CLI exited");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Email-originated run",
    );
  });

  it("retains the upload receipt when the delivery response is unavailable", async () => {
    const path = join(directory, "report.txt");
    writeFileSync(path, "report");
    mockPublication();
    server.use(
      http.post(`${api}/api/integrations/email/upload-file/complete`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Delivery response unavailable",
            },
          },
          { status: 503 },
        );
      }),
    );
    await expect(
      emailCommand.parseAsync([
        "node",
        "okou email",
        "upload-file",
        "--file",
        path,
        "--json",
      ]),
    ).rejects.toThrow("CLI exited");
    expect(warnings.mock.calls.flat().join("\n")).toContain(
      `--upload-id ${fileId}`,
    );
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Delivery response unavailable",
    );
  });
});
