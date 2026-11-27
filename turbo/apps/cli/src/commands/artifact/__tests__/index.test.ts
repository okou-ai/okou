import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactVisibilityResponse } from "@okouai/api-contracts/contracts/artifact-access";
import { server } from "../../../mocks/server";
import { artifactCommand } from "../index";

const API = "http://localhost:3000";
const REFERENCE = "/artifacts/abc123def4.pdf";
const TARGET = {
  kind: "file" as const,
  id: "00000000-0000-4000-8000-000000000001",
};
const OWNER_URL = `https://app.okou.ai${REFERENCE}`;
const ORG_URL = OWNER_URL;
const PUBLIC_URL = "https://a.okou.io/xyz123abcd.pdf";
const PRIVATE: ArtifactVisibilityResponse = {
  artifactId: TARGET.id,
  kind: "file",
  visibility: "private",
  ownerUrl: OWNER_URL,
  shareUrl: null,
  shortUrl: null,
  organization: { id: "org_original", name: "Original organization" },
};

function serveStatus(
  status: ArtifactVisibilityResponse = PRIVATE,
  kind: "file" | "html" = "file",
) {
  server.use(
    http.get(
      `${API}/api/artifact-references/:reference`,
      ({ params, request }) => {
        expect(params.reference).toBe("abc123def4.pdf");
        expect(new URL(request.url).searchParams.get("kind")).toBe("artifact");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          url: "https://private-r2.example/file?signature=temporary",
          expiresAt: "2026-09-16T12:15:00.000Z",
          filename: "report.pdf",
          contentType: "application/pdf",
          target: { ...TARGET, kind },
        });
      },
    ),
    http.get(`${API}/api/artifacts/:artifactId/visibility`, ({ params }) => {
      expect(params.artifactId).toBe(TARGET.id);
      return HttpResponse.json({
        ...status,
        kind: kind === "html" ? "hosted-site" : status.kind,
      });
    }),
  );
}

