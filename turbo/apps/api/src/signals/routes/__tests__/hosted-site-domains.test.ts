import {
  createHash,
  generateKeyPair,
  type KeyObject,
  randomUUID,
  verify,
} from "node:crypto";
import { promisify } from "node:util";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { HOSTED_DOMAIN_PROBE_HEADER } from "@okouai/api-contracts/contracts/hosted-site-domains";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { hostedSiteDomainRoutes } from "../hosted-site-domains";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const host = createHostBddApi(context);
const TARGET = "connect.okou.app";
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const WORKER = "okou-host-worker";
const DNS_TYPES: Readonly<Record<string, number>> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  TXT: 16,
  AAAA: 28,
};

interface DnsAnswer {
  readonly name: string;
  readonly type: number;
  readonly data: string;
}

interface ProviderHostname {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; method: string };
}

function domainsApi() {
  return setupApp({ context, routes: hostedSiteDomainRoutes })(hostContract);
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function member(): Promise<ApiTestUser> {
  const user = bdd.user({ orgRole: "org:admin" });
  await store.set(
    seedOrgMembership$,
    { orgId: user.orgId ?? "", userId: user.userId, role: "admin" },
    context.signal,
  );
  return user;
}

/** Stripe records a paid Pro invoice for the owner's workspace. */
async function upgrade(owner: ApiTestUser) {
  await postSubscriptionInvoicePaid(context.signal, {
    orgId: owner.orgId ?? "",
    userId: owner.userId,
    tier: "pro",
    customerId: generatedStripeCustomerId(),
    subscriptionId: generatedStripeSubscriptionId(),
    currentPeriodEnd: new Date(now() + 30 * 86_400_000),
  });
}

async function enableCustomDomains(owner: ApiTestUser) {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: owner.userId,
      orgId: owner.orgId ?? "",
      orgRole: owner.orgRole,
    },
    { [FeatureSwitchKey.HostedSiteCustomDomains]: true },
  );
}

async function publishPublicSite(owner: ApiTestUser) {
  host.captureHostedSitesS3();
  const html = "<h1>Hosted</h1>";
  const prepared = await host.prepareHostedSite(owner, {
    site: `site-${randomUUID().slice(0, 8)}`,
    title: "Hosted page",
    visibility: "public",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [
      {
        path: "/index.html",
        size: Buffer.byteLength(html),
        sha256: createHash("sha256").update(html).digest("hex"),
        contentType: "text/html; charset=utf-8",
      },
    ],
  });
  await host.completeHostedSite(owner, prepared.deploymentId);
  return { siteId: prepared.siteId, publicSlug: prepared.publicSlug };
}

/** Public DNS over HTTPS: answers come from the records the test publishes. */
function installDns() {
  const records = new Map<string, DnsAnswer[]>();
  const queries: string[] = [];
  server.use(
    http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
      const url = new URL(request.url);
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type") ?? "";
      queries.push(`${name} ${type}`);
      const answers = records.get(`${name.toLowerCase()} ${type}`) ?? [];
      return HttpResponse.json({
        Status: 0,
        ...(answers.length ? { Answer: answers } : {}),
      });
    }),
  );
  return {
    queries,
    set(name: string, type: string, values: readonly string[]) {
      records.set(
        `${name} ${type}`,
        values.map((data) => {
          return { name: `${name}.`, type: DNS_TYPES[type] ?? 0, data };
        }),
      );
    },
  };
}

