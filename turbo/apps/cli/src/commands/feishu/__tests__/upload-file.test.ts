import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEISHU_FILE_UPLOAD_MAX_BYTES } from "@okouai/api-contracts/contracts/integrations";

import { server } from "../../../mocks/server";
import { createFeishuUploadCommand } from "../upload-file";

const UPLOAD_INIT_URL =
  "http://localhost:3000/api/integrations/feishu/upload-file/init";
const UPLOAD_COMPLETE_URL =
  "http://localhost:3000/api/integrations/feishu/upload-file/complete";
const STORAGE_UPLOAD_URL = "https://storage.test/feishu-upload";
const FILE_CONTENT = "feishu pdf content";

describe.each(["feishu", "lark"] as const)(
  "okou %s upload-file command",
  (platform) => {
    const uploadFileCommand = createFeishuUploadCommand(platform);
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
    let filePath: string;

    beforeEach(() => {
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
      vi.stubEnv("OKOU_TOKEN", "test-token");
      tempDir = mkdtempSync(join(tmpdir(), "feishu-upload-file-"));
      filePath = join(tempDir, "report.pdf");
      writeFileSync(filePath, FILE_CONTENT);
    });

    afterEach(() => {
      mockConsoleLog.mockClear();
      mockConsoleError.mockClear();
      vi.unstubAllEnvs();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("uploads through storage and completes a threaded Feishu reply", async () => {
      let completeBody: Readonly<Record<string, unknown>> | undefined;
      server.use(
        http.post(
          UPLOAD_INIT_URL.replace("/feishu/", `/${platform}/`),
          async ({ request }) => {
            expect(await request.json()).toStrictEqual({
              filename: "report.pdf",
              contentType: "application/pdf",
              length: Buffer.byteLength(FILE_CONTENT),
            });
            return HttpResponse.json({
              uploadId: "00000000-0000-4000-8000-000000000001",
              uploadUrl: STORAGE_UPLOAD_URL,
              fileUrl:
                "https://files.test/artifacts/user/00000000-0000-4000-8000-000000000001/report.pdf",
              filename: "report.pdf",
              contentType: "application/pdf",
              size: Buffer.byteLength(FILE_CONTENT),
              uploadHeaders: {
                "x-amz-meta-artifact-id":
                  "00000000-0000-4000-8000-000000000001",
              },
            });
          },
        ),
        http.put(STORAGE_UPLOAD_URL, async ({ request }) => {
          expect(request.headers.get("content-type")).toBe("application/pdf");
          expect(request.headers.get("x-amz-meta-artifact-id")).toBe(
            "00000000-0000-4000-8000-000000000001",
          );
          await expect(request.text()).resolves.toBe(FILE_CONTENT);
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(
          UPLOAD_COMPLETE_URL.replace("/feishu/", `/${platform}/`),
          async ({ request }) => {
            completeBody = (await request.json()) as Readonly<
              Record<string, unknown>
            >;
            return HttpResponse.json({
              messageId: "om_uploaded",
              chatId: "oc_chat",
              fileKey: "file_uploaded",
              filename: "report.pdf",
              mimetype: "application/pdf",
              size: Buffer.byteLength(FILE_CONTENT),
              url: "https://files.test/report.pdf",
            });
          },
        ),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "okou",
        "--file",
        filePath,
        "--installation",
        "00000000-0000-4000-8000-000000000001",
        "--reply",
        "om_parent",
        "--thread",
      ]);

      expect(completeBody).toStrictEqual({
        uploadId: "00000000-0000-4000-8000-000000000001",
        installationId: "00000000-0000-4000-8000-000000000001",
        replyToMessageId: "om_parent",
        replyInThread: true,
        contentType: "application/pdf",
      });
      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(JSON.parse(output)).toMatchObject({
        messageId: "om_uploaded",
        fileKey: "file_uploaded",
        filename: "report.pdf",
        mimetype: "application/pdf",
      });
    });

    it("requires exactly one Feishu target", async () => {
      await expect(
        uploadFileCommand.parseAsync([
          "node",
          "okou",
          "--file",
          filePath,
          "--chat",
          "oc_chat",
          "--user",
          "ou_user",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Exactly one of --chat, --user, or --reply must be provided",
        ),
      );
    });

    it("rejects files above Feishu's upload limit", async () => {
      const largeFilePath = join(tempDir, "large.bin");
      writeFileSync(largeFilePath, "");
      truncateSync(largeFilePath, FEISHU_FILE_UPLOAD_MAX_BYTES + 1);

      await expect(
        uploadFileCommand.parseAsync([
          "node",
          "okou",
          "--file",
          largeFilePath,
          "--chat",
          "oc_chat",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          `exceeds ${platform === "lark" ? "Lark" : "Feishu"}`,
        ),
      );
    });
  },
);
