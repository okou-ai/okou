import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
/**
 * Tests for okou web download-file command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend download route via MSW
 * - Real (internal): All CLI code, fetch streaming, filesystem writes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import { artifactCommand } from "../../artifact";
import chalk from "chalk";

const DOWNLOAD_URL = "http://localhost:3000/api/web/download-file";

describe.each([
  { name: "okou web download-file", command: downloadFileCommand, prefix: [] },
  {
    name: "okou artifact download",
    command: artifactCommand,
    prefix: ["download"],
  },
])("$name", ({ command, prefix }) => {
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

    tmpDir = join(tmpdir(), `web-download-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("successful download", () => {
    it.each([
      "abc-123-def",
      "/artifacts/abcxyz1234.txt",
      artifactReferencePath(
        "00000000-0000-4000-8000-000000000023",
        "result.txt",
      ),
    ])(
      "streams an authenticated file ID or hostless reference (%s)",
      async (input) => {
        const payload = Buffer.from("hello world");
        const outPath = join(tmpDir, "result.txt");

        server.use(
          http.get(
            "http://localhost:3000/api/artifact-references/abcxyz1234.txt",
            ({ request }) => {
              expect(new URL(request.url).searchParams.get("kind")).toBe(
                "file",
              );
              expect(request.headers.get("authorization")).toBe(
                "Bearer test-token",
              );
              return HttpResponse.json({
                url: "https://r2.example.com/file",
                expiresAt: "2026-09-18T00:00:00Z",
                filename: "result.txt",
                contentType: "text/plain",
                target: {
                  kind: "file",
                  id: "00000000-0000-4000-8000-000000000023",
                },
              });
            },
          ),
          http.get(DOWNLOAD_URL, ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("file_id")).toBe(
              input.startsWith("/artifacts/")
                ? "00000000-0000-4000-8000-000000000023"
                : input,
            );
            expect(request.headers.get("authorization")).toBe(
              "Bearer test-token",
            );
            return new HttpResponse(payload, {
              status: 200,
              headers: {
                "content-type": "text/plain",
                "content-length": String(payload.length),
                "x-file-mimetype": "text/plain",
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

        expect(existsSync(outPath)).toBe(true);
        expect(readFileSync(outPath).equals(payload)).toBe(true);

        const stdout = mockConsoleLog.mock.calls.flat().join("\n");
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        expect(parsed).toMatchObject({
          path: outPath,
          mimetype: "text/plain",
          size: payload.length,
        });
      },
    );

    it("should derive default output path when -o is omitted", async () => {
      const payload = Buffer.from("default-path");

      server.use(
        http.get(DOWNLOAD_URL, () => {
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

      await command.parseAsync(["node", "cli", ...prefix, "uuid-default"]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.path).toBe(join(tmpdir(), "web-uuid-default"));

      rmSync(join(tmpdir(), "web-uuid-default"), { force: true });
    });
  });

  describe("API errors", () => {
    it("should surface 404 not found as an error", async () => {
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "File not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await command.parseAsync([
          "node",
          "cli",
          ...prefix,
          "missing-uuid",
          "-o",
          join(tmpDir, "missing.bin"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File not found"),
      );
    });

    it("should surface 401 unauthorized", async () => {
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await command.parseAsync([
          "node",
          "cli",
          ...prefix,
          "some-uuid",
          "-o",
          join(tmpDir, "f1.bin"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
    });
  });
});
