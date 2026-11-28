import { createDeferredPromise } from "../../utils";
import { mockNow, now } from "../../../lib/time";
import {
  createHash,
  randomUUID,
  generateKeyPairSync,
  verify as verifySignature,
} from "node:crypto";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { expect, onTestFinished, test } from "vitest";
import { object, string, literal } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { artifactAccessRoutes } from "../artifact-access";
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
  let extraRecords: { txt_name: string; txt_value: string }[] = [];
  const recordValues = new Map<string, string[]>();
  let txt = "",
    correct = true,
    certificate = "pending",
    creates = 0,
    patches = 0,
    queries = 0,
    deletes = 0,
    loseCreateResponse = false,
    rejectCreateStatus: 400 | 403 | null = null;
  let createGate:
    | {
        entered: ReturnType<typeof createDeferredPromise<void>>;
        release: ReturnType<typeof createDeferredPromise<void>>;
      }
    | undefined;
  let routeGate: typeof createGate;
  let mode: "cname" | "loop" | "apex" = "cname";
  interface DomainProvider {
    id: string;
    hostname: string;
    status: string;
    ssl: {
      status: string;
      method?: string;
      settings?: { min_tls_version: string; early_hints?: string };
      validation_records?: { txt_name: string; txt_value: string }[];
    };
  }
  let provider: DomainProvider | null = null;
  const providers = new Map<string, DomainProvider>();
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
        type === "TXT" && recordValues.has(name)
          ? recordValues.get(name)!.map((value) => {
              return {
                name,
                type: 16,
                data:
                  value === "certificate-one"
                    ? '"certificate-" "one"'
                    : JSON.stringify(value),
              };
            })
          : type === "TXT"
            ? [
                {
                  name,
                  type: 16,
                  data: JSON.stringify(correct ? txt : "wrong"),
                },
              ]
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
      ({ request }) => {
        const hostname = new URL(request.url).searchParams.get("hostname");
        const provider = [...providers.values()].find((item) => {
          return item.hostname === hostname;
        });
        return HttpResponse.json({
          success: true,
          result: provider
            ? [
                {
                  ...provider,
                  ssl: {
                    ...provider.ssl,
                    status: certificate,
                    validation_records: extraRecords,
                  },
                },
              ]
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
          ssl: object({
            method: literal("http"),
            type: literal("dv"),
            settings: object({ min_tls_version: literal("1.2") }),
          }),
        })
          .strict()
          .parse(await request.json());
        if (rejectCreateStatus) {
          return HttpResponse.json(
            { success: false, errors: [{ message: "Create rejected" }] },
            { status: rejectCreateStatus },
          );
        }
        provider = {
          id: randomUUID(),
          hostname: body.hostname,
          status: "active",
          ssl: {
            method: "http",
            settings: body.ssl.settings,
            status: certificate,
            validation_records: extraRecords,
          },
        };
        providers.set(provider.id, provider);
        if (createGate) {
          if (!createGate.entered.settled()) {
            createGate.entered.resolve(undefined);
          }
          await createGate.release.promise;
        }
        if (loseCreateResponse) {
          return HttpResponse.error();
        }
        return HttpResponse.json({ success: true, result: provider });
      },
    ),
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      ({ params }) => {
        const provider = providers.get(String(params.id));
        if (!provider) {
          return HttpResponse.json({ success: false }, { status: 404 });
        }
        return HttpResponse.json({
          success: true,
          result: {
            ...provider,
            ssl: {
              ...provider.ssl,
              status: certificate,
              validation_records: extraRecords,
            },
          },
        });
      },
    ),
    http.patch(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      async ({ request, params }) => {
        const current = providers.get(String(params.id));
        if (!current) {
          return HttpResponse.json({ success: false }, { status: 404 });
        }
        const body = object({
          ssl: object({
            method: literal("http"),
            type: literal("dv"),
            settings: object({
              min_tls_version: literal("1.3"),
              early_hints: literal("on"),
            }),
          }),
        }).parse(await request.json());
        patches++;
        current.ssl = { ...current.ssl, ...body.ssl };
        return HttpResponse.json({ success: true, result: current });
      },
    ),
    http.delete(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      ({ params }) => {
        deletes++;
        providers.delete(String(params.id));
        provider = null;
        return HttpResponse.json({ success: true, result: {} });
      },
    ),
    http.get(
      "https://connect.okou.app/.okou/domain-verification",
      async ({ request }) => {
        if (routeGate) {
          routeGate.entered.resolve(undefined);
          await routeGate.release.promise;
        }
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
    txtValidation: () => {
      if (provider) {
        provider.ssl = {
          ...provider.ssl,
          method: "txt",
          settings: { min_tls_version: "1.3", early_hints: "on" },
        };
      }
    },
    extraRecords: (value: typeof extraRecords) => {
      extraRecords = value;
    },
    recordValues: (name: string, values: string[]) => {
      recordValues.set(name, values);
    },
    deletes: () => {
      return deletes;
    },
    loseCreateResponse: () => {
      loseCreateResponse = true;
    },
    rejectCreate: (status: 400 | 403 | null) => {
      rejectCreateStatus = status;
    },
    holdRoute: () => {
      routeGate = {
        entered: createDeferredPromise<void>(context.signal),
        release: createDeferredPromise<void>(context.signal),
      };
      return routeGate;
    },
    holdCreate: () => {
      const gate = {
        entered: createDeferredPromise<void>(context.signal),
        release: createDeferredPromise<void>(context.signal),
      };
      createGate = gate;
      onTestFinished(() => {
        for (const deferred of [gate.entered, gate.release]) {
          if (!deferred.settled()) {
            deferred.resolve(undefined);
          }
        }
      });
      return {
        entered: gate.entered.promise,
        finish: () => {
          if (!gate.release.settled()) {
            gate.release.resolve(undefined);
          }
        },
      };
    },
    preexisting: (hostname: string) => {
      provider = {
        id: randomUUID(),
        hostname,
        status: "active",
        ssl: { method: "http", status: "active" },
      };
      providers.set(provider.id, provider);
    },
    renameProvider: (hostname: string) => {
      if (provider) {
        provider.hostname = hostname;
      }
    },
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
    certificateFailed: () => {
      certificate = "validation_timed_out";
    },
    patches: () => {
      return patches;
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
test.each(["ready", "timed_out"] as const)(
  "the background worker publishes %s without a browser and leaves the sharing address intact",
  async (outcome) => {
    const cronApp = await setupApp({
      context,
      routes: cronProcessBackgroundJobsRoutes,
      isolatePg: true,
    });
    const cron = cronApp(cronProcessBackgroundJobsContract);
    const fixture = await scenario();
    const external = domainProvider();
    const added = await add(fixture);
    const domain = added.domains[0]!;
    external.setTxt(domain.records[0]!.value);
    const clock = now();
    mockNow(clock - (outcome === "ready" ? 60_000 : 31 * 60_000));
    const verify = () => {
      return accept(
        fixture.api.verifySiteDomain({
          headers,
          params: { siteId: added.siteId, domainId: domain.id },
          body: { expectedRevision: domain.revision },
        }),
        [200],
      );
    };
    const pending = (await verify()).body.domains[0]!.verification!;
    expect(pending.automatic).toMatchObject({ status: "checking" });
    expect(
      Date.parse(pending.automatic!.expiresAt) - Date.parse(pending.checkedAt),
    ).toBe(30 * 60_000);
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    const queries = external.queries();
    mockNow(clock);
    const routeGate = outcome === "ready" ? external.holdRoute() : null;
    if (routeGate) {
      external.ready();
    }
    mockEnv("CRON_SECRET", "domain-recheck-test");
    const wake = () => {
      return accept(
        cron.process({
          headers: { authorization: "Bearer domain-recheck-test" },
        }),
        [200],
      );
    };
    const wakeup = wake();
    if (routeGate) {
      await routeGate.entered.promise;
      const live = (
        await accept(
          fixture.api.siteDomains({
            headers,
            params: { siteId: added.siteId },
          }),
          [200],
        )
      ).body;
      routeGate.release.resolve(undefined);
      expect(live.domains[0]!.verification).toMatchObject({
        automatic: pending.automatic,
        checks: {
          provider: { status: "passed" },
          certificate: { status: "passed" },
          route: { status: "pending" },
        },
      });
    }
    await wakeup;
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `hostedSiteDomainsChanged:${added.siteId}`,
      null,
    );
    const updated = (
      await accept(
        fixture.api.siteDomains({ headers, params: { siteId: added.siteId } }),
        [200],
      )
    ).body;
    expect(updated.effectiveUrl).toBe(added.defaultUrl);
    expect(updated.selectedDomainId).toBeNull();
    expect(updated.domains[0]!.ready).toBe(outcome === "ready");
    if (outcome === "timed_out") {
      expect(updated.domains[0]!.verification?.automatic).toMatchObject({
        id: pending.automatic!.id,
        status: "timed_out",
      });
      expect(external.queries()).toBe(queries);
      await wake();
      expect(external.queries()).toBe(queries);
      const restarted = (await verify()).body.domains[0]!.verification!
        .automatic!;
      expect(restarted.status).toBe("checking");
      expect(restarted.id).not.toBe(pending.automatic!.id);
      expect(Date.parse(restarted.expiresAt)).toBe(clock + 30 * 60_000);
    } else {
      expect(updated.domains[0]!.verification?.automatic).toBeUndefined();
      expect(external.creates()).toBe(1);
    }
  },
);

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
  server.use(
    http.get(
      "https://api.cloudflare.com/client/v4/zones/:zone/custom_hostnames/:id",
      () => {
        return HttpResponse.json({}, { status: 503 });
      },
    ),
  );
  const stillRemoved = (await verify()).body;
  expect(stillRemoved.domains[0]?.verification?.status).toBe("unavailable");
  expect(stillRemoved.domains[0]?.ready).toBeFalsy();
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
  settings = (await verify()).body;
  domain = settings.domains[0]!;
  settings = (
    await accept(
      fixture.api.selectSiteDomain({
        headers,
        params: { siteId: fixture.prepared.siteId },
        body: { domainId: domain.id, expectedRevision: settings.revision },
      }),
      [200],
    )
  ).body;
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
  await accept(
    setupAppWithRoutes({
      context,
      routes: artifactAccessRoutes,
      baseUrl: "https://api.okou.ai",
    })(artifactAccessContract).updateVisibility({
      headers,
      params: { artifactId: fixture.prepared.siteId },
      body: { visibility: "private" },
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
  settings = (await verify()).body;
  await accept(
    fixture.api.selectSiteDomain({
      headers,
      params,
      body: { domainId: domain.id, expectedRevision: settings.revision },
    }),
    [200],
  );
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

function verifyDomainRequest(
  fixture: Awaited<ReturnType<typeof scenario>>,
  domain: { readonly id: string; readonly revision: string },
) {
  return fixture.api.verifySiteDomain({
    headers,
    params: { siteId: fixture.prepared.siteId, domainId: domain.id },
    body: { expectedRevision: domain.revision },
  });
}
function removeDomainRequest(
  fixture: Awaited<ReturnType<typeof scenario>>,
  domain: { readonly id: string; readonly revision: string },
) {
  return fixture.api.removeSiteDomain({
    headers,
    params: { siteId: fixture.prepared.siteId, domainId: domain.id },
    body: { expectedRevision: domain.revision },
  });
}
test("does not adopt or delete a preexisting provider resource by hostname", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  external.preexisting(domain.hostname);
  const blocked = await accept(verifyDomainRequest(fixture, domain), [409]);
  expect(blocked.body.error.code).toBe("DOMAIN_IN_USE");
  const removed = await accept(removeDomainRequest(fixture, domain), [200]);
  expect(removed.body.domains).toHaveLength(0);
  expect(external.creates()).toBe(0);
  expect(external.deletes()).toBe(0);
});
test("can retry a definitively rejected provider creation without an enterprise feature", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  external.rejectCreate(403);
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const unavailable = await accept(verifyDomainRequest(fixture, domain), [200]);
  expect(unavailable.body.domains[0]?.verification?.status).toBe("unavailable");
  external.rejectCreate(null);
  const verified = await accept(verifyDomainRequest(fixture, domain), [200]);
  expect(verified.body.domains[0]?.ready).toBeTruthy();
  await accept(removeDomainRequest(fixture, domain), [200]);
  expect(external.deletes()).toBe(1);
});
test("keeps an uncertain provider creation disconnected instead of adopting or deleting by name", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  external.loseCreateResponse();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const uncertain = await accept(verifyDomainRequest(fixture, domain), [200]);
  expect(uncertain.body.domains[0]?.ready).toBeFalsy();
  const retry = await accept(verifyDomainRequest(fixture, domain), [503]);
  expect(retry.body.error.code).toBe("DOMAIN_PROVIDER_UNCONFIRMED");
  await accept(removeDomainRequest(fixture, domain), [503]);
  const settings = await accept(
    fixture.api.siteDomains({
      headers,
      params: { siteId: fixture.prepared.siteId },
    }),
    [200],
  );
  expect(settings.body.domains[0]?.removing).toBeTruthy();
  expect(settings.body.effectiveUrl).toBe(added.defaultUrl);
  expect(external.creates()).toBe(1);
  expect(external.deletes()).toBe(0);
});
test("records the exact provider ID when removal wins during creation and allows safe cleanup", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  const creating = external.holdCreate();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const verifying = verifyDomainRequest(fixture, domain);
  await creating.entered;
  const removing = await removeDomainRequest(fixture, domain);
  creating.finish();
  const verified = await verifying;
  expect(removing.status).toBe(503);
  expect(verified.status).toBe(409);
  const removed = await accept(removeDomainRequest(fixture, domain), [200]);
  expect(removed.body.domains).toHaveLength(0);
  expect(external.deletes()).toBe(1);
});
test("a provider identity mismatch disables selection and never deletes another hostname", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  const added = await add(fixture);
  const domain = added.domains[0]!;
  external.setTxt(domain.records[0]!.value);
  await accept(verifyDomainRequest(fixture, domain), [200]);
  external.renameProvider("another.customer-example.net");
  const mismatch = await accept(verifyDomainRequest(fixture, domain), [200]);
  expect(mismatch.body.domains[0]?.ready).toBeFalsy();
  await accept(removeDomainRequest(fixture, domain), [503]);
  expect(external.deletes()).toBe(0);
});

