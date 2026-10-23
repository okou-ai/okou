/**
 * Exercise both download commands through their parser, real HTTP client,
 * response streaming, and filesystem. Only the HTTP boundary is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import { artifactCommand } from "../../artifact";
import chalk from "chalk";

const API = "http://localhost:3000";
const FILE_URL = `${API}/api/web/file-url`;
const READ_URL = `${API}/api/artifact-references/:reference/download`;
const DELIVERY_URL = "https://delivery.example.com/content?signature=temporary";
const FILE_ID = "00000000-0000-4000-8000-000000000023";

describe.each([
  { name: "okou web download-file", command: downloadFileCommand, prefix: [] },
  {
    name: "okou artifact download",
    command: artifactCommand,
    prefix: ["download"],
  },
])("$name", ({ command, prefix }) => {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  let tmpDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", API);
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    tmpDir = mkdtempSync(join(tmpdir(), "web-download-test-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockConsoleLog.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "owned file with an extensionless short reference",
      input: "/artifacts/abcxyz1234",
      reference: "abcxyz1234",
      filename: "result.txt",
      contentType: "text/plain",
    },
    {
      name: "organization file with a short reference",
      input: "/artifacts/a1b2c3d4e5.txt",
      reference: "a1b2c3d4e5.txt",
      filename: "result.txt",
      contentType: "text/plain",
    },
    {
      name: "public file with an absolute long reference and fragment",
      input:
        "https://app.okou.ai/artifacts/00000000000040008000000000000023.txt#detail",
      reference: "00000000000040008000000000000023.txt",
      filename: "result.txt",
      contentType: "text/plain",
    },
    {
      name: "owned standalone HTML file with a long reference and fragment",
      input: "/artifacts/00000000000040008000000000000002.html#slide-2",
      reference: "00000000000040008000000000000002.html",
      filename: "index.html",
      contentType: "text/html",
    },
    {
      name: "organization standalone HTML file with an absolute short reference and fragment",
      input: "https://app.okou.ai/artifacts/htmlread01.html#slide-2",
      reference: "htmlread01.html",
      filename: "index.html",
      contentType: "text/html",
    },
    {
      name: "public standalone HTML file with a short reference",
      input: "/artifacts/abc123def4.html",
      reference: "abc123def4.html",
      filename: "index.html",
      contentType: "text/html",
    },
    {
      name: "a shared CSV file selected from a hosted site",
      input: "/artifacts/csvchild01.csv",
      reference: "csvchild01.csv",
      filename: "results.csv",
      contentType: "text/csv",
    },
  ])(
    "downloads authorized $name",
    async ({ input, reference, filename, contentType }) => {
      const payload = Buffer.from(
        contentType === "text/html"
          ? "<!doctype html><h1>你好</h1>"
          : "hello world",
      );
      const outPath = join(tmpDir, filename);

      server.use(
        http.get(READ_URL, ({ params, request }) => {
          expect(params.reference).toBe(reference);
          expect(new URL(request.url).search).toBe("");
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            kind: "file",
            url: DELIVERY_URL,
            filename,
            contentType,
          });
        }),
        http.get("https://delivery.example.com/content", ({ request }) => {
          expect(request.url).toBe(DELIVERY_URL);
          return new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(payload.subarray(0, 8));
                controller.enqueue(payload.subarray(8));
                controller.close();
              },
            }),
          );
        }),
      );

      await command.parseAsync([
        "node",
        "cli",
        ...prefix,
        input,
        "-o",
        outPath,
      ]);

      expect(readFileSync(outPath)).toEqual(payload);
      expect(JSON.parse(mockConsoleLog.mock.calls.flat().join("\n"))).toEqual({
        path: outPath,
        mimetype: contentType,
        size: payload.length,
      });
    },
  );

  it.each([FILE_ID, `${FILE_URL}?file_id=${FILE_ID}`])(
    "downloads a web file from %s",
    async (input) => {
      const outPath = join(tmpDir, "direct.pdf");
      const payload = Buffer.from("direct PDF bytes");
      server.use(
        http.get(FILE_URL, ({ request }) => {
          expect(new URL(request.url).searchParams.get("file_id")).toBe(
            FILE_ID,
          );
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            url: DELIVERY_URL,
            downloadUrl: DELIVERY_URL,
            expiresAt: "2026-10-23T15:00:00.000Z",
            publicUrl: null,
          });
        }),
        http.get("https://delivery.example.com/content", () => {
          return new HttpResponse(payload, {
            headers: {
              "content-type": "application/pdf",
              "content-length": String(payload.length),
            },
          });
        }),
      );
      await command.parseAsync([
        "node",
        "cli",
        ...prefix,
        input,
        "-o",
        outPath,
      ]);
      expect(readFileSync(outPath)).toEqual(payload);
      expect(JSON.parse(mockConsoleLog.mock.calls.flat().join("\n"))).toEqual({
        path: outPath,
        mimetype: "application/pdf",
        size: payload.length,
      });
    },
  );

  it("derives the default output path when -o is omitted", async () => {
    const id = `default-${tmpDir.split("/").at(-1)}`;
    const outPath = join(tmpdir(), `web-${id}`);
    server.use(
      http.get(FILE_URL, () => {
        return HttpResponse.json({
          url: DELIVERY_URL,
          downloadUrl: DELIVERY_URL,
          expiresAt: "2026-10-23T15:00:00.000Z",
          publicUrl: null,
        });
      }),
      http.get("https://delivery.example.com/content", () => {
        return new HttpResponse("default-path", {
          headers: { "content-type": "application/octet-stream" },
        });
      }),
    );
    try {
      await command.parseAsync(["node", "okou", ...prefix, id]);
      expect(readFileSync(outPath, "utf8")).toBe("default-path");
      expect(JSON.parse(mockConsoleLog.mock.calls.flat().join("\n"))).toEqual({
        path: outPath,
        mimetype: "application/octet-stream",
        size: 12,
      });
    } finally {
      rmSync(outPath, { force: true });
    }
  });
});