describe("okou artifact", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("CLI exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", API);
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    artifactCommand.setOptionValue("json", false);
    artifactCommand.setOptionValue("kind", undefined);
    artifactCommand.setOptionValue("visibility", undefined);
    artifactCommand.exitOverride();
    artifactCommand.configureOutput({ writeErr: () => {} });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    process.exitCode = 0;
  });

  it("reads an owner URL without creating a share or returning temporary credentials", async () => {
    serveStatus();
    await artifactCommand.parseAsync([`${OWNER_URL}#page=2`, "--json"], {
      from: "user",
    });
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
      visibility: "only-me",
      url: OWNER_URL,
      organization: PRIVATE.organization,
      selectedTarget: null,
    });
  });

  it.each(["organization", "public"] as const)(
    "reads %s visibility and returns the stable App URL without changing permissions",
    async (visibility) => {
      const sharingUrl = visibility === "organization" ? ORG_URL : PUBLIC_URL;
      serveStatus({
        ...PRIVATE,
        visibility,
        shareUrl: sharingUrl,
      });
      await artifactCommand.parseAsync([REFERENCE, "--json"], { from: "user" });
      const output = log.mock.calls.flat().join("\n");
      expect(JSON.parse(output)).toMatchObject({
        visibility: visibility === "organization" ? "org" : "public",
        url: OWNER_URL,
      });
      expect(output).not.toContain(PUBLIC_URL);
    },
  );

  it.each(["organization", "public"] as const)(
    "shares a file to %s using the unified visibility endpoint and returns the stable App URL",
    async (visibility) => {
      serveStatus();
      const sharingUrl = visibility === "organization" ? ORG_URL : PUBLIC_URL;
      const shared: ArtifactVisibilityResponse = {
        ...PRIVATE,
        visibility,
        shareUrl: sharingUrl,
        shortUrl: visibility === "organization" ? sharingUrl : null,
      };
      server.use(
        http.patch(
          `${API}/api/artifacts/:artifactId/visibility`,
          async ({ params, request }) => {
            expect(params.artifactId).toBe(TARGET.id);
            expect(await request.json()).toEqual({ visibility });
            return HttpResponse.json(shared);
          },
        ),
      );
      await artifactCommand.parseAsync(
        [
          REFERENCE,
          "--visibility",
          visibility === "organization" ? "org" : "public",
        ],
        { from: "user" },
      );
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(`URL: ${OWNER_URL}`);
      expect(output).not.toContain(PUBLIC_URL);
      expect(output).toContain(`Shared artifact: ${TARGET.kind} ${TARGET.id}`);
      expect(output).toContain(
        `Visibility: ${visibility === "organization" ? "org" : "public"}`,
      );
    },
  );

  it.each([
    {
      kind: "file",
      visibility: "organization",
      url: ORG_URL,
      shortUrl: ORG_URL,
    },
    {
      kind: "file",
      visibility: "public",
      url: PUBLIC_URL,
      shortUrl: null,
    },
    {
      kind: "html",
      visibility: "public",
      url: "https://report.okou.app/",
      shortUrl: "https://report.okou.app/",
    },
  ] as const)(
    "reuses the Share button's $kind $visibility grant and returns the stable App URL without a write",
    async ({ kind, visibility, url, shortUrl }) => {
      const shared: ArtifactVisibilityResponse = {
        ...PRIVATE,
        kind: kind === "html" ? "hosted-site" : "file",
        visibility,
        shareUrl: url,
        shortUrl,
      };
      serveStatus(shared, kind);
      await artifactCommand.parseAsync(
        [
          REFERENCE,
          "--visibility",
          visibility === "organization" ? "org" : "public",
          "--json",
        ],
        { from: "user" },
      );
      const output = log.mock.calls.flat().join("\n");
      expect(JSON.parse(output)).toMatchObject({
        visibility: visibility === "organization" ? "org" : "public",
        url: OWNER_URL,
        selectedTarget: { ...TARGET, kind },
      });
      if (url !== OWNER_URL) {
        expect(output).not.toContain(url);
      }
    },
  );

  it("does not create a sharing record when an artifact is already private", async () => {
    serveStatus();
    await artifactCommand.parseAsync(
      [TARGET.id, "--kind", "file", "--visibility", "only-me", "--json"],
      { from: "user" },
    );
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
      visibility: "only-me",
      url: OWNER_URL,
      organization: PRIVATE.organization,
      selectedTarget: null,
    });
  });

  it("revokes public sharing through the unified visibility update", async () => {
    serveStatus({
      ...PRIVATE,
      visibility: "public",
      shareUrl: PUBLIC_URL,
    });
    server.use(
      http.patch(
        `${API}/api/artifacts/:artifactId/visibility`,
        async ({ params, request }) => {
          expect(params.artifactId).toBe(TARGET.id);
          expect(await request.json()).toEqual({
            visibility: "private",
          });
          return HttpResponse.json(PRIVATE);
        },
      ),
    );
    await artifactCommand.parseAsync([REFERENCE, "--visibility", "only-me"], {
      from: "user",
    });
    expect(log.mock.calls.flat().join("\n")).toContain(`URL: ${OWNER_URL}`);
    expect(log.mock.calls.flat().join("\n")).not.toContain(PUBLIC_URL);
  });

  it("explicitly shares the requested deployment when it is currently private", async () => {
    const target = { ...TARGET, kind: "html" as const };
    serveStatus({ ...PRIVATE, kind: "hosted-site" }, "html");
    server.use(
      http.patch(
        `${API}/api/artifacts/:artifactId/visibility`,
        async ({ params, request }) => {
          expect(params.artifactId).toBe(target.id);
          expect(await request.json()).toEqual({ visibility: "public" });
          return HttpResponse.json({
            ...PRIVATE,
            kind: "hosted-site",
            visibility: "public",
            shareUrl: "https://report.okou.app/",
            shortUrl: "https://report.okou.app/",
          });
        },
      ),
    );
    await artifactCommand.parseAsync(
      [TARGET.id, "--kind", "html", "--visibility", "public", "--json"],
      { from: "user" },
    );
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      selectedTarget: target,
    });
  });

  it("allocates a missing named HTML link on an explicit share", async () => {
    const shared: ArtifactVisibilityResponse = {
      ...PRIVATE,
      kind: "hosted-site",
      visibility: "public",
      shareUrl: "https://old-token.okou.app/",
      shortUrl: null,
    };
    serveStatus(shared, "html");
    server.use(
      http.patch(
        `${API}/api/artifacts/:artifactId/visibility`,
        async ({ params, request }) => {
          expect(params.artifactId).toBe(TARGET.id);
          expect(await request.json()).toEqual({ visibility: "public" });
          return HttpResponse.json({
            ...shared,
            shareUrl: "https://report.okou.app/",
            shortUrl: "https://report.okou.app/",
          });
        },
      ),
    );
    await artifactCommand.parseAsync([REFERENCE, "--visibility", "public"], {
      from: "user",
    });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(`URL: ${OWNER_URL}`);
    expect(output).not.toContain("https://report.okou.app/");
  });

  it("preserves a permission denial without retrying a publication", async () => {
    serveStatus();
    let writes = 0;
    server.use(
      http.patch(`${API}/api/artifacts/:artifactId/visibility`, () => {
        writes++;
        return HttpResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Missing required capability: artifact:write",
            },
          },
          { status: 403 },
        );
      }),
    );
    await expect(
      artifactCommand.parseAsync([REFERENCE, "--visibility", "public"], {
        from: "user",
      }),
    ).rejects.toThrow("CLI exit");
    expect(error.mock.calls.flat().join("\n")).toContain("artifact:write");
    expect(writes).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("returns the stable App URL for a historical organization share without allocating an alias", async () => {
    serveStatus({
      ...PRIVATE,
      visibility: "organization",
    });
    await artifactCommand.parseAsync([REFERENCE], { from: "user" });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(`URL: ${OWNER_URL}`);
    expect(output).not.toContain("--visibility org");
  });

  it("rejects an invalid visibility before making any request", async () => {
    await expect(
      artifactCommand.parseAsync([REFERENCE, "--visibility", "everyone"], {
        from: "user",
      }),
    ).rejects.toThrow("Allowed choices");
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects a foreign artifact URL instead of changing a same-named owned artifact", async () => {
    await expect(
      artifactCommand.parseAsync(
        [`https://other.example${REFERENCE}`, "--visibility", "public"],
        { from: "user" },
      ),
    ).rejects.toThrow("CLI exit");
    expect(error.mock.calls.flat().join("\n")).toContain("OKOU_APP_URL");
    expect(log).not.toHaveBeenCalled();
  });
});