test("http certificate validation keeps the configuration to one ownership TXT and one CNAME", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  const domain = (await add(fixture)).domains[0]!;
  external.setTxt(domain.records[0]!.value);
  external.extraRecords([
    {
      txt_name: `_acme-challenge.${domain.hostname}`,
      txt_value: "certificate-one",
    },
    {
      txt_name: `_acme-challenge.${domain.hostname}`,
      txt_value: "certificate-two",
    },
  ]);
  const checked = (await accept(verifyDomainRequest(fixture, domain), [200]))
    .body.domains[0]!;
  expect(checked.records).toStrictEqual(domain.records);
  expect(
    checked.records.map((record) => {
      return record.type;
    }),
  ).toStrictEqual(["TXT", "CNAME"]);
  expect(checked.verification!.checks.certificate.status).toBe("pending");
  expect(checked.verification!.checks.route.status).toBe("pending");
  expect(
    checked.verification!.recordChecks.every((check) => {
      return check.status === "passed";
    }),
  ).toBeTruthy();
  external.ready();
  const ready = (await accept(verifyDomainRequest(fixture, checked), [200]))
    .body.domains[0]!;
  expect(ready.ready).toBeTruthy();
  expect(ready.records).toStrictEqual(domain.records);
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

test("a pending TXT certificate switches to HTTP without resetting TLS settings", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  const domain = (await add(fixture)).domains[0]!;
  external.setTxt(domain.records[0]!.value);
  await accept(verifyDomainRequest(fixture, domain), [200]);
  external.txtValidation();
  const migrated = (await accept(verifyDomainRequest(fixture, domain), [200]))
    .body.domains[0]!;
  expect(migrated.verification!.status).toBe("incomplete");
  expect(migrated.records).toStrictEqual(domain.records);
  expect(migrated.verification!.checks.certificate.status).toBe("pending");
  external.ready();
  const ready = (await accept(verifyDomainRequest(fixture, migrated), [200]))
    .body.domains[0]!;
  expect(ready.ready).toBeTruthy();
  expect(external.patches()).toBe(1);
});

