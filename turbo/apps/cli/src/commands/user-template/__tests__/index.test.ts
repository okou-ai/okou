/**
 * Tests for okou user-template publish
 *
 * Entry point is the command itself, so page ordering, the .png filter and the
 * package tarball are exercised as the reverse run reaches them:
 * - Mock (external): backend upload + publish routes and the storage PUT
 * - Real (internal): argument parsing, filesystem reads, tar packaging, fetch
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
const TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";

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

/**
 * Stand in for the three-step upload route so the test can name each uploaded
 * id by the file it came from, which is what makes page order observable.
 */
function installUploadRoutes(): {
  filenameOf: (id: string) => string | undefined;
  contentTypeOf: (id: string) => string | undefined;
} {
  const filenames = new Map<string, string>();
  const contentTypes = new Map<string, string>();
  const bodies = new Map<string, Buffer>();
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
      filenames.set(id, body.filename);
      contentTypes.set(id, body.contentType);
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
      bodies.set(id, Buffer.from(await request.arrayBuffer()));
      return new HttpResponse(null, { status: 200 });
    }),
    http.post(COMPLETE_URL, async ({ request }) => {
      const body = (await request.json()) as { id: string };
      return HttpResponse.json({
        id: body.id,
        filename: filenames.get(body.id),
        contentType: contentTypes.get(body.id),
        size: bodies.get(body.id)?.length ?? 0,
        url: `https://presigned.example.com/${body.id}`,
      });
    }),
  );

  return {
    filenameOf: (id: string) => {
      return filenames.get(id);
    },
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

    sourcePath = join(tempDir, "brand-system.pptx");
    writeFileSync(sourcePath, Buffer.from("deck bytes"));
    writeFileSync(join(packageDir, "SKILL.md"), "# Use this template\n");
    writeFileSync(join(packageDir, "design-system.md"), "Ink on paper.\n");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("publishes pages in filename order and declares the template kind", async () => {
    const uploads = installUploadRoutes();
    // Written out of order on purpose: publication order must come from the
    // zero-padded names, not from readdir.
    writeFileSync(join(pagesDir, "page-003.png"), Buffer.from("third"));
    writeFileSync(join(pagesDir, "page-001.png"), Buffer.from("cover"));
    writeFileSync(join(pagesDir, "page-002.png"), Buffer.from("second"));
    // A stray non-image in the same directory must not become a page.
    writeFileSync(join(pagesDir, "notes.txt"), "ignore me");

    let published: PublishedBody | undefined;
    server.use(
      http.post(PUBLISH_URL, async ({ request }) => {
        published = (await request.json()) as PublishedBody;
        return HttpResponse.json({
          id: TEMPLATE_ID,
          title: published.title,
          sourceFilename: "brand-system.pptx",
          kind: "presentation",
          coverUrl: null,
          pageCount: published.pageFileIds.length,
          visibility: "private",
          ownerUserId: "user_1",
          canManage: true,
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
        });
      }),
    );

    await userTemplateCommand.parseAsync([
      "node",
      "okou",
      "publish",
      "--title",
      "Brand system",
      "--source",
      sourcePath,
      "--pages",
      pagesDir,
      "--package",
      packageDir,
    ]);

    expect(published?.kind).toBe("presentation");
    expect(
      published?.pageFileIds.map((id) => {
        return uploads.filenameOf(id);
      }),
    ).toStrictEqual(["page-001.png", "page-002.png", "page-003.png"]);
    expect(uploads.contentTypeOf(published?.packageFileId ?? "")).toBe(
      "application/gzip",
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Published Brand system (${TEMPLATE_ID}) with 3 pages`,
    );
  });

  it("refuses a pages directory with no images", async () => {
    installUploadRoutes();
    writeFileSync(join(pagesDir, "notes.txt"), "no pages here");

    await expect(
      userTemplateCommand.parseAsync([
        "node",
        "okou",
        "publish",
        "--title",
        "Brand system",
        "--source",
        sourcePath,
        "--pages",
        pagesDir,
        "--package",
        packageDir,
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalled();
  });
});
