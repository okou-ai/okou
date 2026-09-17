/**
 * Tests for okou user-template publish and repackage
 *
 * Entry point is the command itself, so page ordering, the .png filter and the
 * package tarball are exercised as the reverse run reaches them:
 * - Mock (external): backend upload + template routes and the storage PUT
 * - Real (internal): argument parsing, filesystem reads, tar packaging, fetch
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { Parser } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { userTemplateCommand } from "../index";

const PREPARE_URL = "http://localhost:3000/api/uploads/prepare";
const COMPLETE_URL = "http://localhost:3000/api/uploads/complete";
const PUBLISH_URL = "http://localhost:3000/api/user-templates";
const PUT_URL = "https://mock-r2.test/upload/:uploadId";
const TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";
const REPACKAGE_URL = `${PUBLISH_URL}/:templateId/package`;

interface PublishedBody {
  readonly title: string;
  readonly kind: string;
  readonly sourceFileId: string;
  readonly pageFileIds?: readonly string[];
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
  bytesOf: (id: string) => Buffer | undefined;
  uploadCount: () => number;
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
    bytesOf: (id: string) => {
      return bodies.get(id);
    },
    uploadCount: () => {
      return issued;
    },
  };
}

/**
 * The paths inside an uploaded package, read back the way the API reads them.
 *
 * Reading the archive rather than trusting the upload's filename is what makes
 * the packaged directory observable: a command that tarred the wrong directory
 * still uploads something called `package.tar.gz`.
 */
function archivePaths(archive: Buffer): Promise<readonly string[]> {
  const paths: string[] = [];
  return new Promise((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry) => {
        if (entry.type === "File") {
          paths.push(entry.path);
        }
        entry.resume();
      },
    });
    parser.on("end", () => {
      resolve([...paths].sort());
    });
    parser.on("error", reject);
    parser.write(gunzipSync(archive));
    parser.end();
  });
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
          pageCount: published.pageFileIds?.length ?? null,
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
      published?.pageFileIds?.map((id) => {
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

  it("publishes a document template without a pages directory", async () => {
    installUploadRoutes();
    const docxPath = join(tempDir, "brand-report.docx");
    writeFileSync(docxPath, Buffer.from("docx bytes"));

    let published: PublishedBody | undefined;
    server.use(
      http.post(PUBLISH_URL, async ({ request }) => {
        published = (await request.json()) as PublishedBody;
        return HttpResponse.json({
          id: TEMPLATE_ID,
          title: published.title,
          sourceFilename: "brand-report.docx",
          kind: "document",
          coverUrl: null,
          pageCount: null,
          visibility: "private",
          ownerUserId: "user_1",
          canManage: true,
          createdAt: "2026-09-17T00:00:00.000Z",
          updatedAt: "2026-09-17T00:00:00.000Z",
        });
      }),
    );

    await userTemplateCommand.parseAsync([
      "node",
      "okou",
      "publish",
      "--kind",
      "document",
      "--title",
      "Brand report",
      "--source",
      docxPath,
      "--package",
      packageDir,
    ]);

    // The document arm carries no page ids at all, rather than an empty array
    // the endpoint would have to interpret.
    expect(published?.kind).toBe("document");
    expect(published?.pageFileIds).toBeUndefined();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Published Brand report (${TEMPLATE_ID})`,
    );
  });

  it("refuses a presentation with no pages directory", async () => {
    installUploadRoutes();

    await expect(
      userTemplateCommand.parseAsync([
        "node",
        "okou",
        "publish",
        "--title",
        "Brand system",
        "--source",
        sourcePath,
        "--package",
        packageDir,
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalled();
  });

  it("refuses a pages directory with no images", async () => {
    const uploads = installUploadRoutes();
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
    // Both halves matter. Asserting only that console.error was called would
    // pass just as well if the directory had been accepted, every file
    // uploaded, and the unmocked publish route had then failed: that path also
    // prints an error and exits. The message pins which refusal happened, and
    // the upload count pins that it happened before any work.
    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain(`No .png page images in ${pagesDir}`);
    expect(uploads.uploadCount()).toBe(0);
  });
});

describe("okou user-template repackage", () => {
  // Commander exits the process on an unknown command, so this describe owns
  // that boundary rather than borrowing the one above: a subcommand that was
  // built but never added should fail this test, not tear down the worker.
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  let tempDir: string;
  let packageDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    tempDir = join(
      tmpdir(),
      `user-template-repackage-${Date.now().toString()}`,
    );
    packageDir = join(tempDir, "package");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "SKILL.md"),
      "# Use this template, revised\n",
    );
    writeFileSync(join(packageDir, "design-system.md"), "Ink on cool paper.\n");
    // Beside the package, not inside it. Rebuilding guidance does not re-read
    // the source, so an archive carrying this file would mean the command
    // packaged the parent directory rather than the one it was given.
    writeFileSync(
      join(tempDir, "brand-system.pptx"),
      Buffer.from("deck bytes"),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("uploads the named directory and swaps the package on that template", async () => {
    const uploads = installUploadRoutes();
    let requestedPath: string | undefined;
    let sent: { readonly packageFileId: string } | undefined;
    server.use(
      http.put(REPACKAGE_URL, async ({ request, params }) => {
        requestedPath =
          typeof params.templateId === "string" ? params.templateId : "";
        sent = (await request.json()) as { packageFileId: string };
        return HttpResponse.json({
          id: TEMPLATE_ID,
          title: "Brand system",
          sourceFilename: "brand-system.pptx",
          kind: "presentation",
          coverUrl: null,
          pageCount: 3,
          visibility: "private",
          ownerUserId: "user_1",
          canManage: true,
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-17T00:00:00.000Z",
        });
      }),
    );

    await userTemplateCommand.parseAsync([
      "node",
      "okou",
      "repackage",
      TEMPLATE_ID,
      "--package",
      packageDir,
    ]);

    // The template the argument names, and one upload: no source, no pages.
    expect(requestedPath).toBe(TEMPLATE_ID);
    expect(uploads.uploadCount()).toBe(1);
    const packageFileId = sent?.packageFileId ?? "";
    expect(uploads.contentTypeOf(packageFileId)).toBe("application/gzip");
    await expect(
      archivePaths(uploads.bytesOf(packageFileId) ?? Buffer.alloc(0)),
    ).resolves.toStrictEqual(["SKILL.md", "design-system.md"]);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Updated the package for Brand system (${TEMPLATE_ID})`,
    );
  });
});