test("an active TXT certificate remains active without replacing its validation settings", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  const domain = (await add(fixture)).domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const verified = (await accept(verifyDomainRequest(fixture, domain), [200]))
    .body.domains[0]!;
  external.txtValidation();
  const checked = (await accept(verifyDomainRequest(fixture, verified), [200]))
    .body.domains[0]!;
  expect(checked.ready).toBeTruthy();
  expect(external.patches()).toBe(0);
  expect(external.creates()).toBe(1);
});

test("certificate validation failure is actionable without new DNS records", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.certificateFailed();
  const domain = (await add(fixture)).domains[0]!;
  external.setTxt(domain.records[0]!.value);
  const checked = (await accept(verifyDomainRequest(fixture, domain), [200]))
    .body.domains[0]!;
  expect(checked.ready).toBeFalsy();
  expect(checked.verification!.checks.certificate).toStrictEqual({
    status: "failed",
    message:
      "HTTPS certificate setup timed out. Verify again or contact support.",
  });
  expect(checked.records).toStrictEqual(domain.records);
  expect(external.creates()).toBe(1);
});

test("only the saved domain serves a website and switching retains configured domains", async () => {
  const fixture = await scenario();
  const external = domainProvider();
  external.ready();
  const first = (await add(fixture)).domains[0]!;
  external.recordValues(first.records[0]!.name, [first.records[0]!.value]);
  let settings = (await accept(verifyDomainRequest(fixture, first), [200]))
    .body;
  const select = async (domainId: string | null) => {
    settings = (
      await accept(
        fixture.api.selectSiteDomain({
          headers,
          params: { siteId: fixture.prepared.siteId },
          body: { domainId, expectedRevision: settings.revision },
        }),
        [200],
      )
    ).body;
  };
  const resolve = async (hostname: string) => {
    return (
      await accept(
        fixture.api.resolveCustomDomain({ params: { hostname } }),
        [200],
      )
    ).body;
  };
  await select(first.id);
  expect((await resolve(first.hostname))?.siteId).toBe(fixture.prepared.siteId);
  const secondHostname = `second-${fixture.name}.customer-example.net`;
  await add(fixture, secondHostname);
  const listed = (
    await accept(
      fixture.api.siteDomains({
        headers,
        params: { siteId: fixture.prepared.siteId },
      }),
      [200],
    )
  ).body;
  expect(listed.domains).toContainEqual(settings.domains[0]);
  const second = listed.domains.find((domain) => {
    return domain.hostname === secondHostname;
  })!;
  expect(second).toMatchObject({ ready: false, verification: null });
  external.recordValues(second.records[0]!.name, [second.records[0]!.value]);
  settings = (await accept(verifyDomainRequest(fixture, second), [200])).body;
  await expect(resolve(second.hostname)).resolves.toBeNull();
  await select(second.id);
  await expect(resolve(first.hostname)).resolves.toBeNull();
  expect((await resolve(second.hostname))?.siteId).toBe(
    fixture.prepared.siteId,
  );
  await select(first.id);
  expect((await resolve(first.hostname))?.siteId).toBe(fixture.prepared.siteId);
  await expect(resolve(second.hostname)).resolves.toBeNull();
  await select(null);
  await expect(resolve(first.hostname)).resolves.toBeNull();
  await expect(resolve(second.hostname)).resolves.toBeNull();
  expect(settings.domains).toHaveLength(2);
});

