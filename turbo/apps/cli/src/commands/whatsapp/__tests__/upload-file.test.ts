import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { whatsappCommand } from "../index";
import { uploadWhatsappFileCommand } from "../upload-file";

const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});
let directory: string;
const file = {
  id: "00000000-0000-4000-8000-000000000028",
  filename: "report.pdf",
  contentType: "application/pdf",
  size: 8,
  url: "http://localhost:3000/artifacts/abc123def4.pdf",
};
let uploadedBytes: Uint8Array | undefined;
beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_APP_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_TOKEN", "test-token");
  uploadWhatsappFileCommand.setOptionValue("json", undefined);
  uploadWhatsappFileCommand.setOptionValue("text", undefined);
  uploadWhatsappFileCommand.setOptionValue("to", "me");
  directory = mkdtempSync(join(tmpdir(), "whatsapp-file-"));
  writeFileSync(join(directory, file.filename), "%PDF-1.7");
  uploadedBytes = undefined;
  server.use(
    http.post(
      "http://localhost:3000/api/uploads/prepare/private",
      async ({ request }) => {
        expect(await request.json()).toMatchObject({
          filename: file.filename,
          purpose: "artifact",
          requirePrivateArtifact: true,
        });
        return HttpResponse.json({
          ...file,
          uploadUrl: "https://storage.test/put",
        });
      },
    ),
    http.put("https://storage.test/put", async ({ request }) => {
      uploadedBytes = new Uint8Array(await request.arrayBuffer());
      return new HttpResponse(null, { status: 200 });
    }),
    http.post("http://localhost:3000/api/uploads/complete", () => {
      return HttpResponse.json(file);
    }),
  );
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("uploads private bytes and prints the WhatsApp file receipt", async () => {
  let body: unknown;
  server.use(
    http.post(
      "http://localhost:3000/api/integrations/whatsapp/files",
      async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          channel: "whatsapp",
          toNumber: "+4915123456789",
          messages: [{ id: "file-receipt" }],
          file,
        });
      },
    ),
  );
  await whatsappCommand.parseAsync([
    "node",
    "cli",
    "upload-file",
    "-f",
    join(directory, file.filename),
    "-t",
    "Your report",
    "--json",
  ]);
  expect(body).toStrictEqual({ fileId: file.id, caption: "Your report" });
  expect(uploadedBytes).toStrictEqual(new Uint8Array(Buffer.from("%PDF-1.7")));
  expect(JSON.parse(output.mock.calls.flat().join("\n"))).toMatchObject({
    integration: "whatsapp",
    messages: [{ id: "file-receipt", url: null }],
    file: { name: file.filename, url: file.url },
  });
});

it("retains the uploaded artifact in JSON when WhatsApp delivery is unknown", async () => {
  let attempts = 0;
  server.use(
    http.post("http://localhost:3000/api/integrations/whatsapp/files", () => {
      attempts += 1;
      return HttpResponse.json(
        {
          file,
          delivery: "unknown",
          error: {
            code: "WHATSAPP_SEND_FAILED",
            message: "Do not retry automatically",
          },
        },
        { status: 502 },
      );
    }),
  );
  await expect(
    whatsappCommand.parseAsync([
      "node",
      "cli",
      "upload-file",
      "-f",
      join(directory, file.filename),
      "--json",
    ]),
  ).rejects.toThrow("process.exit called");
  expect(attempts).toBe(1);
  expect(JSON.parse(output.mock.calls.flat().join("\n"))).toMatchObject({
    integration: "whatsapp",
    messages: [],
    delivery: "unknown",
    file: { id: file.id, name: file.filename, url: file.url },
    error: { code: "WHATSAPP_SEND_FAILED" },
  });
});

it("retains the uploaded artifact when the connection disappears before delivery", async () => {
  server.use(
    http.post("http://localhost:3000/api/integrations/whatsapp/files", () => {
      return HttpResponse.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "No supported WhatsApp account is connected",
          },
        },
        { status: 404 },
      );
    }),
  );
  await expect(
    whatsappCommand.parseAsync([
      "node",
      "cli",
      "upload-file",
      "-f",
      join(directory, file.filename),
      "--json",
    ]),
  ).rejects.toThrow("process.exit called");
  expect(JSON.parse(output.mock.calls.flat().join("\n"))).toMatchObject({
    delivery: "failed",
    file: { id: file.id, name: file.filename, url: file.url },
    error: { code: "NOT_FOUND" },
  });
});

it.each(["lost", "server-error"])(
  "retains the uploaded artifact when the send response is %s",
  async (outcome) => {
    let attempts = 0;
    server.use(
      http.post("http://localhost:3000/api/integrations/whatsapp/files", () => {
        attempts += 1;
        return outcome === "lost"
          ? HttpResponse.error()
          : HttpResponse.json(
              {
                error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
              },
              { status: 500 },
            );
      }),
    );
    await expect(
      whatsappCommand.parseAsync([
        "node",
        "cli",
        "upload-file",
        "-f",
        join(directory, file.filename),
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(attempts).toBe(1);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toMatchObject({
      delivery: "unknown",
      file: { id: file.id, url: file.url },
    });
  },
);

it("rejects arbitrary WhatsApp recipients before uploading", async () => {
  await expect(
    whatsappCommand.parseAsync([
      "node",
      "cli",
      "upload-file",
      "-f",
      join(directory, file.filename),
      "--to",
      "+12025550123",
    ]),
  ).rejects.toThrow("process.exit called");
  expect(uploadedBytes).toBeUndefined();
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("independently verified WhatsApp account"),
  );
});
