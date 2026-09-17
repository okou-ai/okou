import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactShareStatus } from "@okouai/api-contracts/contracts/artifact-shares";
import { server } from "../../../mocks/server";
import { uploadFileCommand } from "../../web/upload-file";
import { hostCommand } from "../../host";

const API = "http://localhost:3000";
const ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_URL = "https://app.okou.ai/artifacts/abc123def4.txt";
const PUBLIC_URL = "https://a.okou.io/shared1234.txt";
const LEGACY_URL = "https://legacy.example/report.txt";
const PUT_URL = "https://storage.example/upload";

const surfaces = [
  {
    label: "upload-file",
    kind: "file" as const,
    command: uploadFileCommand,
    preparePath: "/api/uploads/prepare",
    completePath: "/api/uploads/complete",
    args: (dir: string) => {
      return ["-f", join(dir, "report.txt")];
    },
  },
  {
    label: "host",
    kind: "html" as const,
    command: hostCommand,
    preparePath: "/api/host/deployments/prepare",
    completePath: `/api/host/deployments/${ID}/complete`,
    args: (dir: string) => {
      return [dir, "--site", "visibility-test"];
    },
  },
];

describe.each(surfaces)("$label visibility", (surface) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("CLI exit");
  });
  let dir: string;

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", API);
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    dir = mkdtempSync(join(tmpdir(), "cli-visibility-"));
    writeFileSync(join(dir, "report.txt"), "Private report");
    writeFileSync(join(dir, "index.html"), "<h1>Private report</h1>");
    surface.command.setOptionValue("visibility", undefined);
    surface.command.setOptionValue("json", false);
    surface.command.exitOverride();
    surface.command.configureOutput({ writeErr: () => {} });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    process.exitCode = 0;
  });

  function serveCreation(options: { guarded?: boolean; url?: string } = {}) {
    const url = options.url ?? OWNER_URL;
    const target = { kind: surface.kind, id: ID };
    const file = {
      id: ID,
      filename: "report.txt",
      contentType: "text/plain; charset=utf-8",
      size: 14,
      url,
    };
    const deployment = {
      siteId: SITE_ID,
      deploymentId: ID,
      publicSlug: "visibility-test",
      deploymentVersion: 2,
      artifactUrl: url,
      url,
      isActive: false,
      activeDeploymentVersion: 1,
      status: "ready",
    };
    server.use(
      http.post(
        `${API}${surface.preparePath}${options.guarded ? "/private" : ""}`,
        async ({ request }) => {
          const body = await request.json();
          expect(body).toMatchObject(
            options.guarded ? { requirePrivateArtifact: true } : {},
          );
          if (!options.guarded) {
            expect(body).not.toHaveProperty("requirePrivateArtifact");
          }
          return HttpResponse.json(
            surface.kind === "file"
              ? { ...file, uploadUrl: PUT_URL }
              : {
                  ...deployment,
                  uploads: [
                    { path: "/index.html", uploadUrl: PUT_URL },
                    { path: "/report.txt", uploadUrl: PUT_URL },
                    { path: "/robots.txt", uploadUrl: PUT_URL },
                  ],
                },
          );
        },
      ),
      http.put(PUT_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${API}${surface.completePath}`, () => {
        return HttpResponse.json(surface.kind === "file" ? file : deployment);
      }),
    );
    return target;
  }

  function available(enabled = true) {
    server.use(
      http.get(`${API}/api/artifact-shares/availability`, () => {
        return HttpResponse.json({ enabled });
      }),
    );
  }

  function serveSharing(fail = false) {
    const target = { kind: surface.kind, id: ID };
    const status: ArtifactShareStatus = {
      ownerUrl: OWNER_URL,
      shareId: null,
      audience: "private",
      organization: { id: "org_original", name: "Original organization" },
      selectedTarget: null,
      selectedVersion: null,
      candidateVersion: surface.kind === "html" ? 2 : null,
      url: null,
      shortUrl: null,
    };
    server.use(
      http.post(`${API}/api/artifact-shares/status`, async ({ request }) => {
        expect(await request.json()).toEqual(target);
        return HttpResponse.json(status);
      }),
      http.put(`${API}/api/artifact-shares`, async ({ request }) => {
        const body = (await request.json()) as {
          target: typeof target;
          audience: "organization" | "public";
        };
        expect(body.target).toEqual(target);
        if (fail) {
          return HttpResponse.json(
            { error: { code: "FORBIDDEN", message: "Sharing was disabled" } },
            { status: 403 },
          );
        }
        const url = body.audience === "public" ? PUBLIC_URL : OWNER_URL;
        return HttpResponse.json({
          ...status,
          audience: body.audience,
          shareId: SITE_ID,
          selectedTarget: target,
          selectedVersion: status.candidateVersion,
          url,
          shortUrl: url,
        });
      }),
    );
  }

  it.each([OWNER_URL, LEGACY_URL])(
    "preserves the feature-gated creation default without a sharing request: %s",
    async (url) => {
      serveCreation({ url });
      await surface.command.parseAsync([...surface.args(dir), "--json"], {
        from: "user",
      });
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
        url,
      });
    },
  );

  it("keeps the new artifact owner-only without revoking a previous version's share", async () => {
    available();
    serveCreation({ guarded: true });
    await surface.command.parseAsync(
      [...surface.args(dir), "--visibility", "only-me", "--json"],
      { from: "user" },
    );
    // No status/update handlers: only-me must not touch any existing share.
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      url: OWNER_URL,
      ownerUrl: OWNER_URL,
      visibility: "only-me",
    });
  });

  it.each(["org", "public"] as const)(
    "returns the %s URL in JSON and Markdown after sharing the created version",
    async (visibility) => {
      available();
      serveCreation({ guarded: true });
      serveSharing();
      await surface.command.parseAsync(
        [...surface.args(dir), "--visibility", visibility, "--json"],
        { from: "user" },
      );
      const result = JSON.parse(log.mock.calls.flat().join("\n"));
      const url = visibility === "public" ? PUBLIC_URL : OWNER_URL;
      expect(result).toMatchObject({ url, ownerUrl: OWNER_URL, visibility });
      expect(result.inlineMarkdownLink).toContain(`(<${url}>)`);
      expect(result.previewMarkdownBlock).toContain(`(<${url}>)`);
    },
  );

  it.each(["only-me", "org", "public"])(
    "rejects explicit %s before creating when the feature is off",
    async (visibility) => {
      available(false);
      await expect(
        surface.command.parseAsync(
          [...surface.args(dir), "--visibility", visibility, "--json"],
          { from: "user" },
        ),
      ).rejects.toThrow("CLI exit");
      expect(error.mock.calls.flat().join("\n")).toContain("privateArtifacts");
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("fails against an older creation API without falling back to a public upload", async () => {
    available();
    server.use(
      http.post(`${API}${surface.preparePath}/private`, () => {
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Route not found" } },
          { status: 404 },
        );
      }),
    );
    await expect(
      surface.command.parseAsync(
        [...surface.args(dir), "--visibility", "only-me", "--json"],
        { from: "user" },
      ),
    ).rejects.toThrow("CLI exit");
    expect(log).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rejects an unexpected public preparation before uploading any bytes", async () => {
    available();
    serveCreation({ guarded: true, url: LEGACY_URL });
    server.use(
      http.put(PUT_URL, () => {
        throw new Error("Private bytes must not reach public storage");
      }),
    );
    await expect(
      surface.command.parseAsync(
        [...surface.args(dir), "--visibility", "only-me", "--json"],
        { from: "user" },
      ),
    ).rejects.toThrow("CLI exit");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "did not return a private artifact",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("reports the existing artifact and recovery command if sharing fails", async () => {
    available();
    serveCreation({ guarded: true });
    serveSharing(true);
    await expect(
      surface.command.parseAsync(
        [...surface.args(dir), "--visibility", "public", "--json"],
        { from: "user" },
      ),
    ).rejects.toThrow("CLI exit");
    const stderr = error.mock.calls.flat().join("\n");
    expect(stderr).toContain(OWNER_URL);
    expect(stderr).toContain(
      `okou artifact ${ID} --kind ${surface.kind} --json`,
    );
    expect(stderr).toContain("Do not repeat");
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects an invalid audience before any network request", async () => {
    await expect(
      surface.command.parseAsync(
        [...surface.args(dir), "--visibility", "everyone"],
        { from: "user" },
      ),
    ).rejects.toThrow("Allowed choices");
    expect(log).not.toHaveBeenCalled();
  });
});
