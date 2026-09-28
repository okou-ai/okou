/**
 * Tests for okou telegram download-file command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import chalk from "chalk";

const DOWNLOAD_URL =
  "http://localhost:3000/api/integrations/telegram/download-file";

describe("okou telegram download-file command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tmpDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `telegram-download-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams file bytes to the provided output path and prints JSON result", async () => {
    const payload = Buffer.from("hello telegram");
    const outPath = join(tmpDir, "photo.jpg");

    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("file_id")).toBe("TGFILE123");
        expect(url.searchParams.get("bot_id")).toBe("official");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return new HttpResponse(payload, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(payload.length),
            "x-file-mimetype": "image/jpeg",
          },
        });
      }),
    );

    await downloadFileCommand.parseAsync([
      "node",
      "cli",
      "TGFILE123",
      "-o",
      outPath,
    ]);

    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).equals(payload)).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      path: outPath,
      mimetype: "image/jpeg",
      size: payload.length,
    });
  });

  it("derives default output path when -o is omitted", async () => {
    const payload = Buffer.from("default telegram path");

    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("bot_id")).toBe("official");
        return new HttpResponse(payload, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "x-file-mimetype": "application/octet-stream",
            "content-length": String(payload.length),
          },
        });
      }),
    );

    await downloadFileCommand.parseAsync(["node", "cli", "TG-DEFAULT"]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.path).toBe(join(tmpdir(), "telegram-TG-DEFAULT"));

    rmSync(join(tmpdir(), "telegram-TG-DEFAULT"), { force: true });
  });

  it("surfaces API errors", async () => {
    server.use(
      http.get(DOWNLOAD_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Telegram file not found",
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
        "TG-MISSING",
        "-o",
        join(tmpDir, "missing.bin"),
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Telegram file not found"),
    );
  });
});
