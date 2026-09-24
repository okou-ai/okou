import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { MAX_DISCORD_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-discord-files";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../upload-file";

const API = "http://localhost:3000/api/integrations/discord/upload-file";
const UPLOAD_URL = "https://storage.example.com/canonical-file?signature=test";
const OPERATION_ID = "2269e9e5-4984-4cf5-a5a1-88070bd42197";
const ASSET_ID = "5c035e8d-7ea3-4e58-ad97-b3d659b19bb4";
const CHANNEL_ID = "123456789012345678";
const GUILD_ID = "123456789012345677";
const MESSAGE_ID = "123456789012345679";
const ATTACHMENT_ID = "123456789012345680";
const CANONICAL_URL = `/artifacts/${ASSET_ID.replaceAll("-", "")}.txt`;
const PERMALINK = `https://discord.com/channels/123456789012345677/${CHANNEL_ID}/${MESSAGE_ID}`;
const PUBLISHED = {
  assetId: ASSET_ID,
  operationId: OPERATION_ID,
  url: CANONICAL_URL,
};
const DELIVERED = {
  ...PUBLISHED,
  delivery: {
    status: "delivered",
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    attachmentId: ATTACHMENT_ID,
    permalink: PERMALINK,
  },
};

describe("okou discord upload-file", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    directory = mkdtempSync(join(tmpdir(), "discord-upload-test-"));
    filePath = join(directory, "report.txt");
    writeFileSync(filePath, "Weekly report");
    for (const option of [
      "file",
      "channel",
      "guildId",
      "comment",
      "contentType",
      "operationId",
    ]) {
      uploadFileCommand.setOptionValue(option, undefined);
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function upload(extra: readonly string[] = []) {
    return uploadFileCommand.parseAsync([
      "node",
      "okou",
      "--file",
      filePath,
      "--channel",
      CHANNEL_ID,
      "--operation-id",
      OPERATION_ID,
      ...extra,
    ]);
  }

  it("publishes canonical bytes before server delivery and returns stable references", async () => {
    let storedContent: string | undefined;
    let published = false;
    server.use(
      http.post(`${API}/init`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-okou-token",
        );
        expect(await request.json()).toEqual({
          filename: "report.txt",
          length: 13,
          contentType: "text/plain",
          checksumSha256: createHash("sha256")
            .update("Weekly report")
            .digest("hex"),
          operationId: OPERATION_ID,
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          comment: "A weekly update",
        });
        return HttpResponse.json({
          ...PUBLISHED,
          uploadUrl: UPLOAD_URL,
          uploadHeaders: { "x-amz-meta-checksum": "checksum" },
        });
      }),
      http.put(UPLOAD_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        expect(request.headers.get("content-type")).toBe("text/plain");
        expect(request.headers.get("x-amz-meta-checksum")).toBe("checksum");
        storedContent = await request.text();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${API}/materialize`, async ({ request }) => {
        expect(storedContent).toBe("Weekly report");
        expect(await request.json()).toEqual({
          assetId: ASSET_ID,
          operationId: OPERATION_ID,
        });
        published = true;
        return HttpResponse.json({
          ...PUBLISHED,
          delivery: { status: "pending" },
        });
      }),
      http.post(`${API}/complete`, async ({ request }) => {
        expect(published).toBe(true);
        expect(await request.json()).toEqual({
          assetId: ASSET_ID,
          operationId: OPERATION_ID,
        });
        return HttpResponse.json(DELIVERED);
      }),
    );

    await upload([
      "--guild-id",
      GUILD_ID,
      "--comment",
      "A weekly update",
      "--content-type",
      "TEXT/PLAIN; charset=utf-8",
    ]);

    expect(output).toHaveBeenCalledWith(JSON.stringify(DELIVERED));
  });

  it("recovers a lost delivery response with the same operation and no second upload", async () => {
    let externallyDelivered = false;
    server.use(
      http.post(`${API}/init`, async ({ request }) => {
        expect(await request.json()).toMatchObject({
          operationId: OPERATION_ID,
        });
        return HttpResponse.json(PUBLISHED);
      }),
      http.post(`${API}/materialize`, () => {
        return HttpResponse.json(
          externallyDelivered
            ? DELIVERED
            : { ...PUBLISHED, delivery: { status: "pending" } },
        );
      }),
      http.post(`${API}/complete`, () => {
        if (externallyDelivered) throw new Error("File was delivered twice");
        externallyDelivered = true;
        return HttpResponse.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Delivery acknowledgement lost",
            },
          },
          { status: 502 },
        );
      }),
    );

    await expect(upload()).rejects.toThrow("process.exit called");
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ ...PUBLISHED, delivery: { status: "pending" } }),
    );
    expect(warnings.mock.calls.flat().join("\n")).toContain(
      `--operation-id ${OPERATION_ID}`,
    );

    await upload();
    expect(output).toHaveBeenLastCalledWith(JSON.stringify(DELIVERED));
  });

  it("retains canonical publication when Discord delivery fails", async () => {
    const failed = {
      ...PUBLISHED,
      delivery: {
        status: "failed",
        message: "Discord rate limited delivery",
        retryable: true,
        retryAfterSeconds: 60,
      },
    };
    server.use(
      http.post(`${API}/init`, () => {
        return HttpResponse.json(PUBLISHED);
      }),
      http.post(`${API}/materialize`, () => {
        return HttpResponse.json({
          ...PUBLISHED,
          delivery: { status: "pending" },
        });
      }),
      http.post(`${API}/complete`, () => {
        return HttpResponse.json(failed);
      }),
    );

    await upload();

    expect(output).toHaveBeenCalledWith(JSON.stringify(failed));
    expect(warnings.mock.calls.flat().join("\n")).toContain(
      "Discord rate limited delivery",
    );
    expect(warnings).toHaveBeenCalledWith(
      `Retry after 60 seconds with --operation-id ${OPERATION_ID}`,
    );
    expect(warnings.mock.calls.flat().join("\n")).toContain(
      `--operation-id ${OPERATION_ID}`,
    );
  });

  it("asks the server to reconcile a persisted uncertain delivery on retry", async () => {
    server.use(
      http.post(`${API}/init`, () => {
        return HttpResponse.json(PUBLISHED);
      }),
      http.post(`${API}/materialize`, () => {
        return HttpResponse.json({
          ...PUBLISHED,
          delivery: {
            status: "failed",
            message: "Delivery outcome is uncertain; retry to reconcile it",
            retryable: false,
          },
        });
      }),
      http.post(`${API}/complete`, async ({ request }) => {
        expect(await request.json()).toEqual({
          assetId: ASSET_ID,
          operationId: OPERATION_ID,
        });
        return HttpResponse.json(DELIVERED);
      }),
    );

    await upload();

    expect(output).toHaveBeenCalledWith(JSON.stringify(DELIVERED));
  });

  it("reports its generated operation ID when initialization fails", async () => {
    server.use(
      http.post(`${API}/init`, async ({ request }) => {
        const body: unknown = await request.json();
        expect(body).toMatchObject({ operationId: expect.any(String) });
        if (
          typeof body !== "object" ||
          body === null ||
          !("operationId" in body)
        ) {
          throw new Error("Expected operation ID");
        }
        expect(warnings.mock.calls.flat().join("\n")).toContain(
          String(body.operationId),
        );
        return HttpResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Discord feature is disabled",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(
      uploadFileCommand.parseAsync([
        "node",
        "okou",
        "-f",
        filePath,
        "-c",
        CHANNEL_ID,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Discord feature is disabled",
    );
    expect(output).not.toHaveBeenCalled();
  });

  it("stops before materialization when canonical storage rejects the bytes", async () => {
    server.use(
      http.post(`${API}/init`, () => {
        return HttpResponse.json({ ...PUBLISHED, uploadUrl: UPLOAD_URL });
      }),
      http.put(UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 403 });
      }),
    );

    await expect(upload()).rejects.toThrow("process.exit called");

    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Canonical file upload failed (HTTP 403)",
    );
    expect(warnings.mock.calls.flat().join("\n")).toContain(
      `--operation-id ${OPERATION_ID}`,
    );
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects oversized local files before an upload is initialized", async () => {
    writeFileSync(filePath, Buffer.alloc(MAX_DISCORD_FILE_SIZE_BYTES + 1));

    await expect(upload()).rejects.toThrow("process.exit called");

    expect(errors.mock.calls.flat().join("\n")).toContain("10 MiB limit");
  });

  it("rejects a filename with control characters before any network request", async () => {
    filePath = join(directory, "report\n.txt");
    writeFileSync(filePath, "A report");

    await expect(upload()).rejects.toThrow("process.exit called");

    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Filename must not contain",
    );
  });
});
