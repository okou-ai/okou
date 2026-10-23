import {
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
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";

const FILE_URL =
  "http://localhost:3000/api/integrations/discord/download-file/url";
const CHANNEL_ID = "123456789012345678";
const GUILD_ID = "123456789012345677";
const MESSAGE_ID = "123456789012345679";
const ATTACHMENT_ID = "123456789012345680";

describe("okou discord download-file", () => {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
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

  it.each([
    {
      body: "Discord attachment",
      metadataType: "text/plain",
      responseType: "application/octet-stream",
    },
    { body: "", metadataType: "text/plain", responseType: "text/plain" },
    {
      body: "Native attachment",
      metadataType: "application/octet-stream",
      responseType: "text/plain",
    },
  ])(
    "saves an authorized attachment with provider metadata: %j",
    async ({ body, metadataType, responseType }) => {
      writeFileSync(outPath, "Previous file");
      const attachmentUrl = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/download.txt?hm=signed`;
      server.use(
        http.get(FILE_URL, ({ request }) => {
          expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual(
            {
              channelId: CHANNEL_ID,
              messageId: MESSAGE_ID,
              attachmentId: ATTACHMENT_ID,
              guildId: GUILD_ID,
            },
          );
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-okou-token",
          );
          return HttpResponse.json({
            downloadUrl: attachmentUrl,
            filename: "download.txt",
            contentType: metadataType,
            size: body.length,
          });
        }),
        http.get(attachmentUrl, () => {
          return new HttpResponse(body, {
            headers: {
              "content-type": responseType,
              "content-length": String(body.length),
            },
          });
        }),
      );
      await downloadFileCommand.parseAsync([
        "node",
        "okou",
        ATTACHMENT_ID,
        "-c",
        CHANNEL_ID,
        "-m",
        MESSAGE_ID,
        "--guild-id",
        GUILD_ID,
        "-o",
        outPath,
      ]);
      expect(readFileSync(outPath, "utf8")).toBe(body);
      expect(readdirSync(directory)).toEqual(["download.txt"]);
      expect(output).toHaveBeenCalledWith(
        JSON.stringify({
          path: outPath,
          mimetype: "text/plain",
          size: body.length,
        }),
      );
    },
  );
});
