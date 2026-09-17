import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostedSitePrepareRequestSchema } from "@okouai/api-contracts/contracts/host";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_HOSTED_SITE_ROBOTS_TXT } from "../../../lib/host/static-site";
import { server } from "../../../mocks/server";
import { hostCommand } from "../index";

const PREPARE_URL = "http://localhost:3000/api/host/deployments/prepare";
const COMPLETE_URL =
  "http://localhost:3000/api/host/deployments/:deploymentId/complete";
const INDEX_UPLOAD_URL = "https://uploads.example.com/index";
const ROBOTS_UPLOAD_URL = "https://uploads.example.com/robots";
const ALIAS_URL = "https://demo-site.sites.example.com";
const ARTIFACT_URL =
  "https://dpl-00000000-0000-4000-8000-000000000002.sites.example.com";
const CHAT_SCOPE_CONFLICT_MESSAGE =
  'Hosted site slug "demo-site" is owned outside this chat. Choose a different --site value and rerun the same okou host command.';

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("okou host publish command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const stderrIsTtyDescriptor = Object.getOwnPropertyDescriptor(
    process.stderr,
    "isTTY",
  );

  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    hostCommand.setOptionValue("json", undefined);
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    tempDir = join(tmpdir(), `host-publish-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    if (stderrIsTtyDescriptor) {
      Object.defineProperty(process.stderr, "isTTY", stderrIsTtyDescriptor);
    } else {
      Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });

  it.each([
    { label: "public", privateArtifact: false },
    { label: "private", privateArtifact: true },
  ])(
    "uploads a $label bundle and returns complete artifact URLs in text and JSON",
    async ({ privateArtifact }) => {
      const artifactUrl = privateArtifact
        ? artifactReferencePath(
            "00000000-0000-4000-8000-000000000002",
            "index.html",
          )
        : ARTIFACT_URL;
      const url = privateArtifact ? artifactUrl : ALIAS_URL;
      const expectedArtifactUrl = privateArtifact
        ? `https://app.okou.ai${artifactUrl}`
        : artifactUrl;
      const expectedUrl = privateArtifact ? expectedArtifactUrl : ALIAS_URL;
      const alias = privateArtifact ? {} : { aliasUrl: ALIAS_URL };
      const index = "<!doctype html><main>Hosted site</main>";
      let uploadedRobots = false;

      writeFileSync(join(tempDir, "index.html"), index);

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          const body = hostedSitePrepareRequestSchema.parse(
            await request.json(),
          );
          expect(body).toMatchObject({
            site: "demo-site",
            artifactKind: "hosted-site",
            spaFallback: true,
          });
          expect(body.slugSuffix).toBeUndefined();

          const filesByPath = new Map(
            body.files.map((file) => {
              return [file.path, file];
            }),
          );

          expect(filesByPath.get("/index.html")).toMatchObject({
            size: Buffer.byteLength(index),
            sha256: sha256(index),
            contentType: "text/html; charset=utf-8",
          });
          expect(filesByPath.get("/robots.txt")).toMatchObject({
            size: Buffer.byteLength(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
            sha256: sha256(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
            contentType: "text/plain; charset=utf-8",
          });

          return HttpResponse.json({
            siteId: "00000000-0000-4000-8000-000000000001",
            deploymentId: "00000000-0000-4000-8000-000000000002",
            publicSlug: "demo-site",
            url,
            deploymentVersion: 1,
            artifactUrl,
            ...alias,
            uploads: [
              { path: "/index.html", uploadUrl: INDEX_UPLOAD_URL },
              { path: "/robots.txt", uploadUrl: ROBOTS_UPLOAD_URL },
            ],
          });
        }),
        http.put(INDEX_UPLOAD_URL, async ({ request }) => {
          expect(await request.text()).toBe(index);
          return new HttpResponse(null, { status: 200 });
        }),
        http.put(ROBOTS_UPLOAD_URL, async ({ request }) => {
          uploadedRobots = true;
          expect(await request.text()).toBe(DEFAULT_HOSTED_SITE_ROBOTS_TXT);
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, ({ params }) => {
          expect(params.deploymentId).toBe(
            "00000000-0000-4000-8000-000000000002",
          );
          return HttpResponse.json({
            siteId: "00000000-0000-4000-8000-000000000001",
            deploymentId: "00000000-0000-4000-8000-000000000002",
            publicSlug: "demo-site",
            url,
            deploymentVersion: 1,
            artifactUrl,
            ...alias,
            isActive: !privateArtifact,
            activeDeploymentVersion: 1,
            status: "ready",
          });
        }),
      );

      await hostCommand.parseAsync([
        "node",
        "cli",
        tempDir,
        "--site",
        "demo-site",
        "--spa",
      ]);

      expect(uploadedRobots).toBe(true);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(stdout).toContain("✓ Hosted site deployed");
      expect(stdout).toContain(`Artifact: ${expectedArtifactUrl}`);
      if (privateArtifact) {
        expect(stdout).not.toContain(ALIAS_URL);
        expect(stdout).not.toContain("Alias:");
      } else {
        expect(stdout).toContain(`Alias: ${ALIAS_URL} → v1`);
      }
      expect(stdout).toContain("Artifact presentation context:");
      expect(stdout).toContain(`[demo-site](<${expectedUrl}>)`);
      expect(stdout).toContain(`\n\n![demo-site](<${expectedUrl}>)\n\n`);
      expect(stdout).toContain(
        "occupies its own Markdown paragraph, with a blank line before and after it, and is outside a code fence",
      );
      expect(stdout).toContain(
        "Both forms reference the same artifact. Including both in one response creates two user-facing references.",
      );

      mockConsoleLog.mockClear();
      await hostCommand.parseAsync([
        "node",
        "cli",
        tempDir,
        "--site",
        "demo-site",
        "--spa",
        "--json",
      ]);

      const jsonOutput = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(jsonOutput) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        publicSlug: "demo-site",
        deploymentVersion: 1,
        artifactUrl: expectedArtifactUrl,
        url: expectedUrl,
        ...alias,
        isActive: !privateArtifact,
        fileCount: 2,
        size:
          Buffer.byteLength(index) +
          Buffer.byteLength(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
        inlineMarkdownLink: `[demo-site](<${expectedUrl}>)`,
        previewMarkdownBlock: `![demo-site](<${expectedUrl}>)`,
        artifactPresentationContext: expect.stringContaining(
          "outside code fences",
        ),
      });
      if (privateArtifact) {
        expect(parsed.aliasUrl).toBeUndefined();
        expect(jsonOutput).not.toContain(ALIAS_URL);
      }
    },
  );

  it("preserves the legacy suffix and response shape during rollout", async () => {
    const index = "<!doctype html><main>Legacy hosted site</main>";
    const legacyPublicSlug = "demo-site-a1b2c3d4-release-01";
    const legacyUrl = `https://${legacyPublicSlug}.sites.example.com`;

    writeFileSync(join(tempDir, "index.html"), index);
    expect(hostCommand.helpInformation()).toContain("--slug-suffix <suffix>");

    server.use(
      http.post(PREPARE_URL, async ({ request }) => {
        const body = hostedSitePrepareRequestSchema.parse(await request.json());
        expect(body.slugSuffix).toBe("release-01");
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000004",
          publicSlug: legacyPublicSlug,
          url: legacyUrl,
          uploads: [
            { path: "/index.html", uploadUrl: INDEX_UPLOAD_URL },
            { path: "/robots.txt", uploadUrl: ROBOTS_UPLOAD_URL },
          ],
        });
      }),
      http.put(INDEX_UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.put(ROBOTS_UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(COMPLETE_URL, () => {
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000004",
          publicSlug: legacyPublicSlug,
          url: legacyUrl,
          status: "ready",
        });
      }),
    );

    await hostCommand.parseAsync([
      "node",
      "cli",
      tempDir,
      "--site",
      "demo-site",
      "--slug-suffix",
      "release-01",
      "--spa",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      publicSlug: legacyPublicSlug,
      url: legacyUrl,
      inlineMarkdownLink: `[demo-site](<${legacyUrl}>)`,
      previewMarkdownBlock: `![demo-site](<${legacyUrl}>)`,
      artifactPresentationContext: expect.stringContaining(
        "outside code fences",
      ),
    });
    expect(parsed.deploymentVersion).toBeUndefined();
    expect(parsed.artifactUrl).toBeUndefined();
    expect(parsed.aliasUrl).toBeUndefined();
  });

  it.each([
    { label: "TTY", isTty: true, extraArgs: [] },
    { label: "non-TTY JSON", isTty: false, extraArgs: ["--json"] },
  ])(
    "prints actionable chat-scope conflicts in $label mode",
    async ({ isTty, extraArgs }) => {
      writeFileSync(
        join(tempDir, "index.html"),
        "<!doctype html><main>Hosted site</main>",
      );
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: isTty,
      });
      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                code: "CONFLICT",
                message: CHAT_SCOPE_CONFLICT_MESSAGE,
              },
            },
            { status: 409 },
          );
        }),
      );

      await expect(
        hostCommand.parseAsync([
          "node",
          "cli",
          tempDir,
          "--site",
          "demo-site",
          ...extraArgs,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        `409: ${CHAT_SCOPE_CONFLICT_MESSAGE}`,
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    },
  );
});