function dnsSetupProvider(
  kind: "cloudflare" | "vercel",
  options: { supported?: boolean; publicKey?: string } = {},
) {
  const base =
    kind === "cloudflare"
      ? "https://api.cloudflare.com/client/v4/dns/domainconnect"
      : "https://domainconnect.vercel.com";
  const api =
    kind === "cloudflare" ? base : "https://vercel.com/api/domain-connect";
  const ux =
    kind === "cloudflare"
      ? "https://dash.cloudflare.com/domainconnect"
      : "https://vercel.com/domain-connect";
  server.use(
    http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
      const url = new URL(request.url);
      const name = url.searchParams.get("name")!;
      const discovery = name === "_domainconnect.customer-example.net";
      const key = name === "_test.domainconnect.okou.ai";
      return HttpResponse.json({
        Status: 0,
        Answer: discovery
          ? [
              {
                name,
                type: kind === "vercel" ? 5 : 16,
                data:
                  kind === "vercel"
                    ? "domainconnect.vercel.com."
                    : JSON.stringify(base.slice("https://".length)),
              },
            ]
          : key && options.publicKey
            ? [
                {
                  name,
                  type: 16,
                  data: JSON.stringify(`p=1,a=RS256,d=${options.publicKey}`),
                },
              ]
            : [],
      });
    }),
    http.get(`${base}/v2/customer-example.net/settings`, () => {
      return HttpResponse.json({
        providerId: kind === "cloudflare" ? "cloudflare.com" : "vercel.com",
        providerName: kind,
        urlAPI: api,
        urlSyncUX: ux,
      });
    }),
    http.get(
      `${api}/v2/domainTemplates/providers/okou.ai/services/hosted-site`,
      () => {
        return new HttpResponse(null, {
          status: options.supported === false ? 404 : 200,
        });
      },
    ),
  );
}

