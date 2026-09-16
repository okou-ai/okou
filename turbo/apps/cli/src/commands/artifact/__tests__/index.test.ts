import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactShareStatus } from "@okouai/api-contracts/contracts/artifact-shares";
import { server } from "../../../mocks/server";
import { artifactCommand } from "../index";

const API = "http://localhost:3000";
const REFERENCE = "/artifacts/abc123def4.pdf";
const TARGET = {
  kind: "file" as const,
  id: "00000000-0000-4000-8000-000000000001",
};
const SHARE_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_URL = `https://app.okou.ai${REFERENCE}`;
const ORG_URL = OWNER_URL;
const PUBLIC_URL = "https://a.okou.io/xyz123abcd.pdf";
const PRIVATE: ArtifactShareStatus = {
  ownerUrl: OWNER_URL,
  shareId: null,
  audience: "private",
  organization: { id: "org_original", name: "Original organization" },
  selectedTarget: null,
  selectedVersion: null,
  candidateVersion: null,
  url: null,
  shortUrl: null,
};

function serveStatus(
  status: ArtifactShareStatus = PRIVATE,
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
    http.post(`${API}/api/artifact-shares/status`, async ({ request }) => {
      expect(await request.json()).toEqual({ ...TARGET, kind });
      return HttpResponse.json(status);
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
      selectedVersion: null,
      candidateVersion: null,
    });
  });

  it.each(["organization", "public"] as const)(
    "reads %s visibility and its URL without changing permissions",
    async (audience) => {
      const url = audience === "organization" ? ORG_URL : PUBLIC_URL;
      serveStatus({
        ...PRIVATE,
        audience,
        shareId: SHARE_ID,
        selectedTarget: TARGET,
        url,
      });
      await artifactCommand.parseAsync([REFERENCE, "--json"], { from: "user" });
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
        visibility: audience === "organization" ? "org" : "public",
        url,
      });
    },
  );

  it.each(["organization", "public"] as const)(
    "shares a file to %s using the UI endpoint",
    async (audience) => {
      serveStatus();
      const url = audience === "organization" ? ORG_URL : PUBLIC_URL;
      const shared = {
        ...PRIVATE,
        audience,
        shareId: SHARE_ID,
        selectedTarget: TARGET,
        url,
        shortUrl: audience === "organization" ? url : null,
      };
      server.use(
        http.put(`${API}/api/artifact-shares`, async ({ request }) => {
          expect(await request.json()).toEqual({ target: TARGET, audience });
          return HttpResponse.json(shared);
        }),
      );
      await artifactCommand.parseAsync(
        [
          REFERENCE,
          "--visibility",
          audience === "organization" ? "org" : "public",
        ],
        { from: "user" },
      );
      expect(log.mock.calls.flat().join("\n")).toContain(`URL: ${url}`);
      expect(log.mock.calls.flat().join("\n")).toContain(
        `Visibility: ${audience === "organization" ? "org" : "public"}`,
      );
    },
  );

  it.each([
    {
      kind: "file",
      audience: "organization",
      url: ORG_URL,
      shortUrl: ORG_URL,
      version: null,
    },
    {
      kind: "file",
      audience: "public",
      url: PUBLIC_URL,
      shortUrl: null,
      version: null,
    },
    {
      kind: "html",
      audience: "public",
      url: "https://report.okou.app/",
      shortUrl: "https://report.okou.app/",
      version: 1,
    },
  ] as const)(
    "reuses the Share button's $kind $audience link without a write",
    async ({ kind, audience, url, shortUrl, version }) => {
      const shared = {
        ...PRIVATE,
        shareId: SHARE_ID,
        audience,
        url,
        shortUrl,
        selectedTarget: { ...TARGET, kind },
        selectedVersion: version,
        candidateVersion: version,
      };
      serveStatus(shared, kind);
      await artifactCommand.parseAsync(
        [
          REFERENCE,
          "--visibility",
          audience === "organization" ? "org" : "public",
          "--json",
        ],
        { from: "user" },
      );
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
        visibility: audience === "organization" ? "org" : "public",
        url,
        selectedTarget: { ...TARGET, kind },
        selectedVersion: version,
        candidateVersion: version,
      });
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
      selectedVersion: null,
      candidateVersion: null,
    });
  });

  it("revokes public sharing through the existing policy update", async () => {
    serveStatus({
      ...PRIVATE,
      audience: "public",
      shareId: SHARE_ID,
      selectedTarget: TARGET,
      url: PUBLIC_URL,
    });
    server.use(
      http.put(`${API}/api/artifact-shares`, async ({ request }) => {
        expect(await request.json()).toEqual({
          target: TARGET,
          audience: "private",
        });
        return HttpResponse.json({
          ...PRIVATE,
          shareId: SHARE_ID,
          selectedTarget: TARGET,
        });
      }),
    );
    await artifactCommand.parseAsync([REFERENCE, "--visibility", "only-me"], {
      from: "user",
    });
    expect(log.mock.calls.flat().join("\n")).toContain(`URL: ${OWNER_URL}`);
    expect(log.mock.calls.flat().join("\n")).not.toContain(PUBLIC_URL);
  });

  it("explicitly shares a new hosted version instead of returning the older link", async () => {
    const target = { ...TARGET, kind: "html" as const };
    const shared = {
      ...PRIVATE,
      audience: "public" as const,
      shareId: SHARE_ID,
      selectedTarget: { ...target, id: "00000000-0000-4000-8000-000000000003" },
      selectedVersion: 1,
      candidateVersion: 2,
      url: "https://report.okou.app/",
      shortUrl: "https://report.okou.app/",
    };
    serveStatus(shared, "html");
    server.use(
      http.put(`${API}/api/artifact-shares`, async ({ request }) => {
        expect(await request.json()).toEqual({ target, audience: "public" });
        return HttpResponse.json({
          ...shared,
          selectedTarget: target,
          selectedVersion: 2,
        });
      }),
    );
    await artifactCommand.parseAsync(
      [TARGET.id, "--kind", "html", "--visibility", "public", "--json"],
      { from: "user" },
    );
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      selectedTarget: target,
      selectedVersion: 2,
    });
  });

  it("allocates a missing named HTML link on an explicit share", async () => {
    const target = { ...TARGET, kind: "html" as const };
    const shared = {
      ...PRIVATE,
      audience: "public" as const,
      shareId: SHARE_ID,
      selectedTarget: target,
      selectedVersion: 1,
      candidateVersion: 1,
      url: "https://old-token.okou.app/",
      shortUrl: null,
    };
    serveStatus(shared, "html");
    server.use(
      http.put(`${API}/api/artifact-shares`, async ({ request }) => {
        expect(await request.json()).toEqual({ target, audience: "public" });
        return HttpResponse.json({
          ...shared,
          url: "https://report.okou.app/",
          shortUrl: "https://report.okou.app/",
        });
      }),
    );
    await artifactCommand.parseAsync([REFERENCE, "--visibility", "public"], {
      from: "user",
    });
    expect(log.mock.calls.flat().join("\n")).toContain(
      "URL: https://report.okou.app/",
    );
  });

  it("preserves a permission denial without retrying a publication", async () => {
    serveStatus();
    let writes = 0;
    server.use(
      http.put(`${API}/api/artifact-shares`, () => {
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

  it("reports a historical organization share without a URL without allocating one on read", async () => {
    serveStatus({
      ...PRIVATE,
      audience: "organization",
      shareId: SHARE_ID,
      selectedTarget: TARGET,
    });
    await artifactCommand.parseAsync([REFERENCE], { from: "user" });
    expect(log.mock.calls.flat().join("\n")).toContain("--visibility org");
    expect(log.mock.calls.flat().join("\n")).not.toContain(`URL: ${OWNER_URL}`);
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
