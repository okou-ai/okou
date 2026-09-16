/**
 * Tests for okou user-template publish
 *
 * Entry point is the command itself:
 * - Mock (external): backend upload + publish routes and the storage PUT
 * - Real (internal): argument parsing, filesystem reads, tar packaging, fetch
 *
 * Page ordering and the .png filter live in the shared template-package helper
 * and are covered by the presentation-template suite. What is only true here is
 * the destination: this command must reach the user catalog and say which kind
 * of template the run produced.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { userTemplateCommand } from "../index";

const PREPARE_URL = "http://localhost:3000/api/uploads/prepare";
const COMPLETE_URL = "http://localhost:3000/api/uploads/complete";
const PUBLISH_URL = "http://localhost:3000/api/user-templates";
const PUT_URL = "https://mock-r2.test/upload/:uploadId";
const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

interface PublishedBody {
  readonly title: string;
  readonly kind: string;
  readonly sourceFileId: string;
  readonly pageFileIds: readonly string[];
  readonly packageFileId: string;
}

function uploadId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function installUploadRoutes(): {
  contentTypeOf: (id: string) => string | undefined;
} {
  const contentTypes = new Map<string, string>();
  const filenames = new Map<string, string>();
  const sizes = new Map<string, number>();
  let issued = 0;

  server.use(
    http.post(PREPARE_URL, async ({ request }) => {
      const body = (await request.json()) as {
        filename: string;
        contentType: string;
        size: number;
      };
      issued += 1;
      const id = uploadId(issued);
      contentTypes.set(id, body.contentType);
      filenames.set(id, body.filename);
      return HttpResponse.json({
        id,
        filename: body.filename,
        contentType: body.contentType,
        size: body.size,
        uploadUrl: `https://mock-r2.test/upload/${id}`,
        url: `https://presigned.example.com/${id}`,
      });
    }),
    http.put(PUT_URL, async ({ request, params }) => {
      const id = typeof params.uploadId === "string" ? params.uploadId : "";
      sizes.set(id, (await request.arrayBuffer()).byteLength);
      return new HttpResponse(null, { status: 200 });
    }),
    http.post(COMPLETE_URL, async ({ request }) => {
      const body = (await request.json()) as { id: string };
      return HttpResponse.json({
        id: body.id,
        filename: filenames.get(body.id),
        contentType: contentTypes.get(body.id),
        size: sizes.get(body.id) ?? 0,
        url: `https://presigned.example.com/${body.id}`,
      });
    }),
  );

  return {
    contentTypeOf: (id: string) => {
      return contentTypes.get(id);
    },
  };
}

describe("okou user-template publish", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tempDir: string;
  let pagesDir: string;
  let packageDir: string;
  let sourcePath: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tempDir = join(tmpdir(), `user-template-${Date.now().toString()}`);
    pagesDir = join(tempDir, "pages");
    packageDir = join(tempDir, "package");
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });

    sourcePath = join(tempDir, "q3-board-final-v4.pptx");
    writeFileSync(sourcePath, Buffer.from("deck bytes"));
    writeFileSync(join(packageDir, "SKILL.md"), "# Use this template\n");
    writeFileSync(join(packageDir, "design-system.md"), "Ink on paper.\n");
    writeFileSync(join(pagesDir, "page-001.png"), Buffer.from("first"));
    writeFileSync(join(pagesDir, "page-002.png"), Buffer.from("second"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  async function publish(): Promise<void> {
    await userTemplateCommand.parseAsync([
      "node",
      "okou",
      "publish",
      "--title",
      "Q3 board review",
      "--source",
      sourcePath,
      "--pages",
      pagesDir,
      "--package",
      packageDir,
    ]);
  }

  it("commits the deck to the user catalog and names the kind it produced", async () => {
    const uploads = installUploadRoutes();
    let published: PublishedBody | undefined;
    server.use(
      http.post(PUBLISH_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        published = (await request.json()) as PublishedBody;
        return HttpResponse.json({
          id: TEMPLATE_ID,
          title: published.title,
          sourceFilename: "q3-board-final-v4.pptx",
          kind: "presentation",
          coverUrl: "https://presigned.example.com/cover.png",
          pageCount: published.pageFileIds.length,
          visibility: "private",
          ownerUserId: "user_self",
          canManage: true,
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
        });
      }),
    );

    await publish();

    expect(published?.title).toBe("Q3 board review");
    // Without this the row cannot say what it produces, and the picker has no
    // way to place it.
    expect(published?.kind).toBe("presentation");
    expect(published?.pageFileIds).toHaveLength(2);
    expect(uploads.contentTypeOf(published?.pageFileIds[0] ?? "")).toBe(
      "image/png",
    );
    expect(uploads.contentTypeOf(published?.packageFileId ?? "")).toBe(
      "application/gzip",
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Published Q3 board review (${TEMPLATE_ID}) with 2 pages`,
    );
  });

  it("reports the blocker instead of claiming the template was published", async () => {
    installUploadRoutes();
    server.use(
      http.post(PUBLISH_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Custom templates are not enabled",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(publish()).rejects.toThrow("process.exit called");

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalled();
  });
});
