/**
 * Exercise both download commands through their parser, real HTTP client,
 * response streaming, and filesystem. Only the HTTP boundary is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import { artifactCommand } from "../../artifact";
import chalk from "chalk";

const API = "http://localhost:3000";
const DOWNLOAD_URL = `${API}/api/web/download-file`;
const READ_URL = `${API}/api/artifact-references/:reference/read`;
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
  const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

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
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
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
      name: "owned HTML with a long reference and fragment",
      input: "/artifacts/00000000000040008000000000000002.html#slide-2",
      reference: "00000000000040008000000000000002.html",
      filename: "index.html",
      contentType: "text/html",
    },
    {
      name: "organization HTML with an absolute short reference and fragment",
      input: "https://app.okou.ai/artifacts/htmlread01.html#slide-2",
      reference: "htmlread01.html",
      filename: "index.html",
      contentType: "text/html",
    },
    {
      name: "public HTML with a short reference",
      input: "/artifacts/abc123def4.html",
      reference: "abc123def4.html",
      filename: "index.html",
      contentType: "text/html",
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
            url: DELIVERY_URL,
            filename,
            contentType,
          });
        }),
        http.get("https://delivery.example.com/content", ({ request }) => {
          expect(request.url).toBe(DELIVERY_URL);
          expect(request.headers.get("authorization")).toBeNull();
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

  it("follows artifact delivery redirects without forwarding credentials and preserves the HTTP MIME charset", async () => {
    const outPath = join(tmpDir, "index.html");
    const payload = "<!doctype html><h1>Shared page</h1>";
    server.use(
      http.get(READ_URL, () => {
        return HttpResponse.json({
          url: DELIVERY_URL,
          filename: "index.html",
          contentType: "text/html",
        });
      }),
      http.get("https://delivery.example.com/content", ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        return new HttpResponse(null, {
          status: 302,
          headers: {
            location: "https://cdn.example.com/index.html?sig=delivery",
          },
        });
      }),
      http.get("https://cdn.example.com/index.html", ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(new URL(request.url).searchParams.get("sig")).toBe("delivery");
        return new HttpResponse(payload, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    );

    await command.parseAsync([
      "node",
      "cli",
      ...prefix,
      "/artifacts/abc123def4.html",
      "-o",
      outPath,
    ]);

    expect(readFileSync(outPath, "utf8")).toBe(payload);
    expect(JSON.parse(mockConsoleLog.mock.calls.flat().join("\n"))).toEqual({
      path: outPath,
      mimetype: "text/html; charset=utf-8",
      size: Buffer.byteLength(payload),
    });
  });

  it.each([FILE_ID, `${DOWNLOAD_URL}?file_id=${FILE_ID}`])(
    "preserves authenticated legacy file downloads from %s",
    async (input) => {
      const payload = Buffer.from("legacy file");
      const outPath = join(tmpDir, "report.pdf");
      server.use(
        http.get(DOWNLOAD_URL, ({ request }) => {
          expect(new URL(request.url).searchParams.get("file_id")).toBe(
            FILE_ID,
          );
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return new HttpResponse(payload, {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(payload.length),
              "x-file-mimetype": "application/pdf",
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
    const payload = Buffer.from("default-path");
    const id = `default-${tmpDir.split("/").at(-1)}`;
    const outPath = join(tmpdir(), `web-${id}`);
    server.use(
      http.get(DOWNLOAD_URL, () => {
        return new HttpResponse(payload);
      }),
    );

    try {
      await command.parseAsync(["node", "cli", ...prefix, id]);
      expect(readFileSync(outPath)).toEqual(payload);
      expect(JSON.parse(mockConsoleLog.mock.calls.flat().join("\n"))).toEqual({
        path: outPath,
        mimetype: "application/octet-stream",
        size: payload.length,
      });
    } finally {
      rmSync(outPath, { force: true });
    }
  });

  it.each([
    { status: 404, code: "NOT_FOUND", message: "Artifact unavailable" },
    {
      status: 403,
      code: "FORBIDDEN",
      message: "Missing required permission: artifact:read",
    },
    {
      status: 500,
      code: "INTERNAL_SERVER_ERROR",
      message: "Artifact storage is unavailable",
    },
  ])(
    "does not write a file when artifact authorization returns $status",
    async ({ status, code, message }) => {
      const outPath = join(tmpDir, "denied.html");
      server.use(
        http.get(READ_URL, () => {
          return HttpResponse.json({ error: { message, code } }, { status });
        }),
      );

      await expect(
        command.parseAsync([
          "node",
          "cli",
          ...prefix,
          "/artifacts/htmlread01.html",
          "-o",
          outPath,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(message),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
      expect(existsSync(outPath)).toBe(false);
    },
  );

  it("requires a token before reading an artifact", async () => {
    vi.stubEnv("OKOU_TOKEN", "");
    const outPath = join(tmpDir, "unauthenticated.html");

    await expect(
      command.parseAsync([
        "node",
        "cli",
        ...prefix,
        "/artifacts/htmlread01.html",
        "-o",
        outPath,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Set OKOU_TOKEN"),
    );
    expect(existsSync(outPath)).toBe(false);
  });

  it.each([
    {
      status: 404,
      code: "NOT_FOUND",
      message: "File not found",
      output: "File not found",
    },
    {
      status: 401,
      code: "UNAUTHORIZED",
      message: "Not authenticated",
      output: "Authentication failed",
    },
  ])(
    "preserves legacy download error $status",
    async ({ status, code, message, output }) => {
      const outPath = join(tmpDir, "missing.bin");
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return HttpResponse.json({ error: { message, code } }, { status });
        }),
      );

      await expect(
        command.parseAsync(["node", "cli", ...prefix, FILE_ID, "-o", outPath]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(output),
      );
      expect(existsSync(outPath)).toBe(false);
    },
  );

  it.each([
    {
      name: "has no body",
      status: 204,
      output: "Web download response has no body",
    },
    {
      name: "fails outside the API",
      status: 503,
      output: "Failed to download web file (HTTP 503)",
    },
  ])(
    "fails without creating a file when artifact delivery $name",
    async ({ status, output }) => {
      const outPath = join(tmpDir, "failed.html");
      server.use(
        http.get(READ_URL, () => {
          return HttpResponse.json({
            url: DELIVERY_URL,
            filename: "index.html",
            contentType: "text/html",
          });
        }),
        http.get("https://delivery.example.com/content", () => {
          return new HttpResponse(null, { status });
        }),
      );

      await expect(
        command.parseAsync([
          "node",
          "cli",
          ...prefix,
          "/artifacts/htmlread01.html",
          "-o",
          outPath,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(output),
      );
      expect(existsSync(outPath)).toBe(false);
    },
  );

  it.each([
    "https://untrusted.example/artifacts/htmlread01.html",
    `https://untrusted.example/api/web/download-file?file_id=${FILE_ID}`,
  ])("never sends the token to an unrecognized URL (%s)", async (input) => {
    const outPath = join(tmpDir, "unrecognized.bin");
    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        expect(new URL(request.url).searchParams.get("file_id")).toBe(input);
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json(
          { error: { message: "File not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );

    await expect(
      command.parseAsync(["node", "cli", ...prefix, input, "-o", outPath]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("File not found"),
    );
    expect(existsSync(outPath)).toBe(false);
  });
});
