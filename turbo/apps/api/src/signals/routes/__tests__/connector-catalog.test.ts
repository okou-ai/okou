import { randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { DomUtils, parseDocument } from "htmlparser2";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { connectorCatalogRoutes } from "../connector-catalog";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockStripeCliDashboardAuth,
} from "./helpers/api-bdd-connectors";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const INTERNAL_CONNECTOR_SLUGS = Object.freeze([
  "maskdb",
  "db9",
  "drive9",
  "slock",
  "runtime",
]);
const ONE_CLICK_GRANT_KINDS: readonly string[] = Object.freeze([
  "auth-code",
  "external-code",
  "device-auth",
]);

function catalog() {
  return setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
}

/** Signs in a fresh workspace member, or the given BDD user. */
function signIn(actor?: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor?.userId ?? `user_${randomUUID()}`,
    actor?.orgId ?? `org_${randomUUID()}`,
  );
  return headers;
}

function rankOf(entry: { readonly popularityRank?: number }): number {
  return entry.popularityRank ?? Number.MAX_SAFE_INTEGER;
}

function expectNondecreasingRank(
  entries: readonly { readonly popularityRank?: number }[],
) {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (!previous || !current) {
      throw new Error("Expected adjacent catalog entries");
    }
    expect(rankOf(current)).toBeGreaterThanOrEqual(rankOf(previous));
  }
}

async function connectGitHub(owner: ApiTestUser, login: string) {
  const connectors = createConnectorBddApi(context);
  mockGitHubConnectorOAuth({ login });
  const started = await connectors.startOauth(owner, "github", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected GitHub authorization state");
  }
  await connectors.completeOauthCallback("github", {
    code: `code-${randomUUID()}`,
    state,
  });
}

/**
 * Lists the visible catalog, then reads the exact detail of one contiguous
 * slice of it; the slices together cover every visible slug.
 */
async function readVisibleDetailSlice(slice: number, slices: number) {
  const list = await accept(catalog().list({ headers: signIn() }), [200]);
  const size = Math.ceil(list.body.connectors.length / slices);
  const details: unknown[] = [];
  for (const connector of list.body.connectors.slice(
    slice * size,
    (slice + 1) * size,
  )) {
    const detail = await accept(
      catalog().get({
        headers: signIn(),
        params: { connectorSlug: connector.slug },
      }),
      [200],
    );
    details.push(detail.body);
  }
  return { visibleCount: list.body.connectors.length, details };
}

