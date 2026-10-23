import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";

const FILE_URL =
  "http://localhost:3000/api/integrations/github/download-file/url";

describe("okou github download-file", () => {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  let directory: string;
  let defaultOutPaths: string[];
  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    directory = mkdtempSync(join(tmpdir(), "github-download-test-"));
    defaultOutPaths = [];
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    for (const path of defaultOutPaths) rmSync(path, { force: true });
    vi.unstubAllEnvs();
  });

  it("saves CDN bytes after HTTPS redirects and reports the provider MIME", async () => {
    const outPath = join(directory, "screenshot.png");
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    const cdnUrl =
      "https://objects.githubusercontent.com/signed/image.png?signature=example";
    server.use(
      http.get(FILE_URL, ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          url: fileUrl,
          filename: "screenshot.png",
        });
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          downloadUrl: fileUrl,
          filename: "screenshot.png",
          contentType: "application/octet-stream",
        });
      }),
      http.get(fileUrl, () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: cdnUrl },
        });
      }),
      http.get(cdnUrl, () => {
        return new HttpResponse("png-bytes", {
          headers: { "content-type": "image/png", "content-length": "9" },
        });
      }),
    );
    await downloadFileCommand.parseAsync([
      "node",
      "okou",
      fileUrl,
      "--filename",
      "screenshot.png",
      "-o",
      outPath,
    ]);
    expect(readFileSync(outPath, "utf8")).toBe("png-bytes");
    expect(statSync(outPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toEqual({
      path: outPath,
      mimetype: "image/png",
      size: 9,
    });
  });

  it.each([
    {
      url: "https://github.com/user-attachments/assets/abc123",
      filename: "../../../etc/passwd",
      name: "passwd",
    },
    {
      url: "https://github.com/user-attachments/assets/..%2F..%2Fetc%2Fshadow",
      filename: undefined,
      name: "shadow",
    },
  ])(
    "sanitizes the default filename to $name",
    async ({ url, filename, name }) => {
      const outPath = join(tmpdir(), `github-${name}`);
      defaultOutPaths.push(outPath);
      server.use(
        http.get(FILE_URL, () => {
          return HttpResponse.json({
            downloadUrl: "https://cdn.example.com/file",
            filename: name,
            contentType: "text/plain",
          });
        }),
        http.get("https://cdn.example.com/file", () => {
          return new HttpResponse("file bytes", {
            headers: { "content-type": "text/plain" },
          });
        }),
      );
      await downloadFileCommand.parseAsync([
        "node",
        "okou",
        url,
        ...(filename ? ["--filename", filename] : []),
      ]);
      expect(readFileSync(outPath, "utf8")).toBe("file bytes");
      expect(JSON.parse(output.mock.calls.flat().join("\n"))).toEqual({
        path: outPath,
        mimetype: "text/plain",
        size: 10,
      });
    },
  );
});
