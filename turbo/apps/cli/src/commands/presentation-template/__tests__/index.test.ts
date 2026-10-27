/**
 * Tests for okou presentation-template publish
 *
 * Entry point is the command itself, so the page ordering, the .png filter and
 * the package tarball are all exercised as the user reaches them:
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
import { presentationTemplateCommand } from "../index";

const PREPARE_URL = "http://localhost:3000/api/uploads/prepare";
const COMPLETE_URL = "http://localhost:3000/api/uploads/complete";
const PUBLISH_URL = "http://localhost:3000/api/user-templates";
const PUT_URL = "https://mock-r2.test/upload/:uploadId";
const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

interface PublishedBody {
  readonly kind: "presentation";
  readonly title: string;
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
  bodyOf: (id: string) => Buffer | undefined;
} {
  const filenames = new Map<string, string>();
  const contentTypes = new Map<string, string>();
  const bodies = new Map<string, Buffer>();
  let issued = 0;

  server.use(
    http.post(PREPARE_URL, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
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
    bodyOf: (id: string) => {
      return bodies.get(id);
    },
  };
}

describe("okou presentation-template publish", () => {
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

    tempDir = join(tmpdir(), `presentation-template-${Date.now().toString()}`);
    pagesDir = join(tempDir, "pages");
    packageDir = join(tempDir, "package");
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });

    sourcePath = join(tempDir, "brand-system.ppt");
    writeFileSync(sourcePath, Buffer.from("legacy deck bytes"));
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

  it("publishes to Custom with page images in filename order and skips non-page files", async () => {
    // Written out of order on purpose: the published order must come from the
    // zero-padded names, not from the order the directory happens to list.
    writeFileSync(join(pagesDir, "page-010.png"), Buffer.from("tenth"));
    writeFileSync(join(pagesDir, "page-002.png"), Buffer.from("second"));
    writeFileSync(join(pagesDir, "page-001.png"), Buffer.from("first"));
    writeFileSync(join(pagesDir, "page-003.PNG"), Buffer.from("third"));
    writeFileSync(join(pagesDir, "notes.txt"), "not a page");

    const uploads = installUploadRoutes();
    let published: PublishedBody | undefined;
    server.use(
      http.post(PUBLISH_URL, async ({ request }) => {
        published = (await request.json()) as PublishedBody;
        return HttpResponse.json({
          id: TEMPLATE_ID,
          kind: "presentation",
          title: published.title,
          sourceFilename: "brand-system.ppt",
          coverUrl: "https://presigned.example.com/cover.png",
          coverHasMorePages: true,
          pageCount: published.pageFileIds.length,
          visibility: "private",
          ownerUserId: "user_presentation_publisher",
          ownerDisplayName: "Template Owner",
          canManage: true,
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        });
      }),
    );

    await presentationTemplateCommand.parseAsync([
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

    if (!published) {
      throw new Error("Expected the publish route to receive a request");
    }
    expect(published.title).toBe("Brand system");
    expect(published.kind).toBe("presentation");
    expect(uploads.filenameOf(published.sourceFileId)).toBe("brand-system.ppt");
    expect(uploads.contentTypeOf(published.sourceFileId)).toBe(
      "application/vnd.ms-powerpoint",
    );
    expect(
      published.pageFileIds.map((id) => {
        return uploads.filenameOf(id);
      }),
    ).toStrictEqual([
      "page-001.png",
      "page-002.png",
      "page-003.PNG",
      "page-010.png",
    ]);
    for (const id of published.pageFileIds) {
      expect(uploads.contentTypeOf(id)).toBe("image/png");
    }

    // The guidance directory travels as a real gzip archive rather than JSON.
    expect(uploads.filenameOf(published.packageFileId)).toBe("package.tar.gz");
    expect(uploads.contentTypeOf(published.packageFileId)).toBe(
      "application/gzip",
    );
    const archive = uploads.bodyOf(published.packageFileId);
    expect(archive?.subarray(0, 2)).toStrictEqual(Buffer.from([0x1f, 0x8b]));

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(`Published Brand system (${TEMPLATE_ID})`);
    expect(output).toContain("4 pages");
  });

  it("reports a pages directory that holds no page images", async () => {
    writeFileSync(join(pagesDir, "notes.txt"), "not a page");
    installUploadRoutes();

    await expect(
      presentationTemplateCommand.parseAsync([
        "node",
        "okou",
        "publish",
        "--title",
        "No pages",
        "--source",
        sourcePath,
        "--pages",
        pagesDir,
        "--package",
        packageDir,
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain(`No .png page images in ${pagesDir}`);
  });

  it("surfaces a rejected package without claiming success", async () => {
    writeFileSync(join(pagesDir, "page-001.png"), Buffer.from("first"));
    installUploadRoutes();
    server.use(
      http.post(PUBLISH_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "The package must contain design-system.md",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(
      presentationTemplateCommand.parseAsync([
        "node",
        "okou",
        "publish",
        "--title",
        "Half a package",
        "--source",
        sourcePath,
        "--pages",
        pagesDir,
        "--package",
        packageDir,
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("The package must contain design-system.md");
    expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
      "Published",
    );
  });
});
