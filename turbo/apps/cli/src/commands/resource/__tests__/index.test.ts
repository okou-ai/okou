import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core";
import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { findRegistryResourceForPull, resourceCommand } from "../index";
import { ILLUSTRATION_ARCHIVE } from "./fixtures/illustration-archive";

const EXPECTED_WEBSITE_TEMPLATE_V2_SHA256: Record<string, string> = {
  "black-slabs":
    "de6f78c5a524cf3959ca56af7a93ec5bca113555bbd1a5983eebf1bc353971d4",
  "blueprint-grid":
    "dec02c4fe156566272a92b7386cb032cec7e3a1250dd42429ca3e7f42374dc28",
  "coastal-hotel":
    "09d239d7a0e1c27334f2c3c8da9e408174cece6bcc8a34342438598db739aa4e",
  "dot-matrix":
    "0beb9b1bcb12ace6d3541df269a629af8e3b41c8f9d7e3c3fcfe069655cd9074",
  "frame-stack":
    "7c4c13eaa22b4185607c6ac6a726dd931fe896b279b38a6267c0105f81214f8b",
  "frosted-scatter":
    "c67a7baf924ae4b57241e61527dd875d084e38040653a9bbcc659c13d2382cf9",
  "gallery-wall":
    "f6e41fb711b8c9317a425b463a9812e99f2aecb630d1acbfb77ef0965c2ba55f",
  "glass-bloom":
    "713fbac57cf37a0ddd6d7e7d79a0b9f29f8fff7a0aa55bc741bc5dcd0e498d25",
  "serif-stack":
    "6d5d65fb21d6c5ec5627fe32fbfc55e80841a2343f2d91bf3ee3a0f62547766a",
  "sticker-pop":
    "61954f4652e2cc86cd1016a537078ea050fe95735a7477e6bd56c91a0c0aec3b",
  "warm-cards":
    "213197ef200b16738b51b5d6c4a90b6e6c12c86c63207ef6afc31456cdd0d2e1",
};

describe("okou resource pull registry resolver", () => {
  it("resolves a presentation color system archive", () => {
    expect(findRegistryResourceForPull("color-system:carnival")).toEqual(
      expect.objectContaining({
        id: "color-system:carnival",
        kind: "color-system",
        source: expect.objectContaining({
          path: "presentation-color-system/carnival",
          archive: expect.objectContaining({ type: "tar.gz" }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed presentation color system ids", () => {
    expect(findRegistryResourceForPull("carnival")?.id).toBe(
      "color-system:carnival",
    );
  });

  it("resolves a built-in website template package archive", () => {
    expect(findRegistryResourceForPull("template:dot-matrix")).toEqual(
      expect.objectContaining({
        id: "template:dot-matrix",
        kind: "template",
        targets: ["website"],
        source: expect.objectContaining({
          path: "dot-matrix",
          archive: expect.objectContaining({
            type: "tar.gz",
            sha256:
              "5d9f69b7f9625681b5b6183623cbece78c4f40dc6fe585ca799212d05e589623",
          }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed built-in website template ids", () => {
    expect(findRegistryResourceForPull("dot-matrix")?.id).toBe(
      "template:dot-matrix",
    );
  });

  it("resolves every website template v2 package", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const resourceId = `${item.resourceId}-v2`;

      expect(findRegistryResourceForPull(resourceId)).toEqual(
        expect.objectContaining({
          id: resourceId,
          kind: "template",
          targets: ["website"],
          source: expect.objectContaining({
            path: item.sourcePath,
            archive: {
              type: "tar.gz",
              sha256: EXPECTED_WEBSITE_TEMPLATE_V2_SHA256[item.slug],
            },
          }),
        }),
      );
    }
  });
});

describe("okou resource pull command", () => {
  const downloadUrl = "https://r2.example.com/registry/vm0-illustration.tar.gz";
  const sha256 =
    "03e77d6968190b9f1888a900963135e92f75b40a6c37e1c1bae999ea49669a37";
  const versionId =
    "820d2e2ce81805d935e4098d5b6f2899967c2ad5c0af4586f794010c6db66966";
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let outputDir: string;

  function registryDownload(archive: Buffer) {
    return [
      http.get(
        "http://localhost:3000/api/registry/resources/download",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("id")).toBe(
            "image-style:vm0-illustration",
          );
          expect(url.searchParams.get("expectedSha256")).toBe(sha256);
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            url: downloadUrl,
            id: "image-style:vm0-illustration",
            type: "tar.gz",
            sha256,
            expiresInSeconds: 900,
            versionId,
            fileCount: 1,
            size: 6054,
          });
        },
      ),
      http.get(downloadUrl, () => {
        return new HttpResponse(archive, {
          headers: { "content-type": "application/gzip" },
        });
      }),
    ] as const;
  }

  beforeEach(async () => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    outputDir = await mkdtemp(path.join(tmpdir(), "resource-pull-test-"));
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(outputDir, { recursive: true, force: true });
  });

  it("downloads, verifies, and extracts an image style archive", async () => {
    server.use(...registryDownload(ILLUSTRATION_ARCHIVE));

    await resourceCommand.parseAsync([
      "node",
      "cli",
      "pull",
      "image-style:vm0-illustration",
      "--dir",
      outputDir,
    ]);

    const skill = await readFile(
      path.join(outputDir, "illustration-template/vm0-illustration/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("# vm0 Illustration");
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "✓ Pulled image-style:vm0-illustration",
    );
  });

  it("pulls the current presentation template by id without a digest", async () => {
    const id = "template:html-ppt-schoolhouse-runbook";
    server.use(
      http.get(
        "http://localhost:3000/api/registry/presentation-templates/download",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("id")).toBe(id);
          expect(url.searchParams.has("expectedSha256")).toBe(false);
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            url: downloadUrl,
          });
        },
      ),
      http.get(downloadUrl, () => {
        return new HttpResponse(ILLUSTRATION_ARCHIVE, {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );

    await resourceCommand.parseAsync([
      "node",
      "cli",
      "pull",
      id,
      "--dir",
      outputDir,
    ]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      `✓ Pulled ${id}`,
    );
  });

  it("resolves the pull-only presentation reverse-template guide through the command", async () => {
    const reverseTemplateSha256 =
      "4b2bb4ee2a041d57a2fe9ba07b796a690c6dbe130c6e232fa98364b6ed6aeb11";
    server.use(
      http.get(
        "http://localhost:3000/api/registry/resources/download",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("id")).toBe(
            "skill:presentation-reverse-template",
          );
          expect(url.searchParams.get("expectedSha256")).toBe(
            reverseTemplateSha256,
          );
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            url: downloadUrl,
            id: "skill:presentation-reverse-template",
            type: "tar.gz",
            sha256: "0".repeat(64),
            expiresInSeconds: 900,
            versionId,
            fileCount: 3,
            size: 30_489,
          });
        },
      ),
    );

    await expect(
      resourceCommand.parseAsync([
        "node",
        "cli",
        "pull",
        "skill:presentation-reverse-template",
        "--dir",
        outputDir,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Resource archive digest metadata mismatch",
    );
  });

  it("rejects an archive whose bytes do not match the registry digest", async () => {
    server.use(
      ...registryDownload(Buffer.from("not the published archive", "utf8")),
    );

    await expect(
      resourceCommand.parseAsync([
        "node",
        "cli",
        "pull",
        "image-style:vm0-illustration",
        "--dir",
        outputDir,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Resource archive digest mismatch",
    );
  });
});