test.each(["cloudflare", "vercel"] as const)(
  "offers a signed %s apply URL only for the owned domain and supported Okou template",
  async (kind) => {
    const fixture = await scenario();
    domainProvider();
    const domain = (await add(fixture)).domains[0]!;
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    mockEnv(
      "HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64",
      keys.privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64"),
    );
    mockEnv("HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST", "_test");
    mockEnv("APP_URL", "https://app.okou.ai");
    dnsSetupProvider(kind, {
      publicKey: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    });
    const setup = (
      await accept(
        fixture.api.siteDomainSetup({
          headers,
          params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        }),
        [200],
      )
    ).body;
    expect(setup.status).toBe("supported");
    const url = new URL(setup.automaticUrl!);
    expect(url.pathname).toContain(
      "/providers/okou.ai/services/hosted-site/apply",
    );
    expect(url.searchParams.get("domain")).toBe("customer-example.net");
    expect(url.searchParams.get("host")).toBe(
      domain.hostname.slice(0, -".customer-example.net".length),
    );
    expect(url.searchParams.get("target")).toBe("connect");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/artifacts",
    );
    expect([...url.searchParams.keys()].at(-1)).toBe("sig");
    const signature = url.searchParams.get("sig")!;
    url.searchParams.delete("sig");
    url.searchParams.delete("key");
    expect([...url.searchParams.keys()]).toStrictEqual(
      [...url.searchParams.keys()].sort(),
    );
    expect(
      verifySignature(
        "RSA-SHA256",
        Buffer.from(url.searchParams.toString()),
        keys.publicKey,
        Buffer.from(signature, "base64"),
      ),
    ).toBeTruthy();
    const saved = (
      await accept(
        fixture.api.siteDomains({
          headers,
          params: { siteId: fixture.prepared.siteId },
        }),
        [200],
      )
    ).body;
    expect(saved.selectedDomainId).toBeNull();
    expect(saved.domains[0]!.verification).toBeNull();
  },
);

