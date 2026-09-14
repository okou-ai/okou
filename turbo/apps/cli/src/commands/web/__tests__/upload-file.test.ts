import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
/**
 * Tests for okou web upload-file command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend prepare route + R2 PUT via MSW
 * - Real (internal): All CLI code, fetch, filesystem reads
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../upload-file";
import chalk from "chalk";

const PREPARE_URL = "http://localhost:3000/api/uploads/prepare";
const COMPLETE_URL = "http://localhost:3000/api/uploads/complete";
const PUT_URL = "https://mock-r2.test/upload-target";
const CLI_VERSION = "0.0.0-test";

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

describe("okou web upload-file command", () => {
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
    uploadFileCommand.setOptionValue("json", undefined);
    uploadFileCommand.setOptionValue("contentType", undefined);
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `web-upload-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("successful upload", () => {
    it.each([
      {
        createPath: () => {
          return join(tmpDir, "report.md");
        },
        contentType: "text/markdown; charset=utf-8",
      },
      {
        createPath: () => {
          return join(tmpDir, "note.txt");
        },
        contentType: "text/plain; charset=utf-8",
      },
      {
        createPath: () => {
          return join(tmpDir, "table.csv");
        },
        contentType: "text/csv; charset=utf-8",
      },
      {
        createPath: () => {
          return join(tmpDir, "table.tsv");
        },
        contentType: "text/tab-separated-values; charset=utf-8",
      },
    ])(
      "delivers $contentType with original bytes",
      async ({ createPath, contentType }) => {
        const filePath = createPath();
        const filename = basename(filePath);
        const bytes = Buffer.from("中文 / 日本語 / 한글 / emoji 😀\n", "utf8");
        writeFileSync(filePath, bytes);
        const file = {
          id: "00000000-0000-4000-8000-000000000028",
          filename,
          contentType,
          size: bytes.length,
          url: `https://cdn.example.test/${filename}`,
        };
        let uploadedBytes: ArrayBuffer | undefined;

        server.use(
          http.post(PREPARE_URL, async ({ request }) => {
            expect(await request.json()).toMatchObject({
              filename,
              contentType,
              size: bytes.length,
              purpose: "artifact",
            });
            return HttpResponse.json({ ...file, uploadUrl: PUT_URL });
          }),
          http.put(PUT_URL, async ({ request }) => {
            expect(request.headers.get("content-type")).toBe(contentType);
            uploadedBytes = await request.arrayBuffer();
            return new HttpResponse(null, { status: 200 });
          }),
          http.post(COMPLETE_URL, async ({ request }) => {
            expect(await request.json()).toEqual({ id: file.id, contentType });
            return HttpResponse.json(file);
          }),
        );

        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "-f",
          filePath,
          "--json",
        ]);

        expect(uploadedBytes).toEqual(new Uint8Array(bytes).buffer);
        expect(
          JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
        ).toMatchObject(file);
      },
    );

    it("preserves an explicitly declared non-UTF-8 text artifact", async () => {
      const filePath = join(tmpDir, "legacy.txt");
      const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
      writeFileSync(filePath, bytes);
      const file = {
        id: "00000000-0000-4000-8000-000000000029",
        filename: "legacy.txt",
        contentType: "text/plain; charset=gb18030",
        size: bytes.length,
        url: "https://cdn.example.test/legacy.txt",
      };
      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          expect(await request.json()).toMatchObject({
            contentType: file.contentType,
          });
          return HttpResponse.json({ ...file, uploadUrl: PUT_URL });
        }),
        http.put(PUT_URL, async ({ request }) => {
          expect(request.headers.get("content-type")).toBe(file.contentType);
          expect(await request.arrayBuffer()).toEqual(
            new Uint8Array(bytes).buffer,
          );
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json(file);
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        filePath,
        "--content-type",
        file.contentType,
        "--json",
      ]);

      expect(
        JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
      ).toMatchObject(file);
    });

    it("uses the content type signed by an older API that strips charset parameters", async () => {
      const filePath = join(tmpDir, "report.md");
      const bytes = Buffer.from("# 中文版 😀\n", "utf8");
      writeFileSync(filePath, bytes);
      const file = {
        id: "00000000-0000-4000-8000-000000000031",
        filename: "report.md",
        contentType: "text/markdown",
        size: bytes.length,
        url: "https://cdn.example.test/report.md",
      };
      let uploadedBytes: ArrayBuffer | undefined;
      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          expect(await request.json()).toMatchObject({
            contentType: "text/markdown; charset=utf-8",
          });
          return HttpResponse.json({ ...file, uploadUrl: PUT_URL });
        }),
        http.put(PUT_URL, async ({ request }) => {
          expect(request.headers.get("content-type")).toBe(file.contentType);
          uploadedBytes = await request.arrayBuffer();
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, async ({ request }) => {
          expect(await request.json()).toEqual({
            id: file.id,
            contentType: file.contentType,
          });
          return HttpResponse.json(file);
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        filePath,
        "--content-type",
        "text/markdown",
        "--json",
      ]);

      expect(uploadedBytes).toEqual(new Uint8Array(bytes).buffer);
      expect(
        JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
      ).toMatchObject(file);
    });

    it("should prepare + PUT + complete and print artifact presentation context", async () => {
      const filePath = join(tmpDir, "report.pdf");
      writeFileSync(filePath, Buffer.from("%PDF-1.4 fake"));

      const prepared = {
        id: "00000000-0000-4000-8000-000000000027",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
        uploadUrl: PUT_URL,
        uploadHeaders: {
          "x-amz-meta-artifact-id": "00000000-0000-4000-8000-000000000027",
          "x-amz-meta-filename": "report.pdf",
          "x-amz-meta-user-id": "user-test",
        },
        url: artifactReferencePath(
          "00000000-0000-4000-8000-000000000027",
          "report.pdf",
        ),
      };

      let putReceivedContentType: string | null = null;
      let completed = false;
      let prepareSessionId: string | undefined;
      let prepareRequestId: string | undefined;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(request.headers.get(CLIENT_VERSION_HEADER)).toBe(CLI_VERSION);
          expect(request.headers.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);
          prepareSessionId = requiredHeader(
            request.headers,
            CLIENT_SESSION_ID_HEADER,
          );
          prepareRequestId = requiredHeader(
            request.headers,
            CLIENT_REQUEST_ID_HEADER,
          );

          const body = (await request.json()) as {
            filename: string;
            contentType: string;
            size: number;
          };
          expect(body).toMatchObject({ purpose: "artifact" });
          expect(body.filename).toBe("report.pdf");
          expect(body.contentType).toBe("application/pdf");
          expect(body.size).toBe(13);

          return HttpResponse.json(prepared, { status: 200 });
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          expect(request.headers.get("x-amz-meta-artifact-id")).toBe(
            "00000000-0000-4000-8000-000000000027",
          );
          expect(request.headers.get("x-amz-meta-filename")).toBe("report.pdf");
          expect(request.headers.get("x-amz-meta-user-id")).toBe("user-test");
          expect(request.headers.get(CLIENT_TYPE_HEADER)).toBeNull();
          expect(request.headers.get(CLIENT_VERSION_HEADER)).toBeNull();
          expect(request.headers.get(CLIENT_SESSION_ID_HEADER)).toBeNull();
          expect(request.headers.get(CLIENT_REQUEST_ID_HEADER)).toBeNull();
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(request.headers.get(CLIENT_VERSION_HEADER)).toBe(CLI_VERSION);
          expect(request.headers.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);
          expect(
            requiredHeader(request.headers, CLIENT_SESSION_ID_HEADER),
          ).toBe(prepareSessionId);
          expect(
            requiredHeader(request.headers, CLIENT_REQUEST_ID_HEADER),
          ).not.toBe(prepareRequestId);
          expect(await request.json()).toEqual({
            id: prepared.id,
            contentType: prepared.contentType,
          });
          completed = true;
          return HttpResponse.json({
            id: prepared.id,
            filename: prepared.filename,
            contentType: prepared.contentType,
            size: prepared.size,
            url: prepared.url,
          });
        }),
      );

      await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);

      expect(putReceivedContentType).toBe("application/pdf");
      expect(completed).toBe(true);
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(stdout).toContain("The artifact upload completed successfully.");
      expect(stdout).toContain("Artifact presentation context:");
      expect(stdout).toContain(`[report.pdf](<${prepared.url}>)`);
      expect(stdout).toContain("This form remains a link in normal prose.");
      expect(stdout).toContain(`\n\n![report.pdf](<${prepared.url}>)\n\n`);
      expect(stdout).toContain(
        "occupies its own Markdown paragraph, with a blank line before and after it, and is outside a code fence",
      );
      expect(stdout).toContain(
        "Both forms reference the same artifact. Including both in one response creates two user-facing references.",
      );
      expect(stdout).not.toContain("Return this artifact");
      expect(stdout).not.toContain("Choose one form");
    });

    it("should use prepared content type for PUT after override normalization", async () => {
      const filePath = join(tmpDir, "data.bin");
      writeFileSync(filePath, Buffer.from("col1,col2\n1,2"));

      let putReceivedContentType: string | null = null;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as { contentType: string };
          expect(body.contentType).toBe("Text/CSV; charset=utf-8");

          return HttpResponse.json(
            {
              id: "csv-uuid",
              filename: "data.bin",
              contentType: "text/csv",
              size: 13,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/csv-uuid/data.bin?sig=xyz",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json({
            id: "csv-uuid",
            filename: "data.bin",
            contentType: "text/csv",
            size: 13,
            url: "https://presigned.example.com/csv-uuid/data.bin?sig=xyz",
          });
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        filePath,
        "--content-type",
        "Text/CSV; charset=utf-8",
        "--json",
      ]);

      expect(putReceivedContentType).toBe("text/csv");
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        id: "csv-uuid",
        filename: "data.bin",
        contentType: "text/csv",
        size: 13,
        url: "https://presigned.example.com/csv-uuid/data.bin?sig=xyz",
        inlineMarkdownLink:
          "[data.bin](<https://presigned.example.com/csv-uuid/data.bin?sig=xyz>)",
        previewMarkdownBlock:
          "![data.bin](<https://presigned.example.com/csv-uuid/data.bin?sig=xyz>)",
        artifactPresentationContext: expect.stringContaining(
          "outside code fences",
        ),
      });
    });

    it("should infer text/html for html files", async () => {
      const filePath = join(tmpDir, "preview.html");
      writeFileSync(filePath, "<!doctype html><title>Preview</title>");

      let putReceivedContentType: string | null = null;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            filename: string;
            contentType: string;
          };
          expect(body.filename).toBe("preview.html");
          expect(body.contentType).toBe("text/html");

          return HttpResponse.json(
            {
              id: "html-uuid",
              filename: "preview.html",
              contentType: "text/html",
              size: 37,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/html-uuid/preview.html",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json({
            id: "html-uuid",
            filename: "preview.html",
            contentType: "text/html",
            size: 37,
            url: "https://presigned.example.com/html-uuid/preview.html",
          });
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        filePath,
        "--json",
      ]);

      expect(putReceivedContentType).toBe("text/html");
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.contentType).toBe("text/html");
    });

    it.each([
      ["image.avif", "image/avif"],
      ["clip.mp3", "audio/mpeg"],
      ["voice.wav", "audio/wav"],
      ["network.har", "application/json"],
      ["payload.okouunknown", "application/octet-stream"],
    ])("should infer %s as %s", async (filename, expectedContentType) => {
      const filePath = join(tmpDir, basename(filename));
      writeFileSync(filePath, Buffer.from("fake bytes"));

      let putReceivedContentType: string | null = null;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            filename: string;
            contentType: string;
          };
          expect(body.filename).toBe(filename);
          expect(body.contentType).toBe(expectedContentType);

          return HttpResponse.json(
            {
              id: `${filename}-uuid`,
              filename,
              contentType: expectedContentType,
              size: 10,
              uploadUrl: PUT_URL,
              url: `https://presigned.example.com/${filename}`,
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json({
            id: `${filename}-uuid`,
            filename,
            contentType: expectedContentType,
            size: 10,
            url: `https://presigned.example.com/${filename}`,
          });
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        filePath,
        "--json",
      ]);

      expect(putReceivedContentType).toBe(expectedContentType);
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.contentType).toBe(expectedContentType);
    });

    it("should infer office content types from common extensions", async () => {
      const cases = [
        {
          filename: "brief.docx",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        {
          filename: "budget.xlsx",
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        {
          filename: "deck.pptx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      ] as const;
      const preparedById = new Map<
        string,
        { filename: string; contentType: string; size: number }
      >();
      const preparedBodies: Array<{ filename: string; contentType: string }> =
        [];

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            filename: string;
            contentType: string;
            size: number;
          };
          const id = `${body.filename}-uuid`;
          preparedBodies.push({
            filename: body.filename,
            contentType: body.contentType,
          });
          preparedById.set(id, {
            filename: body.filename,
            contentType: body.contentType,
            size: body.size,
          });

          return HttpResponse.json(
            {
              id,
              filename: body.filename,
              contentType: body.contentType,
              size: body.size,
              uploadUrl: PUT_URL,
              url: `https://presigned.example.com/${body.filename}`,
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            id: string;
            contentType: string;
          };
          const prepared = preparedById.get(body.id);
          if (!prepared) {
            throw new Error(`missing prepared upload for ${body.id}`);
          }
          expect(body.contentType).toBe(prepared.contentType);
          return HttpResponse.json({
            id: body.id,
            filename: prepared.filename,
            contentType: prepared.contentType,
            size: prepared.size,
            url: `https://presigned.example.com/${prepared.filename}`,
          });
        }),
      );

      for (const { filename } of cases) {
        const filePath = join(tmpDir, filename);
        writeFileSync(filePath, Buffer.from("office"));

        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }

      expect(preparedBodies).toEqual(cases);
    });

    it("should infer additional common content types from extensions", async () => {
      const cases = [
        { filename: "archive.zip", contentType: "application/zip" },
        {
          filename: "backup.7z",
          contentType: "application/x-7z-compressed",
        },
        { filename: "bundle.tar", contentType: "application/x-tar" },
        { filename: "bundle.tar.gz", contentType: "application/gzip" },
        {
          filename: "document.pages",
          contentType: "application/vnd.apple.pages",
        },
        {
          filename: "sheet.numbers",
          contentType: "application/vnd.apple.numbers",
        },
        {
          filename: "slides.key",
          contentType: "application/vnd.apple.keynote",
        },
        { filename: "photo.heic", contentType: "image/heic" },
        { filename: "scan.tiff", contentType: "image/tiff" },
        {
          filename: "macro.xlsm",
          contentType: "application/vnd.ms-excel.sheet.macroenabled.12",
        },
        {
          filename: "template.potx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.template",
        },
        { filename: "data.xml", contentType: "application/xml" },
        { filename: "config.yaml", contentType: "application/yaml" },
        {
          filename: "table.tsv",
          contentType: "text/tab-separated-values; charset=utf-8",
        },
        {
          filename: "events.parquet",
          contentType: "application/vnd.apache.parquet",
        },
        { filename: "local.sqlite", contentType: "application/vnd.sqlite3" },
        { filename: "book.epub", contentType: "application/epub+zip" },
        { filename: "design.psd", contentType: "image/vnd.adobe.photoshop" },
        { filename: "vector.ai", contentType: "application/postscript" },
      ] as const;
      const preparedById = new Map<
        string,
        { filename: string; contentType: string; size: number }
      >();
      const preparedBodies: Array<{ filename: string; contentType: string }> =
        [];

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            filename: string;
            contentType: string;
            size: number;
          };
          const id = `${body.filename}-uuid`;
          preparedBodies.push({
            filename: body.filename,
            contentType: body.contentType,
          });
          preparedById.set(id, {
            filename: body.filename,
            contentType: body.contentType,
            size: body.size,
          });

          return HttpResponse.json(
            {
              id,
              filename: body.filename,
              contentType: body.contentType,
              size: body.size,
              uploadUrl: PUT_URL,
              url: `https://presigned.example.com/${body.filename}`,
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            id: string;
            contentType: string;
          };
          const prepared = preparedById.get(body.id);
          if (!prepared) {
            throw new Error(`missing prepared upload for ${body.id}`);
          }
          expect(body.contentType).toBe(prepared.contentType);
          return HttpResponse.json({
            id: body.id,
            filename: prepared.filename,
            contentType: prepared.contentType,
            size: prepared.size,
            url: `https://presigned.example.com/${prepared.filename}`,
          });
        }),
      );

      for (const { filename } of cases) {
        const filePath = join(tmpDir, filename);
        writeFileSync(filePath, Buffer.from("common"));

        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }

      expect(preparedBodies).toEqual(cases);
    });
  });

  describe("validation errors", () => {
    it("rejects non-UTF-8 generated text before storing mislabeled bytes", async () => {
      const filePath = join(tmpDir, "report.md");
      writeFileSync(filePath, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json({
            id: "00000000-0000-4000-8000-000000000030",
            filename: "report.md",
            contentType: "text/markdown; charset=utf-8",
            size: 4,
            uploadUrl: PUT_URL,
            url: "https://cdn.example.test/report.md",
          });
        }),
      );

      await expect(
        uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Text artifacts must use UTF-8"),
      );
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should throw when the file does not exist", async () => {
      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "-f",
          join(tmpDir, "missing.txt"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("API errors", () => {
    it("should surface 401 unauthorized from prepare", async () => {
      const filePath = join(tmpDir, "hello.txt");
      writeFileSync(filePath, "hi");

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
    });

    it("should surface 400 file too large from prepare", async () => {
      const filePath = join(tmpDir, "big.txt");
      writeFileSync(filePath, "small");

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "File too large (max 1 GB)",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File too large"),
      );
    });

    it("should surface failure from R2 PUT", async () => {
      const filePath = join(tmpDir, "bad.txt");
      writeFileSync(filePath, "oops");
      let completeCalled = false;

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              id: "bad-id",
              filename: "bad.txt",
              contentType: "text/plain",
              size: 4,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/bad-id/bad.txt",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, () => {
          return new HttpResponse(null, { status: 500 });
        }),
        http.post(COMPLETE_URL, () => {
          completeCalled = true;
          return HttpResponse.json({});
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to upload file to storage"),
      );
      expect(completeCalled).toBe(false);
    });

    it("should surface failure from complete", async () => {
      const filePath = join(tmpDir, "complete-fails.txt");
      writeFileSync(filePath, "done");

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              id: "complete-id",
              filename: "complete-fails.txt",
              contentType: "text/plain",
              size: 4,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/complete-id/complete-fails.txt",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Uploaded file not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Uploaded file not found"),
      );
    });
  });
});