/** Cloudflare for SaaS: custom hostnames, fallback origin, Worker route and ingress probe. */
function installProvider(
  options: { readonly preexisting?: readonly string[] } = {},
) {
  const hostnames = new Map<string, ProviderHostname>();
  const created: string[] = [];
  const deleted: string[] = [];
  let certificate = "pending_validation";
  let status = "pending";
  const base = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}`;
  const current = (hostname: ProviderHostname) => {
    return {
      ...hostname,
      status,
      ssl: { ...hostname.ssl, status: certificate },
    };
  };
  const envelope = (result: unknown) => {
    return HttpResponse.json({ success: true, result, errors: [] });
  };
  for (const hostname of options.preexisting ?? []) {
    hostnames.set(`foreign-${hostname}`, {
      id: `foreign-${hostname}`,
      hostname,
      status: "active",
      ssl: { status: "active", method: "http" },
    });
  }
  server.use(
    http.get(`${base}/custom_hostnames/fallback_origin`, () => {
      return envelope({ origin: "origin.okou.app", status: "active" });
    }),
    http.get(`${base}/workers/routes`, () => {
      return envelope([{ pattern: "*/*", script: WORKER }]);
    }),
    http.get(`${base}/custom_hostnames`, ({ request }) => {
      const wanted = new URL(request.url).searchParams.get("hostname");
      return envelope(
        [...hostnames.values()]
          .filter((hostname) => {
            return hostname.hostname === wanted;
          })
          .map(current),
      );
    }),
    http.post(`${base}/custom_hostnames`, async ({ request }) => {
      const body = (await request.json()) as { readonly hostname: string };
      const hostname: ProviderHostname = {
        id: `cf-${randomUUID()}`,
        hostname: body.hostname,
        status,
        ssl: { status: certificate, method: "http" },
      };
      hostnames.set(hostname.id, hostname);
      created.push(body.hostname);
      return envelope(current(hostname));
    }),
    http.get(`${base}/custom_hostnames/:id`, ({ params }) => {
      const hostname = hostnames.get(String(params.id));
      return hostname
        ? envelope(current(hostname))
        : HttpResponse.json(
            { success: false, result: null, errors: [] },
            { status: 404 },
          );
    }),
    http.delete(`${base}/custom_hostnames/:id`, ({ params }) => {
      hostnames.delete(String(params.id));
      deleted.push(String(params.id));
      return envelope({ id: String(params.id) });
    }),
    http.get(`https://${TARGET}/.okou/domain-verification`, ({ request }) => {
      const proof = new URL(request.url).searchParams.get("proof");
      return HttpResponse.json(
        { proof },
        { headers: { [HOSTED_DOMAIN_PROBE_HEADER]: "1" } },
      );
    }),
  );
  return {
    created,
    deleted,
    activate() {
      certificate = "active";
      status = "active";
    },
  };
}

/** A Pro owner with custom domains enabled and a published public site. */
async function paidOwnerWithSite() {
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_TARGET", TARGET);
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_ZONE_ID", ZONE_ID);
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_API_TOKEN", `token-${randomUUID()}`);
  mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_WORKER", WORKER);
  const owner = await member();
  await upgrade(owner);
  const [site] = await Promise.all([
    publishPublicSite(owner),
    enableCustomDomains(owner),
  ]);
  return { owner, site };
}

async function addDomain(owner: ApiTestUser, siteId: string, hostname: string) {
  const added = await accept(
    domainsApi().addSiteDomain({
      headers: signIn(owner),
      params: { siteId },
      body: { hostname },
    }),
    [200],
  );
  const domain = added.body.domains.find((candidate) => {
    return candidate.hostname === hostname;
  });
  if (!domain) {
    throw new Error(`Expected ${hostname} in the domain settings`);
  }
  const ownership = domain.records.find((record) => {
    return record.type === "TXT";
  });
  if (!ownership) {
    throw new Error("Expected a TXT ownership record");
  }
  return { settings: added.body, domain, ownership };
}

/** Concurrent add attempts; returns their HTTP statuses in request order. */
async function addHostnames(
  owner: ApiTestUser,
  siteId: string,
  hostnames: readonly string[],
) {
  const headers = signIn(owner);
  const responses = await Promise.all(
    hostnames.map((hostname) => {
      return domainsApi().addSiteDomain({
        headers,
        params: { siteId },
        body: { hostname },
      });
    }),
  );
  return responses.map((response) => {
    return response.status;
  });
}

