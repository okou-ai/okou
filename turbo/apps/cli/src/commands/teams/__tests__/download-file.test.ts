/**
 * Tests for okou teams download-file command.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";

const DOWNLOAD_URL =
  "http://localhost:3000/api/integrations/teams/download-file";

describe("okou teams download-file command", () => {
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
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `teams-download-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams legacy bytes when the independently deployed API has no URL route", async () => {
    const payload = Buffer.from("hello teams");
    const outPath = join(tmpDir, "result.png");

    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("file_id")).toBe("teams-file-id");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
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
      "teams-file-id",
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
  });

  it("downloads directly without sending the Okou credential to the file host", async () => {
    const outPath = join(tmpDir, "direct.txt");
    const target = "https://contoso.sharepoint.com/download?sig=single-file";
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(new URL(request.url).searchParams.get("file_id")).toBe(
          "teams-direct",
        );
        return HttpResponse.json({
          downloadUrl: target,
          filename: "direct.txt",
          contentType: "text/plain",
          size: 5,
        });
      }),
      http.get(target, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("cookie")).toBeNull();
        return new HttpResponse("hello", {
          headers: { "content-type": "text/plain", "content-length": "5" },
        });
      }),
    );
    await downloadFileCommand.parseAsync([
      "node",
      "cli",
      "teams-direct",
      "-o",
      outPath,
    ]);
    expect(readFileSync(outPath, "utf8")).toBe("hello");
    expect(
      JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
    ).toMatchObject({ path: outPath, size: 5, mimetype: "text/plain" });
  });

  it("does not publish an incomplete direct file", async () => {
    const outPath = join(tmpDir, "incomplete.txt");
    const target = "https://contoso.sharepoint.com/incomplete";
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json({
          downloadUrl: target,
          filename: "incomplete.txt",
          contentType: "text/plain",
          size: 10,
        });
      }),
      http.get(target, () => {
        return new HttpResponse("short", {
          headers: { "content-type": "text/plain", "content-length": "5" },
        });
      }),
    );
    await expect(
      downloadFileCommand.parseAsync([
        "node",
        "cli",
        "teams-incomplete",
        "-o",
        outPath,
      ]),
    ).rejects.toThrow("process.exit called");
    expect(existsSync(outPath)).toBe(false);
    expect(readdirSync(tmpDir)).toStrictEqual([]);
  });

  it("does not fall back when a scoped attachment is unavailable", async () => {
    const outPath = join(tmpDir, "denied.txt");
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "File unavailable to this run",
            },
          },
          { status: 404 },
        );
      }),
      http.get(DOWNLOAD_URL, () => {
        throw new Error("Must not bypass URL-route authorization");
      }),
    );
    await expect(
      downloadFileCommand.parseAsync([
        "node",
        "cli",
        "teams-denied",
        "-o",
        outPath,
      ]),
    ).rejects.toThrow("process.exit called");
    expect(existsSync(outPath)).toBe(false);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("File unavailable to this run"),
    );
  });

  it("surfaces API errors", async () => {
    server.use(
      http.get(`${DOWNLOAD_URL}/url`, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Invalid Microsoft Teams file id",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(async () => {
      await downloadFileCommand.parseAsync([
        "node",
        "cli",
        "bad-id",
        "-o",
        join(tmpDir, "bad.bin"),
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Invalid Microsoft Teams file id"),
    );
  });
});
