import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { hostCommand } from "../index";

const FILES_URL = "http://localhost:3000/api/host/sites/:publicSlug/files";
const HOSTED_SITE_URL =
  "https://demo-site-a1b2c3d4-release-01.sites.example.com";
const ARTIFACT_URL =
  "https://dpl-00000000-0000-4000-8000-000000000002.sites.example.com";
const R2_DOWNLOAD_URL = "https://r2.example.com/demo-site";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("okou host clone command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    tempDir = join(tmpdir(), `host-clone-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it.each([
    ARTIFACT_URL,
    "/artifacts/abcxyz1234.html",
    artifactReferencePath("00000000-0000-4000-8000-000000000002", "index.html"),
  ])("downloads owned deployment files from %s", async (sourceUrl) => {
    const index = Buffer.from("<!doctype html><h1>Hello</h1>");
    const script = Buffer.from("console.log('hello');");
    const destination = join(tempDir, "site");

    server.use(
      http.get(
        "http://localhost:3000/api/artifact-references/abcxyz1234.html",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("kind")).toBe("html");
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            url: "https://preview.example.com/",
            expiresAt: "2026-09-18T00:00:00Z",
            filename: "index.html",
            contentType: "text/html",
            target: {
              kind: "html",
              id: "00000000-0000-4000-8000-000000000002",
            },
          });
        },
      ),
      http.get(FILES_URL, ({ params, request }) => {
        expect(params.publicSlug).toBe(
          "dpl-00000000-0000-4000-8000-000000000002",
        );
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(new URL(request.url).searchParams.get("version")).toBe("1");
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000002",
          publicSlug: "demo-site-a1b2c3d4-release-01",
          url: HOSTED_SITE_URL,
          deploymentVersion: 1,
          artifactUrl: ARTIFACT_URL,
          aliasUrl: HOSTED_SITE_URL,
          fileCount: 2,
          size: index.byteLength + script.byteLength,
          files: [
            {
              path: "/index.html",
              size: index.byteLength,
              sha256: sha256(index),
              contentType: "text/html; charset=utf-8",
              downloadUrl: `${R2_DOWNLOAD_URL}/index.html?sig=test`,
            },
            {
              path: "/assets/app.js",
              size: script.byteLength,
              sha256: sha256(script),
              contentType: "application/javascript; charset=utf-8",
              immutable: true,
              downloadUrl: `${R2_DOWNLOAD_URL}/assets/app.js?sig=test`,
            },
          ],
        });
      }),
      http.get(`${R2_DOWNLOAD_URL}/index.html`, () => {
        return new HttpResponse(index);
      }),
      http.get(`${R2_DOWNLOAD_URL}/assets/app.js`, () => {
        return new HttpResponse(script);
      }),
    );

    await hostCommand.parseAsync([
      "node",
      "cli",
      "clone",
      sourceUrl,
      destination,
      "--version",
      "1",
      "--json",
    ]);

    expect(readFileSync(join(destination, "index.html")).equals(index)).toBe(
      true,
    );
    expect(
      readFileSync(join(destination, "assets", "app.js")).equals(script),
    ).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      publicSlug: "demo-site-a1b2c3d4-release-01",
      deploymentVersion: 1,
      artifactUrl: ARTIFACT_URL,
      destination,
      fileCount: 2,
    });
  });

  it("keeps organization share references on the app authorization path", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/artifact-references/a1b2c3d4e5.html",
        () =>
          HttpResponse.json(
            { error: { message: "Artifact unavailable", code: "NOT_FOUND" } },
            { status: 404 },
          ),
      ),
    );
    const destination = join(tempDir, "shared-site");
    await expect(
      hostCommand.parseAsync([
        "node",
        "cli",
        "clone",
        "/artifacts/a1b2c3d4e5.html",
        destination,
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Artifact unavailable"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(existsSync(destination)).toBe(false);
  });

  it("uses the public slug as the default destination", async () => {
    const index = Buffer.from("<!doctype html>");

    server.use(
      http.get(FILES_URL, () => {
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000002",
          publicSlug: "demo-site-a1b2c3d4-release-01",
          url: HOSTED_SITE_URL,
          fileCount: 1,
          size: index.byteLength,
          files: [
            {
              path: "/index.html",
              size: index.byteLength,
              sha256: sha256(index),
              contentType: "text/html; charset=utf-8",
              downloadUrl: `${R2_DOWNLOAD_URL}/index.html?sig=test`,
            },
          ],
        });
      }),
      http.get(`${R2_DOWNLOAD_URL}/index.html`, () => {
        return new HttpResponse(index);
      }),
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await hostCommand.parseAsync([
        "node",
        "cli",
        "clone",
        "demo-site-a1b2c3d4-release-01",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(
      existsSync(join(tempDir, "demo-site-a1b2c3d4-release-01", "index.html")),
    ).toBe(true);
  });

  it("fails when the destination directory is not empty", async () => {
    const destination = join(tempDir, "existing");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "file.txt"), "content");

    await expect(async () => {
      await hostCommand.parseAsync([
        "node",
        "cli",
        "clone",
        "demo-site-a1b2c3d4-release-01",
        destination,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("is not empty"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("surfaces hosted site access errors", async () => {
    server.use(
      http.get(FILES_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Hosted site not found",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await hostCommand.parseAsync([
        "node",
        "cli",
        "clone",
        "missing-site-a1b2c3d4-release-01",
        join(tempDir, "missing"),
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Hosted site not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