function verifyDomain(
  owner: ApiTestUser,
  siteId: string,
  domain: { readonly id: string; readonly revision: string },
) {
  return domainsApi().verifySiteDomain({
    headers: signIn(owner),
    params: { siteId, domainId: domain.id },
    body: { expectedRevision: domain.revision },
  });
}

function domainOf(
  settings: {
    readonly domains: readonly {
      readonly id: string;
      readonly hostname: string;
      readonly revision: string;
      readonly ready: boolean;
      readonly removing: boolean;
      readonly verification: {
        readonly status: string;
        readonly checks: Readonly<Record<string, { readonly status: string }>>;
      } | null;
    }[];
  },
  id: string,
) {
  const domain = settings.domains.find((candidate) => {
    return candidate.id === id;
  });
  if (!domain) {
    throw new Error(`Expected domain ${id}`);
  }
  return domain;
}

describe("hosted site custom domains", () => {
  it("hosted-site-domains-004 refuses custom domains for a free workspace with the rollout enabled", async () => {
    mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_TARGET", TARGET);
    const owner = await member();
    await enableCustomDomains(owner);
    const site = await publishPublicSite(owner);

    const added = await domainsApi().addSiteDomain({
      headers: signIn(owner),
      params: { siteId: site.siteId },
      body: { hostname: "www.customer-example.net" },
    });

    expect(added.status).toBe(402);
  });

  it("hosted-site-domains-005 keeps domain configuration scoped to the website owner", async () => {
    const { site } = await paidOwnerWithSite();
    const stranger = await member();
    const headers = signIn(stranger);

    const read = await domainsApi().siteDomains({
      headers,
      params: { siteId: site.siteId },
    });
    const added = await domainsApi().addSiteDomain({
      headers,
      params: { siteId: site.siteId },
      body: { hostname: "www.customer-example.net" },
    });

    expect([read.status, added.status]).toStrictEqual([404, 404]);
  });

  it("hosted-site-domains-003 (1/3) rejects URL syntax and local addresses before DNS", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();

    const rejected = await addHostnames(owner, site.siteId, [
      "https://example.net/path",
      "example.net/ignored",
      "127.0.0.1",
      "localhost",
      "*.example.net",
    ]);

    expect(rejected).toStrictEqual([400, 400, 400, 400, 400]);
    expect(dns.queries).toStrictEqual([]);
  });

  it("hosted-site-domains-003 (2/3) rejects public suffixes, reserved platform hosts and ports before DNS", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();

    const rejected = await addHostnames(owner, site.siteId, [
      "co.uk",
      "foo.okou.app",
      "foo.vm0.io",
      "user@example.net",
      "example.net:443",
    ]);

    expect(rejected).toStrictEqual([400, 400, 400, 400, 400]);
    expect(dns.queries).toStrictEqual([]);
  });

  it("hosted-site-domains-003 (3/3) normalizes an uppercase fully qualified hostname without DNS", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();

    const added = await accept(
      domainsApi().addSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { hostname: "WWW.CUSTOMER-EXAMPLE.NET." },
      }),
      [200],
    );

    expect(
      added.body.domains.map((domain) => {
        return domain.hostname;
      }),
    ).toStrictEqual(["www.customer-example.net"]);
    expect(dns.queries).toStrictEqual([]);
  });

  it("hosted-site-domains-001 (1/2) reports a pending certificate once, then makes the hostname selectable without applying it", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();
    const provider = installProvider();
    const hostname = `${site.publicSlug}.customer-example.net`;
    const { settings, domain, ownership } = await addDomain(
      owner,
      site.siteId,
      hostname,
    );
    expect(settings.effectiveUrl).toBe(settings.defaultUrl);
    expect(dns.queries).toStrictEqual([]);
    expect(provider.created).toStrictEqual([]);
    dns.set(ownership.name, "TXT", [`"${ownership.value}"`]);
    dns.set(hostname, "CNAME", [`${TARGET}.`]);

    const pending = await accept(
      verifyDomain(owner, site.siteId, domain),
      [200],
    );
    const pendingDomain = domainOf(pending.body, domain.id);
    expect(pendingDomain.ready).toBeFalsy();
    expect(pendingDomain.verification?.checks.certificate?.status).toBe(
      "pending",
    );

    provider.activate();
    const verified = await accept(
      verifyDomain(owner, site.siteId, pendingDomain),
      [200],
    );
    expect(provider.created).toStrictEqual([hostname]);
    expect(domainOf(verified.body, domain.id).ready).toBeTruthy();
    expect(verified.body.selectedDomainId).toBeNull();
    expect(verified.body.effectiveUrl).toBe(settings.defaultUrl);
  });

  it("hosted-site-domains-001 (2/2) selects, resolves and removes the verified hostname", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();
    const provider = installProvider();
    provider.activate();
    const hostname = `${site.publicSlug}.customer-example.net`;
    const { settings, domain, ownership } = await addDomain(
      owner,
      site.siteId,
      hostname,
    );
    dns.set(ownership.name, "TXT", [`"${ownership.value}"`]);
    dns.set(hostname, "CNAME", [`${TARGET}.`]);
    const verified = await accept(
      verifyDomain(owner, site.siteId, domain),
      [200],
    );

    const selected = await accept(
      domainsApi().selectSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { domainId: domain.id, expectedRevision: verified.body.revision },
      }),
      [200],
    );
    expect(selected.body.effectiveUrl).toBe(`https://${hostname}`);
    const resolved = await accept(
      domainsApi().resolveCustomDomain({ params: { hostname } }),
      [200],
    );
    expect(resolved.body?.siteId).toBe(site.siteId);

    await accept(
      domainsApi().selectSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { domainId: null, expectedRevision: verified.body.revision },
      }),
      [409],
    );
    await accept(
      domainsApi().removeSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId, domainId: domain.id },
        body: {
          expectedRevision: domainOf(selected.body, domain.id).revision,
        },
      }),
      [200],
    );
    const released = await accept(
      domainsApi().resolveCustomDomain({ params: { hostname } }),
      [200],
    );
    expect(released.body).toBeNull();
    const listed = await accept(
      domainsApi().siteDomains({
        headers: signIn(owner),
        params: { siteId: site.siteId },
      }),
      [200],
    );
    expect(listed.body.domains).toStrictEqual([]);
    expect(listed.body.effectiveUrl).toBe(settings.defaultUrl);
  });

  it("hosted-site-domains-002 keeps TXT ownership independent of a correct CNAME", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();
    const provider = installProvider();
    const hostname = `${site.publicSlug}.customer-example.net`;
    const { ownership, domain } = await addDomain(owner, site.siteId, hostname);
    dns.set(ownership.name, "TXT", ['"okou-verification=wrong"']);
    dns.set(hostname, "CNAME", [`${TARGET}.`]);

    const verified = await accept(
      verifyDomain(owner, site.siteId, domain),
      [200],
    );
    expect(
      domainOf(verified.body, domain.id).verification?.checks.ownership?.status,
    ).toBe("failed");
    expect(provider.created).toStrictEqual([]);
    await accept(
      domainsApi().selectSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { domainId: domain.id, expectedRevision: verified.body.revision },
      }),
      [409],
    );
  });

  it("hosted-site-domains-006 connects a root domain only through configured Apex Proxying addresses", async () => {
    const { owner, site } = await paidOwnerWithSite();
    mockEnv("HOSTED_SITE_CUSTOM_DOMAIN_APEX_ADDRESSES", "203.0.113.3");
    const dns = installDns();
    const provider = installProvider();
    provider.activate();
    const hostname = `${site.publicSlug}.net`;
    const { domain, ownership } = await addDomain(owner, site.siteId, hostname);
    expect(domain.records).toContainEqual({
      type: "A",
      name: hostname,
      value: "203.0.113.3",
    });
    dns.set(ownership.name, "TXT", [`"${ownership.value}"`]);
    dns.set(hostname, "A", ["203.0.113.3"]);

    const verified = await accept(
      verifyDomain(owner, site.siteId, domain),
      [200],
    );
    expect(domainOf(verified.body, domain.id).ready).toBeTruthy();
  });

  it("hosted-site-domains-011 neither adopts nor deletes a provider hostname Okou did not create", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();
    const hostname = `${site.publicSlug}.customer-example.net`;
    const provider = installProvider({ preexisting: [hostname] });
    const { domain, ownership } = await addDomain(owner, site.siteId, hostname);
    dns.set(ownership.name, "TXT", [`"${ownership.value}"`]);
    dns.set(hostname, "CNAME", [`${TARGET}.`]);

    const conflict = await accept(
      verifyDomain(owner, site.siteId, domain),
      [409],
    );
    expect(conflict.body.error.code).toBe("DOMAIN_IN_USE");
    const removed = await accept(
      domainsApi().removeSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId, domainId: domain.id },
        body: { expectedRevision: domain.revision },
      }),
      [200],
    );
    expect(removed.body.domains).toStrictEqual([]);
    expect(provider.created).toStrictEqual([]);
    expect(provider.deleted).toStrictEqual([]);
  });

  it("hosted-site-domains-009 revokes the custom hostname when the website goes offline and keeps manual cleanup", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();
    const provider = installProvider();
    provider.activate();
    const hostname = `${site.publicSlug}.customer-example.net`;
    const { domain, ownership } = await addDomain(owner, site.siteId, hostname);
    dns.set(ownership.name, "TXT", [`"${ownership.value}"`]);
    dns.set(hostname, "CNAME", [`${TARGET}.`]);
    const verified = await accept(
      verifyDomain(owner, site.siteId, domain),
      [200],
    );
    await accept(
      domainsApi().selectSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId },
        body: { domainId: domain.id, expectedRevision: verified.body.revision },
      }),
      [200],
    );

    await host.deleteHostedSite(owner, site.publicSlug);
    const resolved = await accept(
      domainsApi().resolveCustomDomain({ params: { hostname } }),
      [200],
    );
    const settings = await accept(
      domainsApi().siteDomains({
        headers: signIn(owner),
        params: { siteId: site.siteId },
      }),
      [200],
    );
    const removing = domainOf(settings.body, domain.id);

    expect(resolved.body).toBeNull();
    expect(settings.body.selectedDomainId).toBeNull();
    expect(removing.removing).toBeTruthy();
    await accept(
      domainsApi().removeSiteDomain({
        headers: signIn(owner),
        params: { siteId: site.siteId, domainId: domain.id },
        body: { expectedRevision: removing.revision },
      }),
      [200],
    );
  });
});