test("keeps manual DNS setup when only other templates are supported", async () => {
  const fixture = await scenario();
  domainProvider();
  const domain = (await add(fixture)).domains[0]!;
  dnsSetupProvider("cloudflare", { supported: false });
  const setup = (
    await accept(
      fixture.api.siteDomainSetup({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
      }),
      [200],
    )
  ).body;
  expect(setup).toMatchObject({
    status: "manual",
    providerName: "Cloudflare",
    controlPanelUrl: "https://dash.cloudflare.com/",
    automaticUrl: null,
  });
});

test("never follows an untrusted DNS discovery endpoint", async () => {
  const fixture = await scenario();
  domainProvider();
  const domain = (await add(fixture)).domains[0]!;
  server.use(
    http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
      const name = new URL(request.url).searchParams.get("name")!;
      return HttpResponse.json({
        Status: 0,
        Answer: [{ name, type: 16, data: JSON.stringify("127.0.0.1/private") }],
      });
    }),
  );
  const setup = (
    await accept(
      fixture.api.siteDomainSetup({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
      }),
      [200],
    )
  ).body;
  expect(setup.automaticUrl).toBeNull();
  expect(setup.controlPanelUrl).toBeNull();
});

test("domain setup is denied when the feature is off and remains scoped to the website owner", async () => {
  const fixture = await scenario();
  domainProvider();
  const domain = (await add(fixture)).domains[0]!;
  const other = createBddApi(context).user();
  await createBddApi(context).readMe(other);
  const otherDenied = await accept(
    client(other)(hostContract).siteDomainSetup({
      headers,
      params: { siteId: fixture.prepared.siteId, domainId: domain.id },
    }),
    [404],
  );
  expect(otherDenied.status).toBe(404);
  await accept(
    client(fixture.owner)(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.HostedSiteCustomDomains]: false } },
    }),
    [200],
  );
  const disabled = await accept(
    fixture.api.siteDomainSetup({
      headers,
      params: { siteId: fixture.prepared.siteId, domainId: domain.id },
    }),
    [403],
  );
  expect(disabled.status).toBe(403);
});

