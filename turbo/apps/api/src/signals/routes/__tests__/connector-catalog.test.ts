import { randomUUID } from "node:crypto";

import {
  connectorCatalogContract,
  type PublicConnectorCatalogListResponse,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { connectorCatalogRoutes } from "../connector-catalog";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const store = createStore();

async function enableFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  const client = setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
  await accept(
    client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  orgId: string,
  userId: string,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  const client = setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
  await accept(
    client.delete({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function assertCategoryMetadataMatchesVisibleConnectors(
  body:
    | PublicConnectorCatalogListResponse
    | PublicConnectorCatalogStatusResponse,
): void {
  const metadata = body.categoryMetadata;
  expect(metadata).toBeDefined();
  if (!metadata) {
    return;
  }
  const connectorCategories = new Set(
    body.connectors.map((connector) => {
      return connector.category;
    }),
  );
  const metadataCategoryIds = metadata.categories.map((category) => {
    return category.id;
  });
  expect(metadataCategoryIds).toHaveLength(new Set(metadataCategoryIds).size);
  expect(new Set(metadataCategoryIds)).toStrictEqual(connectorCategories);
  const referencedGroupIds = new Set(
    metadata.categories.flatMap((category) => {
      return category.groupId ? [category.groupId] : [];
    }),
  );
  const metadataGroupIds = metadata.groups.map((group) => {
    return group.id;
  });
  expect(metadataGroupIds).toHaveLength(new Set(metadataGroupIds).size);
  expect(new Set(metadataGroupIds)).toStrictEqual(referencedGroupIds);
  for (const groupId of metadataGroupIds) {
    expect(connectorCategories.has(groupId)).toBeFalsy();
  }

  expect(metadata.categories).toStrictEqual([
    {
      id: "test-connectors",
      label: "Test Connectors",
      menuLabel: "Test Connectors",
      groupId: "test",
    },
  ]);
  expect(metadata.groups).toStrictEqual([
    {
      id: "test",
      label: "Test",
      menuLabel: "Test",
    },
  ]);
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

describe("GET /api/connector-catalog", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];
  const seededOrgs: OrgMembershipFixture[] = [];

  async function enableConnectorFeatureSwitches(
    orgId: string,
    userId: string,
    switches: Partial<Record<FeatureSwitchKey, boolean>>,
  ): Promise<void> {
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, switches);
  }

  afterEach(async () => {
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await deleteFeatureSwitches(fixture.orgId, fixture.userId);
      }
    }
    while (seededOrgs.length > 0) {
      const fixture = seededOrgs.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it.each(["get", "permissions"] as const)(
    "returns 503 for %s when the configured catalog has no accepted snapshot",
    async (endpoint) => {
      mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
      // A newly configured catalog source has no accepted publication yet.
      mockEnv(
        "R2_USER_STORAGES_BUCKET_NAME",
        `test-catalog-unavailable-${randomUUID()}`,
      );
      const client = setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      );
      const request = {
        params: { connectorSlug: "openai" },
        headers: { authorization: "Bearer clerk-session" },
      };
      const response =
        endpoint === "get"
          ? await accept(client.get(request), [503])
          : await accept(client.permissions(request), [503]);

      expect(response.body.error).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        message: "Connector catalog is temporarily unavailable",
      });
    },
  );

  it.each(["posthog", "calendly"])(
    "returns public catalog metadata including %s OAuth",
    async (connectorSlug) => {
      mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

      const client = setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      );
      const response = await accept(
        client.list({ headers: { authorization: "Bearer clerk-session" } }),
        [200],
      );

      assertPublicConnectorCatalogHasNoPrivateFields(response.body);
      assertCategoryMetadataMatchesVisibleConnectors(response.body);
      expect(response.body.connectors).toContainEqual(
        expect.objectContaining({
          slug: connectorSlug,
          authMethods: expect.arrayContaining([
            expect.objectContaining({ id: "oauth", grantKind: "auth-code" }),
          ]),
        }),
      );
    },
  );

  it("returns compact public connector metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(response.body.connectors.length).toBeGreaterThan(0);
    const openai = response.body.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai?.label).toBe("OpenAI");
    expect(openai?.generation).toContain("text");
    expect(openai?.tags).toContain("llm");
    expect(openai?.authMethods).toStrictEqual([
      {
        id: "api-token",
        label: "API Key",
        description: expect.any(String),
        grantKind: "manual",
      },
    ]);
    expect(openai?.permissionSummary).toStrictEqual({
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    });
    expect(openai?.permissionSummary).not.toHaveProperty("permissions");
  });

  it("returns shared public icon descriptors across catalog views", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const listResponse = await accept(client.list({ headers }), [200]);
    const statusResponse = await accept(client.status({ headers }), [200]);
    const detailResponse = await accept(
      client.get({ params: { connectorSlug: "openai" }, headers }),
      [200],
    );

    const openai = listResponse.body.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    const openaiStatus = statusResponse.body.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    expect(openai?.icon).toStrictEqual({
      url: "https://static.vm0.io/test-fixtures/connectors/openai.svg",
      invertInDarkMode: true,
    });
    expect(openaiStatus?.icon).toStrictEqual(openai?.icon);
    expect(detailResponse.body.connector.icon).toStrictEqual(openai?.icon);

    const slack = listResponse.body.connectors.find((connector) => {
      return connector.slug === "slack";
    });
    expect(slack?.icon).toStrictEqual({
      url: "https://static.vm0.io/test-fixtures/connectors/slack.svg",
      invertInDarkMode: false,
      scale: 2,
    });
  });

  it("accepts an Okou run token carrying connector:read", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.connectors.length).toBeGreaterThan(0);
  });

  it("rejects an Okou run token missing connector:read with 403", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns 401 for diagnostics when not authenticated", async () => {
    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(client.diagnostics({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for diagnostics when the session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.diagnostics({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects diagnostics calls from Okou run tokens even with connector:read", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.diagnostics({
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 403 for diagnostics when OkouDebug is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.diagnostics({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Connector catalog diagnostics are not enabled",
      code: "FORBIDDEN",
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("returns sanitized DB diagnostics when OkouDebug is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.diagnostics({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      state: expect.stringMatching(/^(?:current|never-synced|stale)$/u),
      filtering: {
        capabilityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        stale: expect.any(Boolean),
        filteredAuthMethods: expect.any(Array),
      },
      credentialStorage: {
        missingConnectorVersions: expect.any(Number),
        unownedConnectorSecrets: expect.any(Number),
        unownedConnectorVariables: expect.any(Number),
        unresolvedBridgeCredentials: expect.any(Number),
      },
    });
    expect(response.body).not.toHaveProperty("sourceId");
    expect(response.body).not.toHaveProperty("catalog");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("returns 401 for catalog status when not authenticated", async () => {
    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(client.status({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for catalog status when the session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns bounded featured connectors and searches only slug or label", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const featured = await accept(
      client.discovery({ query: {}, headers }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(featured.body);
    expect(featured.body.connectors.length).toBeGreaterThan(0);
    expect(featured.body.connectors.length).toBeLessThanOrEqual(100);
    expect(featured.body.totalConnectorCount).toBeGreaterThanOrEqual(
      featured.body.connectors.length,
    );

    const labelOrSlugSearch = await accept(
      client.discovery({ query: { keyword: "GITHUB" }, headers }),
      [200],
    );
    expect(labelOrSlugSearch.body.connectors.length).toBeGreaterThan(0);
    for (const connector of labelOrSlugSearch.body.connectors) {
      expect(
        connector.slug.toLowerCase().includes("github") ||
          connector.label.toLowerCase().includes("github"),
      ).toBeTruthy();
    }

    const descriptionSearch = await accept(
      client.discovery({
        query: { keyword: "permission behavior" },
        headers,
      }),
      [200],
    );
    expect(descriptionSearch.body.connectors).toStrictEqual([]);
  });

  it("orders discovery by rank and gives every category its own slice", async () => {
    // The endpoint's promise, stated here rather than imported: at most this
    // many connectors per category, and never a connector Okou runs itself.
    const DISCOVERY_PER_CATEGORY = 12;
    const INTERNAL_SLUGS = ["maskdb", "db9", "drive9", "slock", "runtime"];

    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const discovery = await accept(
      client.discovery({ query: {}, headers }),
      [200],
    );

    // Discovery used to answer with one global top-100, so a category holding
    // a quarter of the catalog crowded the others off the first screen.
    const counts = discovery.body.categoryConnectorCounts ?? {};
    const returnedPerCategory = new Map<string, number>();
    for (const connector of discovery.body.connectors) {
      returnedPerCategory.set(
        connector.category,
        (returnedPerCategory.get(connector.category) ?? 0) + 1,
      );
    }
    for (const [category, returned] of returnedPerCategory) {
      expect(returned).toBeLessThanOrEqual(DISCOVERY_PER_CATEGORY);
      expect(counts[category] ?? 0).toBeGreaterThanOrEqual(returned);
    }

    // Inside a category a ranked connector always precedes an unranked one,
    // and ranks never go backwards.
    const seenRankByCategory = new Map<string, number>();
    for (const connector of discovery.body.connectors) {
      const rank = connector.popularityRank ?? Number.MAX_SAFE_INTEGER;
      const previous = seenRankByCategory.get(connector.category);
      if (previous !== undefined) {
        expect(rank).toBeGreaterThanOrEqual(previous);
      }
      seenRankByCategory.set(connector.category, rank);
    }

    // Connectors Okou runs for itself never compete for a customer's first
    // screen, in browse or in search.
    for (const slug of INTERNAL_SLUGS) {
      expect(
        discovery.body.connectors.some((connector) => {
          return connector.slug === slug;
        }),
      ).toBeFalsy();
    }
  });

  it("answers a named category with the whole category", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const browse = await accept(
      client.discovery({ query: {}, headers }),
      [200],
    );

    const counts = browse.body.categoryConnectorCounts ?? {};
    const [category, total] = Object.entries(counts).reduce(
      (largest, entry) => {
        return entry[1] > largest[1] ? entry : largest;
      },
      ["", 0],
    );
    expect(total).toBeGreaterThan(0);

    const scoped = await accept(
      client.discovery({ query: { category }, headers }),
      [200],
    );

    // The count offered next to a category is what the client uses to invite
    // the reader in, so entering it has to return everything that was counted
    // -- not the browse slice, which is what made "329" mean twelve.
    expect(scoped.body.connectors).toHaveLength(total);
    for (const connector of scoped.body.connectors) {
      expect(connector.category).toBe(category);
    }

    // The category list describes the catalog, not the response. A client
    // offers the other categories from it, so collapsing it to the one being
    // browsed would leave no way to reach any of them.
    expect(
      (scoped.body.categoryMetadata?.categories ?? [])
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual(Object.keys(counts).sort());

    // Still ranked, and still without the connectors Okou runs for itself.
    const ranks = scoped.body.connectors.map((connector) => {
      return connector.popularityRank ?? Number.MAX_SAFE_INTEGER;
    });
    expect(
      [...ranks].sort((left, right) => {
        return left - right;
      }),
    ).toStrictEqual(ranks);
  });

  it("rejects catalog status calls from Okou run tokens without connector:read", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.status({ headers: { authorization: `Bearer ${token}` } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns public catalog status without private connector fields", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    assertCategoryMetadataMatchesVisibleConnectors(response.body);
    const openai = response.body.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    expect(openai).toMatchObject({
      slug: "openai",
      label: "OpenAI",
      connected: false,
      connection: null,
      connectionStatus: "not-connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
      singleAuthCodeAuthMethodId: null,
      connectNotice: null,
    });
    expect(openai?.authMethods).toStrictEqual([
      {
        id: "api-token",
        label: "API Key",
        description: expect.any(String),
        grantKind: "manual",
        manualFields: [
          {
            id: "apiKey",
            label: "API Key",
            required: true,
            placeholder: "sk-...",
            inputType: "password",
          },
        ],
        startOptions: [],
      },
    ]);
    const neon = response.body.connectors.find((connector) => {
      return connector.slug === "neon";
    });
    expect(
      neon?.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("returns connected manual grant status from public API-created state", async () => {
    const actor = bdd.user();
    const connection = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      {
        apiKey: "sk-public-status",
      },
    );
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const openai = response.body.connectors.find((connector) => {
      return connector.slug === "openai";
    });
    expect(openai).toMatchObject({
      slug: "openai",
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
    });
    expect(openai?.connection).toStrictEqual({
      id: connection.id,
      authMethod: "api-token",
      externalUsername: null,
      externalEmail: null,
      reconnectReason: null,
    });
    expect(openai?.connection).not.toHaveProperty("oauthScopes");
    expect(openai?.connection).not.toHaveProperty("externalId");
    expect(openai?.connection).not.toHaveProperty("createdAt");
    expect(openai?.connection).not.toHaveProperty("updatedAt");
  });

  it("returns connected auth-code status without exposing stored scopes", async () => {
    const actor = bdd.user();
    mockGitHubConnectorOAuth();
    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    await connectorsApi.completeOauthCallback("github", {
      code: `github-${randomUUID()}`,
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const github = response.body.connectors.find((connector) => {
      return connector.slug === "github";
    });
    expect(github).toMatchObject({
      slug: "github",
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
      singleAuthCodeAuthMethodId: "oauth",
    });
    expect(github?.connection).toMatchObject({
      authMethod: "oauth",
      externalUsername: "bdd-github-user",
    });
    expect(github?.connection).not.toHaveProperty("oauthScopes");
  });

  it("returns scope mismatch status for connectors with missing stored scopes", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorSlug: "github",
        authMethod: "oauth",
        accessToken: "github-access-token",
        expiresIn: 3600,
      },
      [200],
    );
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const github = response.body.connectors.find((connector) => {
      return connector.slug === "github";
    });
    expect(github).toMatchObject({
      slug: "github",
      connected: true,
      connectionStatus: "scope-mismatch",
      scopeMismatch: true,
      authMethodSupportsRefresh: false,
    });
    expect(github?.connection).toMatchObject({
      authMethod: "oauth",
      reconnectReason: null,
    });
    expect(github?.connection).not.toHaveProperty("oauthScopes");
  });

  it("returns reconnect-required status for expired non-refreshable connectors", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorSlug: "github",
        authMethod: "oauth",
        accessToken: "expired-github-access-token",
        expiresIn: -60,
      },
      [200],
    );
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const github = response.body.connectors.find((connector) => {
      return connector.slug === "github";
    });
    expect(github).toMatchObject({
      slug: "github",
      connected: true,
      connectionStatus: "reconnect-required",
      scopeMismatch: true,
      authMethodSupportsRefresh: false,
    });
    expect(github?.connection).toMatchObject({
      authMethod: "oauth",
      reconnectReason: "credential_expired",
    });
    expect(github?.tokenExpiresAt).toStrictEqual(expect.any(String));
    expect(Date.parse(github?.tokenExpiresAt ?? "")).toBeLessThan(now());
    expect(github?.connection).not.toHaveProperty("oauthScopes");
  });

  it("returns connector detail without leaking manual field storage names", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "openai" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const apiToken = response.body.connector.authMethods.find((method) => {
      return method.id === "api-token";
    });
    expect(apiToken?.manualFields).toStrictEqual([
      {
        id: "apiKey",
        label: "API Key",
        required: true,
        placeholder: "sk-...",
        inputType: "password",
      },
    ]);
  });

  it("returns exact connector metadata with the current connection status", async () => {
    const actor = bdd.user();
    const connection = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      {
        apiKey: "sk-public-detail-status",
      },
    );
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "openai" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(response.body.connector).toMatchObject({
      slug: "openai",
      connected: true,
      connectionStatus: "connected",
      connection: {
        id: connection.id,
        authMethod: "api-token",
        externalUsername: null,
        externalEmail: null,
        reconnectReason: null,
      },
    });
  });

  it("omits auth text and placeholders derived from private names", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "parallel" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const apiToken = response.body.connector.authMethods.find((method) => {
      return method.id === "api-token";
    });
    expect(apiToken?.description).toBeNull();
    expect(apiToken?.manualFields).toStrictEqual([
      {
        id: "apiKey",
        label: "API Key",
        required: true,
        placeholder: null,
        inputType: "password",
      },
    ]);
  });

  it("returns every visible connector detail without private metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.NeonConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(listResponse.body.connectors.length).toBeGreaterThan(0);
    for (const connector of listResponse.body.connectors) {
      const detailResponse = await accept(
        client.get({
          params: { connectorSlug: connector.slug },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      assertPublicConnectorCatalogHasNoPrivateFields(detailResponse.body);
    }
  });

  it("returns 404 for hidden connector catalog slugs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "test-oauth-device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "Connector catalog item not found",
    );
  });

  it("rejects connector catalog slugs outside the public slug bounds", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const connectorSlug = "x".repeat(65);
    const detailResponse = await accept(
      client.get({
        params: { connectorSlug },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    const permissionResponse = await accept(
      client.permissions({
        params: { connectorSlug },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(detailResponse.body.error.code).toBe("BAD_REQUEST");
    expect(permissionResponse.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns semantic public ids for device-auth start options", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "test-oauth-device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(
      response.body.connector.authMethods.map((method) => {
        return method.id;
      }),
    ).toStrictEqual(["oauth", "api"]);
    const apiMethod = response.body.connector.authMethods.find((method) => {
      return method.id === "api";
    });
    expect(apiMethod?.startOptions).toStrictEqual([
      {
        id: "environment",
        kind: "select",
        label: "Mode",
        required: true,
        defaultValue: "test",
        options: [
          { value: "test", label: "Test" },
          { value: "live", label: "Live" },
        ],
      },
    ]);
  });

  it("hides feature-gated auth methods from connector detail", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "neon" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("shows feature-gated auth methods when their connector feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.NeonConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "neon" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["oauth", "api-token"]);
  });

  it("hides only Stripe OAuth when the Marketplace OAuth feature is disabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "stripe" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["api-token", "cli"]);
  });

  it("shows Stripe OAuth when the Marketplace OAuth feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.StripeMarketplaceOAuthConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "stripe" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["oauth", "api-token", "cli"]);
  });

  it("returns public permission detail from accepted firewall metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.permissions({
        params: { connectorSlug: "notion" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const detailResponse = await accept(
      client.get({
        params: { connectorSlug: "notion" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(response.body.permissions.connectorSlug).toBe("notion");
    expect(response.body.permissions.icon).toStrictEqual(
      detailResponse.body.connector.icon,
    );
    expect(response.body.permissions.permissionCount).toBeGreaterThan(0);
    expect(response.body.permissions.permissions).toHaveLength(
      response.body.permissions.permissionCount,
    );
    expect(response.body.permissions.permissions[0]).not.toHaveProperty(
      "rules",
    );
  });
});