/** Domain Connect discovery for the zone of `<site>.customer-example.net`. */
function installDomainConnect(
  dns: ReturnType<typeof installDns>,
  provider: "cloudflare" | "vercel",
  templateSupported: boolean,
) {
  const discovery =
    provider === "cloudflare"
      ? {
          record: "api.cloudflare.com/client/v4/dns/domainconnect",
          api: "https://api.cloudflare.com/client/v4/dns/domainconnect",
          ux: "https://dash.cloudflare.com/domainconnect",
        }
      : {
          record: "domainconnect.vercel.com",
          api: "https://domainconnect.vercel.com",
          ux: "https://vercel.com/domain-connect",
        };
  dns.set("_domainconnect.customer-example.net", "TXT", [
    `"${discovery.record}"`,
  ]);
  server.use(
    http.get(
      `https://${discovery.record}/v2/customer-example.net/settings`,
      () => {
        return HttpResponse.json({
          providerId: provider,
          providerName: provider,
          urlAPI: discovery.api,
          urlSyncUX: discovery.ux,
        });
      },
    ),
    http.get(
      `${discovery.api}/v2/domainTemplates/providers/okou.ai/services/hosted-site`,
      () => {
        return templateSupported
          ? HttpResponse.json({
              providerId: "okou.ai",
              serviceId: "hosted-site",
            })
          : new HttpResponse(null, { status: 404 });
      },
    ),
  );
  return discovery;
}

