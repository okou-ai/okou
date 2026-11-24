import { now } from "../../../lib/time";
import { createHash, randomUUID } from "node:crypto";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { object, string } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { hostRoutes } from "../host";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRouteMocks } from "./helpers/route-test";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function client(owner: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    owner.userId,
    owner.orgId,
    owner.orgRole,
  );
  return setupAppWithRoutes({
    context,
    routes: [...hostRoutes, ...featureSwitchesRoutes],
    baseUrl: "https://api.okou.ai",
  });
}
async function scenario(paid = true) {
  const owner = createBddApi(context).user();
  if (paid) {
    await createRunsApi(context).grantProEntitlement(owner);
  } else {
    await createBddApi(context).readMe(owner);
  }
  const app = client(owner);
  await accept(
    app(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.HostedSiteCustomDomains]: true } },
    }),
    [200],
  );
  const host = createHostBddApi(context);
  host.captureHostedSitesS3();
  const name = `domains-${randomUUID().slice(0, 8)}`;
  const prepared = await host.prepareHostedSite(owner, {
    site: name,
    title: name,
    artifactKind: "hosted-site",
    spaFallback: false,
    visibility: "public",
    files: [hostedTextFile("/index.html", "<p>domain test</p>")],
  });
  await host.completeHostedSite(owner, prepared.deploymentId);
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_TARGET", "connect.okou.app");
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_ZONE_ID", "a".repeat(32));
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_API_TOKEN", "test-domain-token");
  const api = client(owner)(hostContract);
  return { owner, api, prepared, name };
}
function domainProvider() {
  let txt = "",
    correct = true,
    certificate = "pending",
    creates = 0,
    queries = 0;
  let mode: "cname" | "loop" | "apex" = "cname";
  let provider: {
    id: string;
    hostname: string;
    status: string;
    custom_metadata: { okou_binding_id: string };
    ssl: { status: string };
  } | null = null;
  server.use(
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/fallback_origin",
      () => {
        return HttpResponse.json({
          success: true,
          result: { origin: "connect.okou.app", status: "active" },
        });
      },
    ),
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/workers/routes",
      () => {
        return HttpResponse.json({
          success: true,
          result: [{ pattern: "*/*", script: "zero-host-worker" }],
        });
      },
    ),
    http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
      queries++;
      const url = new URL(request.url);
      const name = url.searchParams.get("name")!;
      const type = url.searchParams.get("type");
      const Answer =
        type === "TXT"
          ? [{ name, type: 16, data: JSON.stringify(correct ? txt : "wrong") }]
          : type === "A"
            ? [{ name, type: 1, data: "203.0.113.3" }]
            : type === "AAAA"
              ? []
              : mode === "apex"
                ? []
                : [
                    {
                      name,
                      type: 5,
                      data: mode === "loop" ? name : "connect.okou.app.",
                    },
                  ];
      return HttpResponse.json({ Status: 0, Answer });
    }),
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames",
      () => {
        return HttpResponse.json({
          success: true,
          result: provider
            ? [{ ...provider, ssl: { status: certificate } }]
            : [],
        });
      },
    ),
    http.post(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames",
      async ({ request }) => {
        creates++;
        const body = object({
          hostname: string(),
          custom_metadata: object({ okou_binding_id: string() }),
        }).parse(await request.json());
        provider = {
          id: randomUUID(),
          hostname: body.hostname,
          status: "active",
          custom_metadata: body.custom_metadata,
          ssl: { status: certificate },
        };
        return HttpResponse.json({ success: true, result: provider });
      },
    ),
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      () => {
        return HttpResponse.json({
          success: true,
          result: provider && { ...provider, ssl: { status: certificate } },
        });
      },
    ),
    http.delete(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      () => {
        provider = null;
        return HttpResponse.json({ success: true, result: {} });
      },
    ),
    http.get(
      "https://connect.okou.app/.okou/domain-verification",
      ({ request }) => {
        return HttpResponse.json(
          {
            proof: new URL(request.url).searchParams.get("proof"),
          },
          { headers: { "X-Okou-Domain-Probe-Version": "1" } },
        );
      },
    ),
  );
  return {
    apex: () => {
      mode = "apex";
    },
    loop: () => {
      mode = "loop";
    },
    setTxt: (value: string) => {
      txt = value;
    },
    invalidTxt: () => {
      correct = false;
    },
    ready: () => {
      certificate = "active";
    },
    creates: () => {
      return creates;
    },
    queries: () => {
      return queries;
    },
  };
}
async function add(
  fixture: Awaited<ReturnType<typeof scenario>>,
  hostname = `${fixture.name}.customer-example.net`,
) {
  return (
    await accept(
      fixture.api.addSiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId },
        body: { hostname },
      }),
      [200],
    )
  ).body;
}
test("manual verification returns pending once, then makes the complete hostname selectable without applying it", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  expect(added.effectiveUrl).toBe(`https://${fixture.name}.okou.app`);
  expect(external.queries()).toBe(0);
  expect(external.creates()).toBe(0);
  external.setTxt(domain.records[0]!.value);
  const verify = () => {
    return accept(
      fixture.api.verifySiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    );
  };
  const pending = (await verify()).body;
  expect(pending.domains[0]?.verification?.checks.certificate.status).toBe(
    "pending",
  );
  expect(pending.domains[0]?.ready).toBeFalsy();
  external.ready();
  const verified = (await verify()).body;
  expect(external.creates()).toBe(1);
  expect(verified.domains[0]?.ready).toBeTruthy();
  expect(verified.selectedDomainId).toBeNull();
  expect(verified.effectiveUrl).toBe(added.defaultUrl);
  const selected = (
    await accept(
      fixture.api.selectSiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId },
        body: { domainId: domain.id, expectedRevision: verified.revision },
      }),
      [200],
    )
  ).body;
  expect(selected.effectiveUrl).toBe(`https://${domain.hostname}`);
  const resolved = (
    await accept(
      fixture.api.resolveCustomDomain({
        params: { hostname: domain.hostname },
      }),
      [200],
    )
  ).body;
  expect(resolved?.siteId).toBe(fixture.prepared.siteId);
  await accept(
    fixture.api.selectSiteDomain({
      headers,
      params: { siteId: fixture.prepared.siteId },
      body: { domainId: null, expectedRevision: verified.revision },
    }),
    [409],
  );
  await accept(
    fixture.api.removeSiteDomain({
      headers,
      params: { siteId: fixture.prepared.siteId, domainId: domain.id },
      body: { expectedRevision: domain.revision },
    }),
    [200],
  );
  expect(
    (
      await accept(
        fixture.api.resolveCustomDomain({
          params: { hostname: domain.hostname },
        }),
        [200],
      )
    ).body,
  ).toBeNull();
  const current = (
    await accept(
      fixture.api.siteDomains({
        headers,
        params: { siteId: fixture.prepared.siteId },
      }),
      [200],
    )
  ).body;
  expect(current.effectiveUrl).toBe(added.defaultUrl);
  expect(current.domains).toHaveLength(0);
});
test("tXT ownership is independent of a correct CNAME and prevents provider activation", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.invalidTxt();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  const verified = (
    await accept(
      fixture.api.verifySiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    )
  ).body;
  expect(verified.domains[0]?.verification?.checks.ownership.status).toBe(
    "failed",
  );
  expect(external.creates()).toBe(0);
  await accept(
    fixture.api.selectSiteDomain({
      headers,
      params: { siteId: fixture.prepared.siteId },
      body: { domainId: domain.id, expectedRevision: verified.revision },
    }),
    [409],
  );
});
test("rejects URL syntax, suffixes, local addresses and reserved platform hosts before DNS", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  for (const hostname of [
    "https://example.net/path",
    "example.net/ignored",
    "127.0.0.1",
    "localhost",
    "*.example.net",
    "co.uk",
    "foo.okou.app",
    "foo.vm0.io",
    "user@example.net",
    "example.net:443",
  ]) {
    await accept(
      fixture.api.addSiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId },
        body: { hostname },
      }),
      [400],
    );
  }
  const normalized = await add(fixture, "WWW.CUSTOMER-EXAMPLE.NET.");
  expect(normalized.domains[0]?.hostname).toBe("www.customer-example.net");
  expect(external.queries()).toBe(0);
});
test("a free workspace cannot create custom domains even when its rollout is enabled", async () => {
  const fixture = await scenario(false);
  const response = await accept(
    fixture.api.addSiteDomain({
      headers,
      params: { siteId: fixture.prepared.siteId },
      body: { hostname: "www.customer-example.net" },
    }),
    [402],
  );
  expect(response.status).toBe(402);
});
test("domain configuration remains scoped to the website owner", async () => {
  const fixture = await scenario();
  const other = createBddApi(context).user();
  const api = client(other)(hostContract);
  const response = await accept(
    api.siteDomains({ headers, params: { siteId: fixture.prepared.siteId } }),
    [404],
  );
  expect(response.status).toBe(404);
  await accept(
    api.addSiteDomain({
      headers,
      params: { siteId: fixture.prepared.siteId },
      body: { hostname: "www.customer-example.net" },
    }),
    [404],
  );
});

