import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { registerRequestedCommand } from "../../../okou";
import { uploadFileCommand } from "../upload-file";
import { downloadFileCommand } from "../download-file";
const origin = "http://localhost:3000/api/integrations/wechat";
const channelId = randomUUID();
const binding = {
  workspace: { id: "org_team", name: "Operations" },
  accountId: "scanner-owner",
};
const messageId = randomUUID();
const assetId = randomUUID();
const operationId = randomUUID();
const url = `https://app.okou.ai/artifacts/${assetId}`;
async function run(args: string[]) {
  const argv = ["node", "okou", "wechat", ...args];
  const program = new Command();
  await registerRequestedCommand(program, argv);
  await program.parseAsync(argv);
}
describe("okou wechat files", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "wechat-cli-"));
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const command of [uploadFileCommand, downloadFileCommand]) {
      for (const name of [
        "file",
        "to",
        "text",
        "contentType",
        "operationId",
        "json",
        "channel",
        "message",
        "out",
      ])
        command.setOptionValue(name, undefined);
    }
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it.each([channelId, "me"])(
    "publishes to %s before delivery and prints a receipt without an invented URL",
    async (target) => {
      const path = join(directory, "report.csv");
      await writeFile(path, "a,b\n1,2\n");
      const calls: string[] = [];
      server.use(
        http.get(`${origin}/channels`, () => {
          return HttpResponse.json({
            channels: [
              { id: channelId, name: "WeChat", status: "active", binding },
            ],
          });
        }),
        http.post(`${origin}/upload-file/init`, async ({ request }) => {
          calls.push("init");
          expect(await request.json()).toMatchObject({
            filename: "report.csv",
            length: 8,
            contentType: "text/csv",
            channelId,
            operationId,
          });
          return HttpResponse.json({
            assetId,
            operationId,
            url,
            uploadUrl: "https://storage.example/upload",
          });
        }),
        http.put("https://storage.example/upload", async ({ request }) => {
          calls.push("put");
          expect(request.headers.has("authorization")).toBe(false);
          expect(await request.text()).toBe("a,b\n1,2\n");
          return new HttpResponse(null);
        }),
        http.post(`${origin}/upload-file/materialize`, () => {
          calls.push("materialize");
          return HttpResponse.json({
            assetId,
            operationId,
            url,
            delivery: { status: "pending" },
          });
        }),
        http.post(`${origin}/upload-file/complete`, () => {
          calls.push("complete");
          return HttpResponse.json({
            assetId,
            operationId,
            url,
            delivery: {
              status: "delivered",
              channelId,
              messageId,
              permalink: null,
            },
          });
        }),
      );
      await run([
        "upload-file",
        "--file",
        path,
        "--to",
        target,
        "--operation-id",
        operationId,
        "--json",
      ]);
      expect(calls).toStrictEqual(["init", "put", "materialize", "complete"]);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
        integration: "wechat",
        messages: [{ id: messageId, url: null }],
        file: { url },
        delivery: { status: "delivered", operationId },
      });
    },
  );
  it("preserves a published file when delivery is unconfirmed", async () => {
    const path = join(directory, "report.txt");
    await writeFile(path, "hello");
    server.use(
      http.post(`${origin}/upload-file/init`, () => {
        return HttpResponse.json({ assetId, operationId, url });
      }),
      http.post(`${origin}/upload-file/materialize`, () => {
        return HttpResponse.json({
          assetId,
          operationId,
          url,
          delivery: { status: "pending" },
        });
      }),
      http.post(`${origin}/upload-file/complete`, () => {
        return HttpResponse.json({
          assetId,
          operationId,
          url,
          delivery: {
            status: "failed",
            message: "Delivery unknown",
            retryable: false,
          },
        });
      }),
    );
    await run([
      "upload-file",
      "--file",
      path,
      "--to",
      channelId,
      "--operation-id",
      operationId,
      "--json",
    ]);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      messages: [],
      file: { url },
      delivery: { status: "failed", error: "Delivery unknown", operationId },
    });
  });
  it.each([
    { "Content-Length": "5" },
    {},
    { "Content-Length": "25", "Content-Encoding": "gzip" },
  ])("downloads through the API with response framing %j", async (framing) => {
    const path = join(directory, "report.txt");
    server.use(
      http.get(`${origin}/download-file`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(
          Object.fromEntries(new URL(request.url).searchParams),
        ).toStrictEqual({ channelId, messageId, attachmentId: "0" });
        return new HttpResponse(
          "Content-Encoding" in framing
            ? new Uint8Array(gzipSync("hello"))
            : "hello",
          {
            headers: {
              "Content-Type": "application/octet-stream",
              ...framing,
            },
          },
        );
      }),
    );
    await run([
      "download-file",
      "0",
      "--channel",
      channelId,
      "--message",
      messageId,
      "--out",
      path,
    ]);
    expect(await readFile(path, "utf8")).toBe("hello");
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      path,
      mimetype: "application/octet-stream",
      size: 5,
    });
  });
  it("bounds chunked downloads and preserves the previous file on overflow", async () => {
    const path = join(directory, "report.txt");
    await writeFile(path, "original");
    server.use(
      http.get(`${origin}/download-file`, () => {
        return new HttpResponse(new Uint8Array(10 * 1024 * 1024 + 1), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );
    await expect(
      run([
        "download-file",
        "0",
        "--channel",
        channelId,
        "--message",
        messageId,
        "--out",
        path,
      ]),
    ).rejects.toThrow("process.exit");
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(directory)).toStrictEqual(["report.txt"]);
  });
  it("keeps an existing output when download is truncated", async () => {
    const path = join(directory, "report.txt");
    await writeFile(path, "original");
    server.use(
      http.get(`${origin}/download-file`, () => {
        return new HttpResponse("short", {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "10",
          },
        });
      }),
    );
    await expect(
      run([
        "download-file",
        "0",
        "--channel",
        channelId,
        "--message",
        messageId,
        "--out",
        path,
      ]),
    ).rejects.toThrow("process.exit");
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(directory)).toStrictEqual(["report.txt"]);
    expect(output).not.toHaveBeenCalled();
  });
});