test("a delegated zone cannot inherit automatic setup from its parent provider", async () => {
  const fixture = await scenario();
  domainProvider();
  const domain = (await add(fixture)).domains[0]!;
  dnsSetupProvider("vercel");
  server.use(
    http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
      const url = new URL(request.url);
      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");
      return HttpResponse.json({
        Status: 0,
        Answer:
          name === domain.hostname && type === "NS"
            ? [{ name, type: 2, data: "ns1.dnspod.net." }]
            : name === "_domainconnect.customer-example.net"
              ? [{ name, type: 16, data: '"domainconnect.vercel.com"' }]
              : [],
      });
    }),
  );
  const setup = (
    await accept(
      fixture.api.siteDomainSetup({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
      }),
      [200],
    )
  ).body;
  expect(setup).toMatchObject({
    status: "manual",
    providerName: "DNSPod",
    controlPanelUrl: "https://console.dnspod.cn/",
    automaticUrl: null,
  });
});

test("a supported template without a published signing key keeps manual setup available", async () => {
  const fixture = await scenario();
  domainProvider();
  const domain = (await add(fixture)).domains[0]!;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  mockEnv(
    "HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64",
    keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  );
  mockEnv("HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST", "_unpublished");
  dnsSetupProvider("vercel");
  const setup = (
    await accept(
      fixture.api.siteDomainSetup({
        headers,
        params: { siteId: fixture.prepared.siteId, domainId: domain.id },
      }),
      [200],
    )
  ).body;
  expect(setup).toMatchObject({
    status: "manual",
    providerName: "Vercel",
    automaticUrl: null,
  });
});

test.each(["connect.other.example", "nested.connect.okou.app"])(
  "does not offer a signed template for a target outside its fixed target pattern: %s",
  async (target) => {
    const fixture = await scenario();
    domainProvider();
    mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_TARGET", target);
    const domain = (await add(fixture)).domains[0]!;
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    mockEnv(
      "HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64",
      keys.privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64"),
    );
    mockEnv("HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST", "_test");
    dnsSetupProvider("cloudflare", {
      publicKey: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    });
    const setup = (
      await accept(
        fixture.api.siteDomainSetup({
          headers,
          params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        }),
        [200],
      )
    ).body;
    expect(setup).toMatchObject({
      status: "manual",
      providerName: "Cloudflare",
      automaticUrl: null,
    });
  },
);

test("free workspaces cannot request automatic DNS setup", async () => {
  const fixture = await scenario(false);
  const denied = await accept(
    fixture.api.siteDomainSetup({
      headers,
      params: { siteId: fixture.prepared.siteId, domainId: randomUUID() },
    }),
    [402],
  );
  expect(denied.status).toBe(402);
});

test.each(["untrusted URL", "invalid JSON"])(
  "keeps manual setup for provider settings with %s",
  async (failure) => {
    const fixture = await scenario();
    domainProvider();
    const domain = (await add(fixture)).domains[0]!;
    dnsSetupProvider("vercel");
    server.use(
      http.get(
        "https://domainconnect.vercel.com/v2/customer-example.net/settings",
        () => {
          if (failure === "invalid JSON") {
            return new HttpResponse("not JSON", {
              headers: { "Content-Type": "application/json" },
            });
          }
          return HttpResponse.json({
            providerId: "vercel.com",
            providerName: "Vercel",
            urlAPI: "https://untrusted.example/collect",
            urlSyncUX: "https://vercel.com/domain-connect",
          });
        },
      ),
    );
    const setup = (
      await accept(
        fixture.api.siteDomainSetup({
          headers,
          params: { siteId: fixture.prepared.siteId, domainId: domain.id },
        }),
        [200],
      )
    ).body;
    expect(setup).toMatchObject({
      status: "unavailable",
      providerName: "Vercel",
      controlPanelUrl: "https://vercel.com/domains",
      automaticUrl: null,
    });
  },
);