test("root domains use only configured Apex Proxying addresses", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.apex();
  external.ready();
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_APEX_ADDRESSES", "203.0.113.3");
  const added = await add(fixture, `${fixture.name}.net`);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  expect(domain.records).toContainEqual({
    type: "A",
    name: domain.hostname,
    value: "203.0.113.3",
  });
  const verified = (
    await accept(
      fixture.api.verifySiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    )
  ).body;
  expect(verified.domains[0]?.ready).toBeTruthy();
});
test("cNAME loops never make a custom domain selectable", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.loop();
  external.ready();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const verified = (
    await accept(
      fixture.api.verifySiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    )
  ).body;
  expect(verified.domains[0]?.ready).toBeFalsy();
  expect(verified.domains[0]?.verification?.checks.dns.status).toBe("failed");
});

test("temporary provider failures retain prior verification but a removed provider binding fails closed", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const verify = () => {
    return accept(
      fixture.api.verifySiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    );
  };
  expect((await verify()).body.domains[0]?.ready).toBeTruthy();
  server.use(
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      () => {
        return HttpResponse.json({}, { status: 503 });
      },
    ),
  );
  const temporary = (await verify()).body;
  expect(temporary.domains[0]?.ready).toBeTruthy();
  expect(temporary.domains[0]?.verification?.status).toBe("unavailable");
  server.use(
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      () => {
        return HttpResponse.json({}, { status: 404 });
      },
    ),
  );
  const removed = (await verify()).body;
  expect(removed.domains[0]?.ready).toBeFalsy();
  expect(removed.domains[0]?.verification?.checks.provider.status).toBe(
    "failed",
  );
  expect(
    (
      await accept(
        fixture.api.resolveCustomDomain({
          params: { hostname: domain.hostname },
        }),
        [200],
      )
    ).body,
  ).toBeNull();
});
test("taking a website offline revokes its custom hostname while preserving manual cleanup", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const verified = (
    await accept(
      fixture.api.verifySiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    )
  ).body;
  await accept(
    fixture.api.selectSiteDomain({
      headers,
      params: { siteId: fixture.prepared.siteId },
      body: { domainId: domain.id, expectedRevision: verified.revision },
    }),
    [200],
  );
  await createHostBddApi(context).deleteHostedSite(fixture.owner, fixture.name);
  const api = client(fixture.owner)(hostContract);
  expect(
    (
      await accept(
        api.resolveCustomDomain({ params: { hostname: domain.hostname } }),
        [200],
      )
    ).body,
  ).toBeNull();
  const settings = (
    await accept(
      api.siteDomains({ headers, params: { siteId: fixture.prepared.siteId } }),
      [200],
    )
  ).body;
  expect(settings.selectedDomainId).toBeNull();
  expect(settings.domains[0]?.removing).toBeTruthy();
  await accept(
    api.removeSiteDomain({
      headers,
      params: { siteId: fixture.prepared.siteId, domainId: domain.id },
      body: { expectedRevision: domain.revision },
    }),
    [200],
  );
});

