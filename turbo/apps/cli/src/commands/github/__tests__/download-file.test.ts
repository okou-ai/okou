import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import chalk from "chalk";

const DOWNLOAD_URL =
  "http://localhost:3000/api/integrations/github/download-file";

describe("okou github download-file command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tmpDir: string;
  let defaultOutPaths: string[];

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `github-download-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    defaultOutPaths = [];
    // Older API deployments still serve the retained binary download route.
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
    for (const outPath of defaultOutPaths) {
      rmSync(outPath, { force: true });
    }
  });

  it("downloads direct bytes without forwarding API credentials and prints JSON", async () => {
    const payload = Buffer.from("hello github");
    const outPath = join(tmpDir, "screenshot.png");
    const fileUrl = "https://github.com/user-attachments/assets/abc123";

    server.use(
      http.get(`${DOWNLOAD_URL}/url`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("url")).toBe(fileUrl);
        expect(url.searchParams.get("filename")).toBe("screenshot.png");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          downloadUrl: fileUrl,
          filename: "screenshot.png",
          contentType: "image/png",
        });
      }),
      http.get(fileUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        return new HttpResponse(payload, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(payload.length),
            "x-file-mimetype": "image/png",
          },
        });
      }),
    );

    await downloadFileCommand.parseAsync([
      "node",
      "cli",
      fileUrl,
      "--filename",
      "screenshot.png",
      "-o",
      outPath,
    ]);

    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).equals(payload)).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      path: outPath,
      mimetype: "image/png",
      size: payload.length,
    });
    expect(statSync(outPath).mode & 0o777).toBe(0o600);
  });

  it("retains provider MIME and actual size when URL metadata cannot infer a type", async () => {
    const fileUrl =
      "https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef";
    const outPath = join(tmpDir, "unknown-attachment");
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({
          downloadUrl: fileUrl,
          filename: "github-file",
          contentType: "application/octet-stream",
        });
      }),
      http.get(fileUrl, () => {
        return new HttpResponse("png-bytes", {
          headers: { "content-type": "image/png", "content-length": "9" },
        });
      }),
    );

    await downloadFileCommand.parseAsync([
      "node",
      "okou",
      fileUrl,
      "-o",
      outPath,
    ]);

    expect(readFileSync(outPath, "utf8")).toBe("png-bytes");
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(JSON.parse(stdout)).toEqual({
      path: outPath,
      mimetype: "image/png",
      size: 9,
    });
  });

  it.each([
    { status: 403, code: "FORBIDDEN", message: "GitHub read access denied" },
    {
      status: 404,
      code: "NOT_FOUND",
      message: "GitHub attachment unavailable",
    },
    { status: 409, code: "CONFLICT", message: "GitHub download conflict" },
  ])(
    "surfaces metadata access failure $status without binary fallback",
    async ({ status, code, message }) => {
      const outPath = join(tmpDir, "denied.bin");
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

      await expect(
        downloadFileCommand.parseAsync([
          "node",
          "okou",
          "https://github.com/user-attachments/assets/abc123",
          "-o",
          outPath,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(message),
      );
      expect(existsSync(outPath)).toBe(false);
      expect(binaryDownloads).toBe(0);
    },
  );

  it.each([
    { metadataSize: 5, length: "5", body: "Four" },
    { metadataSize: 4, length: "5", body: "Four" },
  ])(
    "preserves existing output on incomplete or inconsistent direct body: %j",
    async ({ metadataSize, length, body }) => {
      const outPath = join(tmpDir, "keep.txt");
      writeFileSync(outPath, "Keep this file");
      const fileUrl = "https://github.com/user-attachments/assets/abc123";
      server.use(
        http.get(`${DOWNLOAD_URL}/url`, () => {
          return HttpResponse.json({
            downloadUrl: fileUrl,
            filename: "report.txt",
            contentType: "text/plain",
            size: metadataSize,
          });
        }),
        http.get(fileUrl, () => {
          return new HttpResponse(body, {
            headers: { "content-type": "text/plain", "content-length": length },
          });
        }),
      );

      await expect(
        downloadFileCommand.parseAsync([
          "node",
          "okou",
          fileUrl,
          "-o",
          outPath,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(readFileSync(outPath, "utf8")).toBe("Keep this file");
      expect(readdirSync(tmpDir)).toEqual(["keep.txt"]);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    },
  );

  it("follows HTTPS CDN redirects without forwarding credentials", async () => {
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    const cdnUrl =
      "https://objects.githubusercontent.com/signed/report.txt?signature=example";
    const outPath = join(tmpDir, "redirect.txt");
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({
          downloadUrl: fileUrl,
          filename: "report.txt",
          contentType: "text/plain",
        });
      }),
      http.get(fileUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        return new HttpResponse(null, {
          status: 302,
          headers: { location: cdnUrl },
        });
      }),
      http.get(cdnUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        return new HttpResponse("redirected", {
          headers: { "content-type": "text/plain", "content-length": "10" },
        });
      }),
    );

    await downloadFileCommand.parseAsync([
      "node",
      "okou",
      fileUrl,
      "-o",
      outPath,
    ]);

    expect(readFileSync(outPath, "utf8")).toBe("redirected");
  });

  it("rejects insecure CDN redirects without replacing the destination", async () => {
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    const outPath = join(tmpDir, "keep.txt");
    writeFileSync(outPath, "Keep this file");
    let insecureDownloads = 0;
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({
          downloadUrl: fileUrl,
          filename: "report.txt",
          contentType: "text/plain",
        });
      }),
      http.get(fileUrl, () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "http://cdn.example.test/report.txt" },
        });
      }),
      http.get("http://cdn.example.test/report.txt", () => {
        insecureDownloads += 1;
        return new HttpResponse("insecure");
      }),
    );

    await expect(
      downloadFileCommand.parseAsync(["node", "okou", fileUrl, "-o", outPath]),
    ).rejects.toThrow("process.exit called");

    expect(readFileSync(outPath, "utf8")).toBe("Keep this file");
    expect(readdirSync(tmpDir)).toEqual(["keep.txt"]);
    expect(insecureDownloads).toBe(0);
  });

  it("sanitizes unsafe filename hints before writing to the default output path", async () => {
    const payload = Buffer.from("safe filename hint");
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    const unsafeFilename = "../../../etc/passwd";
    const outPath = join(tmpdir(), "github-passwd");
    defaultOutPaths.push(outPath);

    rmSync(outPath, { force: true });
    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("url")).toBe(fileUrl);
        expect(url.searchParams.get("filename")).toBe(unsafeFilename);
        return new HttpResponse(payload, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(payload.length),
            "x-file-mimetype": "application/octet-stream",
          },
        });
      }),
    );

    await downloadFileCommand.parseAsync([
      "node",
      "cli",
      fileUrl,
      "--filename",
      unsafeFilename,
    ]);

    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).equals(payload)).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      path: outPath,
      mimetype: "application/octet-stream",
      size: payload.length,
    });
  });

  it("sanitizes unsafe URL-derived filenames before writing to the default output path", async () => {
    const payload = Buffer.from("safe url filename");
    const fileUrl =
      "https://github.com/user-attachments/assets/..%2F..%2Fetc%2Fshadow";
    const outPath = join(tmpdir(), "github-shadow");
    defaultOutPaths.push(outPath);

    rmSync(outPath, { force: true });
    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("url")).toBe(fileUrl);
        expect(url.searchParams.has("filename")).toBe(false);
        return new HttpResponse(payload, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(payload.length),
            "x-file-mimetype": "application/octet-stream",
          },
        });
      }),
    );

    await downloadFileCommand.parseAsync(["node", "cli", fileUrl]);

    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).equals(payload)).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      path: outPath,
      mimetype: "application/octet-stream",
      size: payload.length,
    });
  });

  it("surfaces API errors", async () => {
    server.use(
      http.get(DOWNLOAD_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "No GitHub installation found",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await downloadFileCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/user-attachments/assets/missing",
        "-o",
        join(tmpDir, "missing.bin"),
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("No GitHub installation found"),
    );
  });
});
