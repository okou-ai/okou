import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { MAX_DISCORD_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-discord-files";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";

const DOWNLOAD_URL =
  "http://localhost:3000/api/integrations/discord/download-file";
const CHANNEL_ID = "123456789012345678";
const GUILD_ID = "123456789012345677";
const MESSAGE_ID = "123456789012345679";
const ATTACHMENT_ID = "123456789012345680";

describe("okou discord download-file", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  let directory: string;
  let outPath: string;

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    directory = mkdtempSync(join(tmpdir(), "discord-download-test-"));
    outPath = join(directory, "download.txt");
    // Independently deployed old APIs have only the binary endpoint.
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }),
    );
    for (const option of ["channel", "message", "guildId", "out"]) {
      downloadFileCommand.setOptionValue(option, undefined);
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function download(
    attachmentId = ATTACHMENT_ID,
    extra: readonly string[] = [],
  ) {
    return downloadFileCommand.parseAsync([
      "node",
      "okou",
      attachmentId,
      "-c",
      CHANNEL_ID,
      "-m",
      MESSAGE_ID,
      "-o",
      outPath,
      ...extra,
    ]);
  }

  it("downloads direct attachment bytes without forwarding API credentials", async () => {
    writeFileSync(outPath, "Previous file");
    const attachmentUrl = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/download.txt?hm=signed`;
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, ({ request }) => {
        const url = new URL(request.url);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          attachmentId: ATTACHMENT_ID,
          guildId: GUILD_ID,
        });
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-okou-token",
        );
        return HttpResponse.json({
          downloadUrl: attachmentUrl,
          filename: "download.txt",
          contentType: "text/plain",
          size: 18,
        });
      }),
      http.get(attachmentUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        return new HttpResponse("Discord attachment", {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": "18",
          },
        });
      }),
    );

    await download(ATTACHMENT_ID, ["--guild-id", GUILD_ID]);

    expect(readFileSync(outPath, "utf8")).toBe("Discord attachment");
    expect(readdirSync(directory)).toEqual(["download.txt"]);
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ path: outPath, mimetype: "text/plain", size: 18 }),
    );
  });

  it.each([
    { status: 403, code: "FORBIDDEN", message: "Discord read access denied" },
    {
      status: 404,
      code: "NOT_FOUND",
      message: "Discord attachment unavailable",
    },
  ])(
    "does not fall back after metadata access failure $status",
    async ({ status, code, message }) => {
      writeFileSync(outPath, "Keep this file");
      let binaryDownloads = 0;
      server.use(
        http.get(`${DOWNLOAD_URL}/url`, () => {
          return HttpResponse.json({ error: { code, message } }, { status });
        }),
        http.get(DOWNLOAD_URL, () => {
          binaryDownloads += 1;
          return new HttpResponse("must not download");
        }),
      );

      await expect(download()).rejects.toThrow("process.exit called");

      expect(readFileSync(outPath, "utf8")).toBe("Keep this file");
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(binaryDownloads).toBe(0);
    },
  );

  it("uses the byte route when direct MIME validation is unavailable", async () => {
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "DIRECT_DOWNLOAD_UNAVAILABLE",
              message: "CDN MIME validation required",
            },
          },
          { status: 409 },
        );
      }),
      http.get(DOWNLOAD_URL, () => {
        return new HttpResponse("validated", {
          headers: { "content-type": "text/plain", "content-length": "9" },
        });
      }),
    );

    await download();

    expect(readFileSync(outPath, "utf8")).toBe("validated");
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ path: outPath, mimetype: "text/plain", size: 9 }),
    );
  });

  it.each([
    { size: 5, length: "5", body: "Four" },
    { size: 3, length: "3", body: "Four" },
    { size: MAX_DISCORD_FILE_SIZE_BYTES + 1, length: "4", body: "Four" },
  ])(
    "preserves the destination when the direct body violates its size contract: %j",
    async ({ size, length, body }) => {
      writeFileSync(outPath, "Keep this file");
      const attachmentUrl = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/download.txt?hm=signed`;
      server.use(
        http.get(`${DOWNLOAD_URL}/url`, () => {
          return HttpResponse.json({
            downloadUrl: attachmentUrl,
            filename: "download.txt",
            contentType: "text/plain",
            size,
          });
        }),
        http.get(attachmentUrl, () => {
          return new HttpResponse(body, {
            headers: { "content-type": "text/plain", "content-length": length },
          });
        }),
      );

      await expect(download()).rejects.toThrow("process.exit called");

      expect(readFileSync(outPath, "utf8")).toBe("Keep this file");
      expect(readdirSync(directory)).toEqual(["download.txt"]);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("preserves declared attachment MIME when the CDN returns generic octet-stream", async () => {
    const attachmentUrl = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/download.txt?hm=signed`;
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({
          downloadUrl: attachmentUrl,
          filename: "download.txt",
          contentType: "text/plain",
          size: 4,
        });
      }),
      http.get(attachmentUrl, () => {
        return new HttpResponse("Four", {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "4",
          },
        });
      }),
    );

    await download();

    expect(readFileSync(outPath, "utf8")).toBe("Four");
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ path: outPath, mimetype: "text/plain", size: 4 }),
    );
  });

  it("rejects CDN MIME conflicting with Discord attachment metadata", async () => {
    writeFileSync(outPath, "Keep this file");
    const attachmentUrl = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/download.txt?hm=signed`;
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({
          downloadUrl: attachmentUrl,
          filename: "download.txt",
          contentType: "text/plain",
          size: 4,
        });
      }),
      http.get(attachmentUrl, () => {
        return new HttpResponse("Four", {
          headers: { "content-type": "image/png", "content-length": "4" },
        });
      }),
    );

    await expect(download()).rejects.toThrow("process.exit called");

    expect(readFileSync(outPath, "utf8")).toBe("Keep this file");
    expect(readdirSync(directory)).toEqual(["download.txt"]);
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary attachment URL without writing a file", async () => {
    await expect(download("https://attacker.example/file")).rejects.toThrow(
      "process.exit called",
    );

    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Expected a Discord snowflake ID",
    );
    expect(existsSync(outPath)).toBe(false);
  });

  it("saves a valid empty native attachment", async () => {
    server.use(
      http.get(DOWNLOAD_URL, () => {
        return new HttpResponse(new Uint8Array(0), {
          headers: { "content-type": "text/plain", "content-length": "0" },
        });
      }),
    );

    await download();

    expect(readFileSync(outPath).byteLength).toBe(0);
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ path: outPath, mimetype: "text/plain", size: 0 }),
    );
  });

  it.each([
    [403, "FORBIDDEN", "You cannot access this Discord message"],
    [404, "NOT_FOUND", "Discord attachment is unavailable"],
  ])(
    "surfaces provider access failure %s without replacing the destination",
    async (status, code, message) => {
      writeFileSync(outPath, "Keep this file");
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return HttpResponse.json({ error: { code, message } }, { status });
        }),
      );

      await expect(download()).rejects.toThrow("process.exit called");

      expect(readFileSync(outPath, "utf8")).toBe("Keep this file");
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it.each([
    { length: "3", body: "Four", message: "exceeds its declared size" },
    { length: "5", body: "Four", message: "download is incomplete" },
    {
      length: String(MAX_DISCORD_FILE_SIZE_BYTES + 1),
      body: "Four",
      message: "10 MiB limit",
    },
  ])(
    "preserves the old destination and removes partial bytes when $message",
    async ({ length, body, message }) => {
      writeFileSync(outPath, "Keep this file");
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return new HttpResponse(body, {
            headers: {
              "content-type": "text/plain",
              "content-length": length,
            },
          });
        }),
      );

      await expect(download()).rejects.toThrow("process.exit called");

      expect(readFileSync(outPath, "utf8")).toBe("Keep this file");
      expect(readdirSync(directory)).toEqual(["download.txt"]);
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("does not follow API redirects carrying the CLI credential", async () => {
    server.use(
      http.get(DOWNLOAD_URL, () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "https://attacker.example/file" },
        });
      }),
    );

    await expect(download()).rejects.toThrow("process.exit called");

    expect(existsSync(outPath)).toBe(false);
    expect(output).not.toHaveBeenCalled();
  });
});