test("private website sessions trust only the exact custom origin and do not survive rebinding", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  let settings = await add(fixture);
  let domain = settings.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const verify = () => {
    return accept(
      fixture.api.verifySiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    );
  };
  await verify();
  const owner = fixture.owner;
  context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
    return Promise.resolve({
      isAuthenticated:
        request instanceof Request &&
        request.headers.get("Authorization") === headers.authorization,
      toAuth: () => {
        return {
          userId: owner.userId,
          orgId: owner.orgId,
          orgRole: owner.orgRole,
          sessionId: `sess_${owner.userId}`,
        };
      },
    });
  });
  context.mocks.clerk.sessions.getSession.mockImplementation((sessionId) => {
    return Promise.resolve({
      id: sessionId,
      userId: owner.userId,
      status: "active",
      expireAt: now() + 86_400_000,
    });
  });
  const params = { siteId: fixture.prepared.siteId };
  const origin = `https://${domain.hostname}`;
  const visibility = (
    await accept(fixture.api.siteVisibility({ headers, params }), [200])
  ).body;
  await accept(
    fixture.api.updateSiteVisibility({
      headers,
      params,
      body: { visibility: "private", expectedRevision: visibility.revision },
    }),
    [200],
  );
  const verifier = "v".repeat(43);
  const authorization = {
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    state: "s".repeat(43),
    origin,
  };
  await accept(
    fixture.api.authorizeSiteSession({
      headers,
      params,
      body: { ...authorization, origin: `${origin}:8443` },
    }),
    [403],
  );
  const authorized = (
    await accept(
      fixture.api.authorizeSiteSession({
        headers,
        params,
        body: authorization,
      }),
      [200],
    )
  ).body;
  const code = new URL(authorized.callbackUrl).searchParams.get("code")!;
  const session = (
    await accept(
      fixture.api.exchangeSiteSession({
        params,
        body: { origin, code, codeVerifier: verifier },
      }),
      [200],
    )
  ).body;
  const viewerHeaders = { authorization: `Bearer ${session.sessionToken}` };
  expect(
    (
      await accept(
        fixture.api.siteAccess({
          headers: viewerHeaders,
          params,
          query: { origin },
        }),
        [200],
      )
    ).body.allowed,
  ).toBeTruthy();
  await accept(
    fixture.api.removeSiteDomain({
      headers,
      params: { ...params, domainId: domain.id },
      body: { expectedRevision: domain.revision },
    }),
    [200],
  );
  settings = await add(fixture);
  domain = settings.domains.find((item) => {
    return !item.removing;
  })!;
  external.setTxt(domain.records[0]!.value);
  await verify();
  expect(
    (
      await accept(
        fixture.api.siteAccess({
          headers: viewerHeaders,
          params,
          query: { origin },
        }),
        [200],
      )
    ).body.allowed,
  ).toBeFalsy();
});