/** A Domain Connect signing key whose public half is published under `_test`. */
function publishSigningKey(
  dns: ReturnType<typeof installDns>,
  { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject },
) {
  mockEnv(
    "HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64",
    privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  );
  mockEnv("HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST", "_test");
  const published = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const chunks = `p=1,a=RS256,d=${published}`.match(/.{1,200}/gu) ?? [];
  dns.set("_test.domainconnect.okou.ai", "TXT", [
    chunks
      .map((chunk) => {
        return `"${chunk}"`;
      })
      .join(" "),
  ]);
  return publicKey;
}

async function signedApplyScenario(provider: "cloudflare" | "vercel") {
  // Key generation runs off the request path while the owner publishes.
  const signingKey = promisify(generateKeyPair)("rsa", {
    modulusLength: 2048,
  });
  const { owner, site } = await paidOwnerWithSite();
  mockEnv("APP_URL", "https://app.okou.ai");
  const dns = installDns();
  const discovery = installDomainConnect(dns, provider, true);
  const publicKey = publishSigningKey(dns, await signingKey);
  const hostname = `${site.publicSlug}.customer-example.net`;
  const { domain } = await addDomain(owner, site.siteId, hostname);

  const setup = await accept(
    domainsApi().siteDomainSetup({
      headers: signIn(owner),
      params: { siteId: site.siteId, domainId: domain.id },
    }),
    [200],
  );
  const listed = await accept(
    domainsApi().siteDomains({
      headers: signIn(owner),
      params: { siteId: site.siteId },
    }),
    [200],
  );

  expect(setup.body.status).toBe("supported");
  const automatic = new URL(setup.body.automaticUrl ?? "");
  expect(automatic.origin).toBe(new URL(discovery.ux).origin);
  expect(automatic.pathname).toContain(
    "/providers/okou.ai/services/hosted-site/apply",
  );
  const params = [...automatic.searchParams.entries()];
  expect(params.at(-1)?.[0]).toBe("sig");
  expect(automatic.searchParams.get("domain")).toBe("customer-example.net");
  expect(automatic.searchParams.get("host")).toBe(site.publicSlug);
  expect(automatic.searchParams.get("target")).toBe("connect");
  expect(automatic.searchParams.get("redirect_uri")).toBe(
    "https://app.okou.ai/artifacts",
  );
  const signedParams = params.filter(([name]) => {
    return name !== "sig" && name !== "key";
  });
  const names = signedParams.map(([name]) => {
    return name;
  });
  expect(names).toStrictEqual([...names].sort());
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(new URLSearchParams(signedParams).toString()),
      publicKey,
      Buffer.from(automatic.searchParams.get("sig") ?? "", "base64"),
    ),
  ).toBeTruthy();
  expect(listed.body.selectedDomainId).toBeNull();
  expect(domainOf(listed.body, domain.id).verification).toBeNull();
}

describe("hosted site custom domain setup", () => {
  it("hosted-site-domains-017 offers a signed Cloudflare apply URL for the owned domain and Okou template", async () => {
    await expect(signedApplyScenario("cloudflare")).resolves.toBeUndefined();
  });

  it("hosted-site-domains-018 offers a signed Vercel apply URL for the owned domain and Okou template", async () => {
    await expect(signedApplyScenario("vercel")).resolves.toBeUndefined();
  });

  it("hosted-site-domains-019 keeps manual DNS setup when only other templates are supported", async () => {
    const { owner, site } = await paidOwnerWithSite();
    const dns = installDns();
    installDomainConnect(dns, "cloudflare", false);
    const hostname = `${site.publicSlug}.customer-example.net`;
    const { domain } = await addDomain(owner, site.siteId, hostname);

    const setup = await accept(
      domainsApi().siteDomainSetup({
        headers: signIn(owner),
        params: { siteId: site.siteId, domainId: domain.id },
      }),
      [200],
    );

    expect(setup.body).toStrictEqual({
      status: "manual",
      providerName: "Cloudflare",
      controlPanelUrl: "https://dash.cloudflare.com/",
      automaticUrl: null,
    });
  });
});
