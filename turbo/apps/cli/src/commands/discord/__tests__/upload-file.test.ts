import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { MAX_DISCORD_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-discord-files";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../upload-file";

const API = "http://localhost:3000/api/integrations/discord/upload-file";
const UPLOAD_URL = "https://storage.example.com/canonical-file?signature=test";
const ASSET_ID = "5c035e8d-7ea3-4e58-ad97-b3d659b19bb4";
const CHANNEL_ID = "123456789012345678";
const GUILD_ID = "123456789012345677";
const MESSAGE_ID = "123456789012345679";
const ATTACHMENT_ID = "123456789012345680";
const CANONICAL_URL = `/artifacts/${ASSET_ID.replaceAll("-", "")}.txt`;
const PERMALINK = `https://discord.com/channels/123456789012345677/${CHANNEL_ID}/${MESSAGE_ID}`;
const INITIALIZED = {
  assetId: ASSET_ID,
  url: CANONICAL_URL,
  uploadUrl: UPLOAD_URL,
  uploadHeaders: { "x-amz-meta-checksum": "checksum" },
};
const DELIVERED = {
  assetId: ASSET_ID,
  url: CANONICAL_URL,
  delivery: {
    status: "delivered",
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    attachmentId: ATTACHMENT_ID,
    permalink: PERMALINK,
  },
};

function envelope(
  delivery: Readonly<Record<string, unknown>>,
  messages: readonly { id: string; url: string }[] = [],
) {
  return {
    integration: "discord",
    chatId: CHANNEL_ID,
    messages,
    file: {
      name: "report.txt",
      contentType: "text/plain",
      size: 13,
      url: CANONICAL_URL,
    },
    delivery,
  };
}
const DELIVERED_ENVELOPE = envelope({ status: "delivered" }, [
  { id: MESSAGE_ID, url: PERMALINK },
]);

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
      "to",
      "guildId",
      "text",
      "contentType",
      "json",
    ]) {
      uploadFileCommand.setOptionValue(option, undefined);
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function printedJson(): unknown {
    return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  }

  function upload(extra: readonly string[] = []) {
    return uploadFileCommand.parseAsync([
      "node",
      "okou",
      "--file",
      filePath,
      "--to",
      CHANNEL_ID,
      ...extra,
    ]);
  }

  it.each(["me", `user:${CHANNEL_ID}`])(
    "addresses an uploaded file to DM recipient %s",
    async (target) => {
      let initBody: unknown;
      let completeBody: unknown;
      server.use(
        http.post(`${API}/init`, async ({ request }) => {
          initBody = await request.json();
          return HttpResponse.json(INITIALIZED);
        }),
        http.put(UPLOAD_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(`${API}/complete`, async ({ request }) => {
          completeBody = await request.json();
          return HttpResponse.json(DELIVERED);
        }),
      );
      await upload(["--to", target, "--json"]);
      const expectedUser = target === "me" ? "me" : CHANNEL_ID;
      expect(initBody).toMatchObject({ userId: expectedUser });
      expect(initBody).not.toHaveProperty("channelId");
      expect(completeBody).toStrictEqual({
        assetId: ASSET_ID,
        userId: expectedUser,
      });
    },
  );

  it("publishes canonical bytes before server delivery and returns stable references", async () => {
    let storedContent: string | undefined;
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
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          comment: "A weekly update",
        });
        return HttpResponse.json(INITIALIZED);
      }),
      http.put(UPLOAD_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        expect(request.headers.get("content-type")).toBe("text/plain");
        expect(request.headers.get("x-amz-meta-checksum")).toBe("checksum");
        storedContent = await request.text();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${API}/complete`, async ({ request }) => {
        expect(storedContent).toBe("Weekly report");
        expect(await request.json()).toEqual({
          assetId: ASSET_ID,
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          comment: "A weekly update",
        });
        return HttpResponse.json(DELIVERED);
      }),
    );

    await upload([
      "--guild-id",
      GUILD_ID,
      "--text",
      "A weekly update",
      "--content-type",
      "TEXT/PLAIN; charset=utf-8",
      "--json",
    ]);

    expect(output).toHaveBeenCalledOnce();
    expect(printedJson()).toStrictEqual(DELIVERED_ENVELOPE);
  });

  it("retains canonical publication when Discord delivery fails", async () => {
    const failed = {
      assetId: ASSET_ID,
      url: CANONICAL_URL,
      delivery: {
        status: "failed",
        message: "Discord rate limited delivery",
      },
    };
    server.use(
      http.post(`${API}/init`, () => {
        return HttpResponse.json(INITIALIZED);
      }),
      http.put(UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${API}/complete`, () => {
        return HttpResponse.json(failed);
      }),
    );

    await upload();

    const printed = output.mock.calls.flat().join("\n");
    expect(printed).toContain("✓ File uploaded");
    expect(printed).toContain(`chat: ${CHANNEL_ID}`);
    expect(printed).toContain(`url: ${CANONICAL_URL}`);
    expect(printed).toContain("delivery: failed");
    expect(warnings).toHaveBeenLastCalledWith(
      "Discord delivery failed: Discord rate limited delivery",
    );
  });

  it("exits when initialization fails", async () => {
    server.use(
      http.post(`${API}/init`, () => {
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
        "--to",
        CHANNEL_ID,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Discord feature is disabled",
    );
    expect(warnings).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it("stops before completion when canonical storage rejects the bytes", async () => {
    server.use(
      http.post(`${API}/init`, () => {
        return HttpResponse.json(INITIALIZED);
      }),
      http.put(UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 403 });
      }),
    );

    await expect(upload()).rejects.toThrow("process.exit called");

    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Canonical file upload failed (HTTP 403)",
    );
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects oversized local files before an upload is initialized", async () => {
    truncateSync(filePath, MAX_DISCORD_FILE_SIZE_BYTES + 1);

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