describe("GET /api/connector-catalog", () => {
  it("connector-catalog-026 hides the feature-gated test OAuth device connector", async () => {
    const response = await accept(
      catalog().get({
        headers: signIn(),
        params: { connectorSlug: "test-oauth-device" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "Connector catalog item not found",
    );
  });

  it("connector-catalog-007 lists compact public OpenAI metadata", async () => {
    const response = await accept(catalog().list({ headers: signIn() }), [200]);

    expect(response.body.connectors.length).toBeGreaterThan(0);
    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const openai = response.body.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    expect(openai).toMatchObject({
      label: "OpenAI",
      generation: ["text"],
      tags: ["llm"],
      authMethods: [
        {
          id: "api-token",
          label: "API Key",
          grantKind: "manual",
          supportsRefresh: false,
        },
      ],
      permissionSummary: {
        hasPermissions: false,
        permissionCount: 0,
        hasCategories: false,
        hasDefaultPolicyOverrides: false,
      },
    });
    expect(openai?.authMethods).toHaveLength(1);
  });

  it("connector-catalog-008 shares the same public icon descriptor across views", async () => {
    const list = await accept(catalog().list({ headers: signIn() }), [200]);
    const status = await accept(catalog().status({ headers: signIn() }), [200]);
    const detail = await accept(
      catalog().get({ headers: signIn(), params: { connectorSlug: "openai" } }),
      [200],
    );

    const listIcon = list.body.connectors.find((connector) => {
      return connector.slug === "openai";
    })?.icon;
    const statusIcon = status.body.connectors.find((connector) => {
      return connector.slug === "openai";
    })?.icon;
    expect(listIcon?.url).toMatch(/\.svg$/u);
    expect(listIcon?.invertInDarkMode).toBeTruthy();
    expect(statusIcon).toStrictEqual(listIcon);
    expect(detail.body.connector.icon).toStrictEqual(listIcon);

    const slackIcon = list.body.connectors.find((connector) => {
      return connector.slug === "slack";
    })?.icon;
    expect(slackIcon?.url).toMatch(/\.svg$/u);
    expect(slackIcon?.url).not.toBe(listIcon?.url);
    expect(slackIcon?.invertInDarkMode).toBeFalsy();
    expect(slackIcon?.scale).toBe(2);
  });

  it("connector-catalog-012 browses a bounded featured list and searches only slug or label", async () => {
    const browse = await accept(
      catalog().discovery({ headers: signIn(), query: {} }),
      [200],
    );
    const github = await accept(
      catalog().discovery({ headers: signIn(), query: { keyword: "GITHUB" } }),
      [200],
    );
    const descriptionOnly = await accept(
      catalog().discovery({
        headers: signIn(),
        query: { keyword: "fixture for manual connector behavior" },
      }),
      [200],
    );

    expect(browse.body.connectors.length).toBeGreaterThan(0);
    expect(browse.body.connectors.length).toBeLessThanOrEqual(100);
    expect(browse.body.totalConnectorCount).toBeGreaterThanOrEqual(
      browse.body.connectors.length,
    );
    assertPublicConnectorCatalogHasNoPrivateFields(browse.body);
    expect(github.body.connectors.length).toBeGreaterThan(0);
    for (const connector of github.body.connectors) {
      expect(
        connector.slug.toLowerCase().includes("github") ||
          connector.label.toLowerCase().includes("github"),
      ).toBeTruthy();
    }
    expect(descriptionOnly.body.connectors).toStrictEqual([]);
  });

  it("connector-catalog-013 gives every category its own ranked slice", async () => {
    const response = await accept(
      catalog().discovery({ headers: signIn(), query: {} }),
      [200],
    );

    const byCategory = new Map<string, typeof response.body.connectors>();
    for (const connector of response.body.connectors) {
      byCategory.set(connector.category, [
        ...(byCategory.get(connector.category) ?? []),
        connector,
      ]);
    }
    expect(byCategory.size).toBeGreaterThan(0);
    for (const [category, entries] of byCategory) {
      expect(entries.length).toBeLessThanOrEqual(12);
      expect(
        response.body.categoryConnectorCounts?.[category],
      ).toBeGreaterThanOrEqual(entries.length);
      expectNondecreasingRank(entries);
    }
    const slugs = response.body.connectors.map((connector) => {
      return connector.slug;
    });
    for (const internal of INTERNAL_CONNECTOR_SLUGS) {
      expect(slugs).not.toContain(internal);
    }
  });

  it("connector-catalog-014 answers a named category with the whole category", async () => {
    const browse = await accept(
      catalog().discovery({ headers: signIn(), query: {} }),
      [200],
    );
    const [category, total] = Object.entries(
      browse.body.categoryConnectorCounts ?? {},
    ).reduce<[string, number]>(
      (largest, entry) => {
        return entry[1] > largest[1] ? entry : largest;
      },
      ["", -1],
    );
    expect(total).toBeGreaterThan(0);

    const scoped = await accept(
      catalog().discovery({ headers: signIn(), query: { category } }),
      [200],
    );

    expect(scoped.body.connectors).toHaveLength(total);
    for (const connector of scoped.body.connectors) {
      expect(connector.category).toBe(category);
    }
    expectNondecreasingRank(scoped.body.connectors);
  });

  it("connector-catalog-015 returns public status connect hints", async () => {
    const response = await accept(
      catalog().status({ headers: signIn() }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const openai = response.body.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    expect(openai).toMatchObject({
      singleAuthCodeAuthMethodId: null,
      connectNotice: null,
      authMethods: [
        {
          id: "api-token",
          supportsRefresh: false,
          manualFields: [
            {
              id: "apiKey",
              label: "API Key",
              required: true,
              inputType: "password",
              placeholder: "sk-...",
            },
          ],
          startOptions: [],
        },
      ],
    });
    expect(openai?.authMethods).toHaveLength(1);
    expect(openai?.authMethods[0]?.manualFields).toHaveLength(1);
    const neon = response.body.connectors.find((connector) => {
      return connector.slug === "neon";
    });
    expect(
      neon?.authMethods.map((method) => {
        return method.id;
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("connector-catalog-017 lists one-click connectors matching the status grant kinds", async () => {
    const owner = createBddApi(context).user();
    await connectGitHub(owner, "bdd-github-owner");

    const oneClick = await accept(
      catalog().oneClick({ headers: signIn(owner) }),
      [200],
    );
    const status = await accept(
      catalog().status({ headers: signIn(owner) }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(oneClick.body);
    expect(
      oneClick.body.connectors
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    ).toStrictEqual(
      status.body.connectors
        .filter((connector) => {
          return connector.authMethods.some((method) => {
            return ONE_CLICK_GRANT_KINDS.includes(method.grantKind);
          });
        })
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    );
    const githubStatus = status.body.connectors.find((connector) => {
      return connector.slug === "github";
    });
    if (!githubStatus) {
      throw new Error("Expected GitHub in catalog status");
    }
    const githubBrief = oneClick.body.connectors.find((connector) => {
      return connector.slug === "github";
    });
    expect(githubBrief).toStrictEqual({
      slug: "github",
      label: githubStatus.label,
      description: githubStatus.description,
      icon: githubStatus.icon,
      ...(githubStatus.popularityRank === undefined
        ? {}
        : { popularityRank: githubStatus.popularityRank }),
      authMethods: githubStatus.authMethods,
      singleAuthCodeAuthMethodId: "oauth",
      connectNotice: null,
    });
  });

  it("connector-catalog-018 shows a manual OpenAI connection created through the public grant", async () => {
    const member = createBddApi(context).user();
    const connectors = createConnectorBddApi(context);
    const granted = await connectors.requestManualGrant(
      member,
      "openai",
      "api-token",
      { apiKey: `sk-${randomUUID()}` },
      { statuses: [200] },
    );
    if (!("connectionId" in granted.body)) {
      throw new Error("Expected a connected OpenAI account");
    }
    const connectionId = granted.body.connectionId;

    const status = await accept(
      catalog().status({ headers: signIn(member) }),
      [200],
    );
    const accounts = await connectors.listBuiltinConnectorAccounts(
      member,
      "openai",
    );

    assertPublicConnectorCatalogHasNoPrivateFields(status.body);
    expect(
      status.body.connectors.map((connector) => {
        return connector.slug;
      }),
    ).toContain("openai");
    expect(accounts).toStrictEqual([
      expect.objectContaining({
        id: connectionId,
        authMethod: "api-token",
        externalUsername: null,
        externalEmail: null,
        reconnectReason: null,
      }),
    ]);
  });

  it("connector-catalog-019 shows connected GitHub OAuth status without stored scopes", async () => {
    const member = createBddApi(context).user();
    await connectGitHub(member, "bdd-github-member");

    const status = await accept(
      catalog().status({ headers: signIn(member) }),
      [200],
    );
    const accounts = await createConnectorBddApi(
      context,
    ).listBuiltinConnectorAccounts(member, "github");

    assertPublicConnectorCatalogHasNoPrivateFields(status.body);
    const github = status.body.connectors.find((connector) => {
      return connector.slug === "github";
    });
    expect(github?.singleAuthCodeAuthMethodId).toBe("oauth");
    expect(JSON.stringify(github)).not.toContain("project");
    expect(accounts).toStrictEqual([
      expect.objectContaining({
        authMethod: "oauth",
        externalUsername: "bdd-github-member",
      }),
    ]);
  });

  it("connector-catalog-021 asks to reconnect an expired Stripe CLI credential", async () => {
    const member = createBddApi(context).user();
    const connectors = createConnectorBddApi(context);
    mockStripeCliDashboardAuth();
    const startedAt = now();
    mockNow(startedAt);
    const started = await connectors.startDeviceAuth(member, "stripe", "cli", {
      mode: "test",
    });
    // The member returns from the provider after the advertised poll interval.
    mockNow(startedAt + (started.interval + 1) * 1000);
    const polled = await connectors.pollDeviceAuth(
      member,
      "stripe",
      started.sessionId,
      started.sessionToken,
    );
    if (polled.status !== "complete") {
      throw new Error("Expected a completed Stripe CLI authorization");
    }
    const expiresAt = polled.account.tokenExpiresAt;
    if (!expiresAt) {
      throw new Error("Expected a Stripe CLI credential expiry");
    }
    expect(polled.account.connectionStatus).toBe("connected");
    mockNow(Date.parse(expiresAt) + 1);

    const status = await accept(
      catalog().status({ headers: signIn(member) }),
      [200],
    );
    const account = await connectors.readBuiltinConnectorAccount(
      member,
      "stripe",
      polled.account.id,
    );

    assertPublicConnectorCatalogHasNoPrivateFields(status.body);
    expect(
      status.body.connectors.find((connector) => {
        return connector.slug === "stripe";
      }),
    ).toMatchObject({ slug: "stripe", label: "Stripe" });
    expect(account).toMatchObject({
      authMethod: "cli",
      reconnectReason: "credential_expired",
      tokenExpiresAt: expiresAt,
    });
  });

  it("connector-catalog-022 describes OpenAI manual fields by public name only", async () => {
    const response = await accept(
      catalog().get({ headers: signIn(), params: { connectorSlug: "openai" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(JSON.stringify(response.body)).not.toContain("OPENAI_TOKEN");
    const apiToken = response.body.connector.authMethods.find((method) => {
      return method.id === "api-token";
    });
    expect(apiToken?.manualFields).toStrictEqual([
      {
        id: "apiKey",
        label: "API Key",
        required: true,
        inputType: "password",
        placeholder: "sk-...",
      },
    ]);
  });

  it("connector-catalog-025 (1/6) serves the first sixth of visible connector details without private metadata", async () => {
    const { visibleCount, details } = await readVisibleDetailSlice(0, 6);

    expect(visibleCount).toBeGreaterThan(0);
    for (const detail of details) {
      assertPublicConnectorCatalogHasNoPrivateFields(detail);
    }
  });

  it("connector-catalog-025 (2/6) serves the second sixth of visible connector details without private metadata", async () => {
    const { visibleCount, details } = await readVisibleDetailSlice(1, 6);

    expect(visibleCount).toBeGreaterThan(0);
    for (const detail of details) {
      assertPublicConnectorCatalogHasNoPrivateFields(detail);
    }
  });

  it("connector-catalog-025 (3/6) serves the third sixth of visible connector details without private metadata", async () => {
    const { visibleCount, details } = await readVisibleDetailSlice(2, 6);

    expect(visibleCount).toBeGreaterThan(0);
    for (const detail of details) {
      assertPublicConnectorCatalogHasNoPrivateFields(detail);
    }
  });

  it("connector-catalog-025 (4/6) serves the fourth sixth of visible connector details without private metadata", async () => {
    const { visibleCount, details } = await readVisibleDetailSlice(3, 6);

    expect(visibleCount).toBeGreaterThan(0);
    for (const detail of details) {
      assertPublicConnectorCatalogHasNoPrivateFields(detail);
    }
  });

  it("connector-catalog-025 (5/6) serves the fifth sixth of visible connector details without private metadata", async () => {
    const { visibleCount, details } = await readVisibleDetailSlice(4, 6);

    expect(visibleCount).toBeGreaterThan(0);
    for (const detail of details) {
      assertPublicConnectorCatalogHasNoPrivateFields(detail);
    }
  });

  it("connector-catalog-025 (6/6) serves the last sixth of visible connector details without private metadata", async () => {
    const { visibleCount, details } = await readVisibleDetailSlice(5, 6);

    expect(visibleCount).toBeGreaterThan(0);
    for (const detail of details) {
      assertPublicConnectorCatalogHasNoPrivateFields(detail);
    }
  });

  it("connector-catalog-029 shows Mercury OAuth without its hidden API token method", async () => {
    const response = await accept(
      catalog().get({
        headers: signIn(),
        params: { connectorSlug: "mercury" },
      }),
      [200],
    );

    expect(
      response.body.connector.authMethods.map((method) => {
        return method.id;
      }),
    ).toStrictEqual(["oauth"]);
  });

  it("connector-catalog-031 returns public Notion permission detail", async () => {
    const permissions = await accept(
      catalog().permissions({
        headers: signIn(),
        params: { connectorSlug: "notion" },
      }),
      [200],
    );
    const detail = await accept(
      catalog().get({ headers: signIn(), params: { connectorSlug: "notion" } }),
      [200],
    );

    const body = permissions.body.permissions;
    expect(body.connectorSlug).toBe("notion");
    expect(body.icon).toStrictEqual(detail.body.connector.icon);
    expect(body.permissionCount).toBeGreaterThan(0);
    expect(body.permissionCount).toBe(body.permissions.length);
    // A public permission carries only its name and description, never rules.
    expect(["name", "description"]).toStrictEqual(
      expect.arrayContaining(Object.keys(body.permissions[0] ?? {})),
    );
    assertPublicConnectorCatalogHasNoPrivateFields(permissions.body);
  });

  it("pf-141 redirects signed-out callers to a plain catalog logo with cache headers", async () => {
    const listed = await accept(catalog().list({ headers: signIn() }), [200]);
    const plain = listed.body.connectors.find((connector) => {
      return (
        !connector.icon.invertInDarkMode && (connector.icon.scale ?? 1) === 1
      );
    });
    if (!plain) {
      throw new Error("Expected a connector with an untreated icon");
    }

    const icon = await accept(
      catalog().icon({ params: { connectorSlug: plain.slug } }),
      [302],
    );

    expect(icon.headers.get("location")).toBe(plain.icon.url);
    expect(icon.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("pf-143 serves the scaled Slack catalog mark as a sandboxed standalone SVG", async () => {
    const detail = await accept(
      catalog().get({ headers: signIn(), params: { connectorSlug: "slack" } }),
      [200],
    );
    const sourceSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"/></svg>';
    server.use(
      http.get(detail.body.connector.icon.url, () => {
        return new HttpResponse(sourceSvg, {
          headers: { "content-type": "image/svg+xml" },
        });
      }),
    );

    const icon = await accept(
      catalog().icon({ params: { connectorSlug: "slack" } }),
      [200],
    );

    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("public, max-age=300");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox");
    const rendered = await icon.body.text();
    const doc = parseDocument(rendered, { xmlMode: true });
    const image = DomUtils.findOne(
      (element) => {
        return element.name === "image";
      },
      doc.children,
      true,
    );
    expect(image?.attribs).toMatchObject({
      x: "-50",
      y: "-50",
      width: "200",
      height: "200",
    });
    const href = image?.attribs.href ?? "";
    expect(href.startsWith("data:image/svg+xml;base64,")).toBeTruthy();
    const decoded = Buffer.from(
      href.slice("data:image/svg+xml;base64,".length),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe(sourceSvg);
  });
});
