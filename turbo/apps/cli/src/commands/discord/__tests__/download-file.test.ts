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

  it("downloads authenticated attachment bytes and prints their actual size", async () => {
    writeFileSync(outPath, "Previous file");
    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
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
