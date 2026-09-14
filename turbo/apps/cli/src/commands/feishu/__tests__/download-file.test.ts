import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { createFeishuDownloadCommand } from "../download-file";

const DOWNLOAD_URL =
  "http://localhost:3000/api/integrations/feishu/download-file";

describe.each(["feishu", "lark"] as const)(
  "okou %s download-file command",
  (platform) => {
    const downloadFileCommand = createFeishuDownloadCommand(platform);
    vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("process.exit called");
    });
    const mockConsoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => {});
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let tempDir: string;

    beforeEach(() => {
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
      vi.stubEnv("OKOU_TOKEN", "test-token");
      tempDir = mkdtempSync(join(tmpdir(), "feishu-download-file-"));
    });

    afterEach(() => {
      mockConsoleLog.mockClear();
      mockConsoleError.mockClear();
      vi.unstubAllEnvs();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("streams a Feishu message resource to the requested path", async () => {
      const payload = Buffer.from("feishu file bytes");
      const outPath = join(tempDir, "report.pdf");
      server.use(
        http.get(
          DOWNLOAD_URL.replace("/feishu/", `/${platform}/`),
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("message_id")).toBe("om_message");
            expect(url.searchParams.get("file_key")).toBe("file_key");
            expect(url.searchParams.get("type")).toBe("file");
            expect(url.searchParams.get("installation_id")).toBe(
              "00000000-0000-4000-8000-000000000001",
            );
            expect(request.headers.get("authorization")).toBe(
              "Bearer test-token",
            );
            return new HttpResponse(payload, {
              status: 200,
              headers: {
                "content-type": "application/pdf",
                "content-length": String(payload.length),
                "x-file-mimetype": "application/pdf",
              },
            });
          },
        ),
      );

      await downloadFileCommand.parseAsync([
        "node",
        "okou",
        "om_message",
        "file_key",
        "--type",
        "file",
        "--installation",
        "00000000-0000-4000-8000-000000000001",
        "--out",
        outPath,
      ]);

      expect(existsSync(outPath)).toBeTruthy();
      expect(readFileSync(outPath).equals(payload)).toBeTruthy();
      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(JSON.parse(output)).toStrictEqual({
        path: outPath,
        mimetype: "application/pdf",
        size: payload.length,
      });
    });

    it("surfaces Feishu download API errors", async () => {
      server.use(
        http.get(DOWNLOAD_URL.replace("/feishu/", `/${platform}/`), () => {
          return HttpResponse.json(
            {
              error: {
                code: "FEISHU_ERROR",
                message: "Feishu API error: resource not found",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(
        downloadFileCommand.parseAsync([
          "node",
          "okou",
          "om_missing",
          "file_missing",
          "--type",
          "file",
          "--out",
          join(tempDir, "missing.bin"),
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("resource not found"),
      );
    });
  },
);
