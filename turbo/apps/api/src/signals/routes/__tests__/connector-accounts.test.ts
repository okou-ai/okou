import { randomUUID } from "node:crypto";

import {
  CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorsBySlugContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorByIdContract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";

import { settle } from "../../utils";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";

import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";

import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const claimedToken = createClaimedRunCredentials(context).okouToken;
const mocks = createRouteMocks(context);
const routes = Object.freeze([
  ...connectorAccountRoutes,
  ...builtinConnectorsRoutes,
  ...customConnectorsRoutes,
  ...customConnectorsDeleteRoutes,
  ...customConnectorsValuesSetRoutes,
]);

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function accountClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function connectorClient() {
  return setupApp({ context, routes })(builtinConnectorManualGrantContract);
}

function connectorProjectionClient() {
  return setupApp({ context, routes })(builtinConnectorsBySlugContract);
}

function customConnectorClient() {
  return setupApp({ context, routes })(customConnectorsContract);
}

function customConnectorByIdClient() {
  return setupApp({ context, routes })(customConnectorByIdContract);
}

function customConnectorValuesClient() {
  return setupApp({ context, routes })(customConnectorValuesContract);
}

async function deleteBuiltinAccountPage(
  connectorSlug: "openai" | "github" | "public-mcp",
  connections: readonly { readonly id: string }[],
): Promise<void> {
  const accountsApi = accountClient();
  // Keep four owned streams moving without waiting for a whole batch, and
  // settle every stream before fixture cleanup reports a failure.
  const deleted = await Promise.allSettled(
    Array.from(
      { length: Math.min(4, connections.length) },
      async (_, stream) => {
        for (let index = stream; index < connections.length; index += 4) {
          await accept(
            accountsApi.delete({
              headers: authHeaders(),
              params: { connectionId: connections[index]!.id },
              body: { target: { kind: "builtin", connectorSlug } },
            }),
            [200, 404],
          );
        }
      },
    ),
  );
  for (const result of deleted) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const accountsApi = accountClient();
  for (const connectorSlug of ["openai", "github", "public-mcp"] as const) {
    let hasBuiltinAccounts = true;
    while (hasBuiltinAccounts) {
      const accounts = await accept(
        accountsApi.connections({
          headers: authHeaders(),
          query: { kind: "builtin", connectorSlug, limit: 100 },
        }),
        [200, 404],
      );
      hasBuiltinAccounts =
        accounts.status === 200 && accounts.body.connections.length > 0;
      if (accounts.status !== 200) {
        break;
      }
      await deleteBuiltinAccountPage(connectorSlug, accounts.body.connections);
    }
  }
  const customConnectors = await accept(
    customConnectorClient().list({ headers: authHeaders() }),
    [200],
  );
  for (const definition of customConnectors.body.connectors) {
    const customAccounts = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "custom",
          customConnectorId: definition.id,
          limit: 100,
        },
      }),
      [200, 404],
    );
    if (customAccounts.status === 200) {
      for (const account of customAccounts.body.connections) {
        await accept(
          accountClient().delete({
            headers: authHeaders(),
            params: { connectionId: account.id },
            body: {
              target: {
                kind: "custom",
                customConnectorId: definition.id,
              },
            },
          }),
          [200, 404],
        );
      }
    }
    await accept(
      customConnectorByIdClient().delete({
        headers: authHeaders(),
        params: { id: definition.id },
      }),
      [204, 404],
    );
  }
}

describe("connector account lifecycle routes", () => {
  const track = createFixtureTracker<Fixture>(cleanupFixture);

  async function seedFixture(
    overrides: Partial<Fixture> = {},
  ): Promise<Fixture> {
    const fixture = await track(
      Promise.resolve({
        orgId: overrides.orgId ?? `org_${randomUUID()}`,
        userId: overrides.userId ?? `user_${randomUUID()}`,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    return fixture;
  }

  it("exposes canonical account resources without feature setup", async () => {
    await seedFixture();
    const response = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.summaries).toStrictEqual([]);
    const exact = await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: randomUUID() },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [404],
    );
    expect(exact.body.error.message).toBe("Connector account not found");
    const invalidPage = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          cursor: "not-a-cursor",
        },
      }),
      [400],
    );
    expect(invalidPage.body.error.message).toBe(
      "Invalid connector account cursor",
    );
    const inspection = await accept(
      accountClient().inspect({
        headers: authHeaders(),
        body: { selections: [] },
      }),
      [200],
    );
    expect(inspection.body.results).toStrictEqual([]);
    const scopeDiff = await accept(
      accountClient().scopeDiff({
        headers: authHeaders(),
        params: { connectionId: randomUUID() },
        query: { connectorSlug: "github" },
      }),
      [404],
    );
    expect(scopeDiff.body.error.message).toBe("Connector account not found");
  });

  it("reports missing declared configuration independently of a custom OAuth credential", async () => {
    const fixture = await seedFixture();
    const actor: ApiTestUser = {
      ...fixture,
      orgRole: "org:admin",
      email: "connector-setup@example.test",
    };
    mockClerkMembership(context, actor, "org:admin");
    const api = createConnectorBddApi(context);
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const definition = await api.createCustomConnector(actor, {
      displayName: "OAuth with declared configuration",
      prefixTemplates: ["https://configured-oauth.example.test/"],
      authMode: "oauth",
      fields: [
        { key: "region", label: "Region", kind: "variable", required: true },
        {
          key: "access_token",
          label: "Declared access token variable",
          kind: "variable",
          required: true,
        },
        {
          key: "refresh_token",
          label: "Declared refresh token variable",
          kind: "variable",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
        { name: "X-Region", valueTemplate: "{{variables.region}}" },
      ],
      queryInjections: [],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "setup-client",
        clientSecret: "setup-client-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: ["read"],
        authorizationParams: {},
      },
    });
    const authorization = new URL(
      await api.startCustomConnectorOAuth2AtBaseUrl(
        actor,
        definition.id,
        "https://api.okou.ai",
        { intent: "add" },
      ),
    );
    const state = authorization.searchParams.get("state");
    if (!state) {
      throw new Error("Expected public OAuth authorization state");
    }
    await api.completeCustomConnectorOAuth2Callback(
      { code: "setup-authorization-code", state },
      { baseUrl: "https://api.okou.ai" },
    );
    const response = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(response.body.summaries).toStrictEqual([
      expect.objectContaining({
        target: { kind: "custom", customConnectorId: definition.id },
        accountCount: 1,
        attentionCount: 1,
        defaultConnection: expect.objectContaining({
          connectionStatus: "connected",
          setupStatus: "incomplete",
          missingRequiredFields: ["access_token", "refresh_token", "region"],
          configuredFieldKeys: [],
        }),
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain("setup-client-secret");
    const accountId = response.body.summaries[0]?.defaultConnection?.id;
    if (!accountId) {
      throw new Error("Expected the exact OAuth account");
    }
    const unsupportedWrite = await accept(
      customConnectorValuesClient().set({
        headers: authHeaders(),
        params: { id: definition.id },
        body: {
          account: { intent: "reconnect", connectionId: accountId },
          values: [{ key: "region", kind: "variable", value: "us-test" }],
        },
      }),
      [400],
    );
    expect(unsupportedWrite.body.error.message).toBe(
      "OAuth and Automatic custom connectors must be connected through authentication discovery",
    );
  });

  it("keeps a stale saved default beside a reconnected healthy custom sibling", async () => {
    await seedFixture();
    const body = {
      displayName: "Account setup facts",
      prefixTemplates: ["https://api.example.com/"],
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret" as const,
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "variable" as const,
          required: true,
        },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.api_key}}" },
      ],
      queryInjections: [],
    } satisfies CreateCustomConnectorBody;
    const definition = await accept(
      customConnectorClient().create({ headers: authHeaders(), body }),
      [201],
    );
    const target = {
      kind: "custom",
      customConnectorId: definition.body.id,
    } as const;
    const defaultAccount = await accept(
      customConnectorValuesClient().set({
        headers: authHeaders(),
        params: { id: definition.body.id },
        body: {
          account: { intent: "add" },
          values: [
            {
              key: "api_key",
              kind: "secret",
              value: "first-secret-must-not-leak",
            },
            { key: "region", kind: "variable", value: "first-region-value" },
          ],
        },
      }),
      [200],
    );
    const healthy = await accept(
      customConnectorValuesClient().set({
        headers: authHeaders(),
        params: { id: definition.body.id },
        body: {
          account: { intent: "add", displayName: "Healthy sibling" },
          values: [
            {
              key: "api_key",
              kind: "secret",
              value: "second-secret-must-not-leak",
            },
            { key: "region", kind: "variable", value: "private-region-value" },
          ],
        },
      }),
      [200],
    );
    expect(defaultAccount.body.connectionId).toBe(
      defaultAccount.body.connectedAccountId,
    );
    expect(healthy.body.connectionId).toBe(healthy.body.connectedAccountId);
    if (!defaultAccount.body.connectionId || !healthy.body.connectionId) {
      throw new Error("Expected exact operated account IDs");
    }
    const before = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(before.body.summaries).toStrictEqual([
      expect.objectContaining({
        target,
        accountCount: 2,
        attentionCount: 0,
        defaultConnection: expect.objectContaining({
          id: defaultAccount.body.connectionId,
          connectionStatus: "connected",
          setupStatus: "complete",
          missingRequiredFields: [],
          configuredFieldKeys: ["api_key", "region"],
        }),
      }),
    ]);
    const sibling = await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: healthy.body.connectionId },
        query: target,
      }),
      [200],
    );
    expect(sibling.body).toMatchObject({
      id: healthy.body.connectionId,
      isDefault: false,
      connectionStatus: "connected",
      setupStatus: "complete",
      missingRequiredFields: [],
      configuredFieldKeys: ["api_key", "region"],
    });
    await accept(
      customConnectorByIdClient().update({
        headers: authHeaders(),
        params: { id: definition.body.id },
        body: { ...body, storageVersion: 2 },
      }),
      [200],
    );
    const stale = await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: defaultAccount.body.connectionId },
        query: target,
      }),
      [200],
    );
    expect(stale.body).toMatchObject({
      id: defaultAccount.body.connectionId,
      isDefault: true,
      setupStatus: "invalid",
      configuredFieldKeys: [],
      missingRequiredFields: ["api_key", "region"],
    });
    const repaired = await accept(
      customConnectorValuesClient().set({
        headers: authHeaders(),
        params: { id: definition.body.id },
        body: {
          account: {
            intent: "reconnect",
            connectionId: healthy.body.connectionId,
          },
          values: [
            { key: "api_key", kind: "secret", value: "repaired-secret" },
            { key: "region", kind: "variable", value: "repaired-region" },
          ],
        },
      }),
      [200],
    );
    expect(repaired.body.connectionId).toBe(healthy.body.connectionId);
    const after = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(after.body.summaries).toStrictEqual([
      expect.objectContaining({
        target,
        accountCount: 2,
        attentionCount: 1,
        defaultConnection: expect.objectContaining({
          id: defaultAccount.body.connectionId,
          setupStatus: "invalid",
        }),
      }),
    ]);
    const visible = JSON.stringify([
      before.body,
      sibling.body,
      stale.body,
      after.body,
    ]);
    expect(visible).not.toMatch(
      /first-secret-must-not-leak|second-secret-must-not-leak|private-region-value|repaired-secret|repaired-region/u,
    );
  });

  it("inspects exact account duplicates in request order after rename and deletion without leaking credentials", async () => {
    const app = setupApp({ context, routes });
    const accounts = app(connectorAccountsContract);
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const connected = await accept(
      app(builtinConnectorManualGrantContract).connect({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Work" },
          values: { apiKey: "sk-inspection" },
        },
      }),
      [200],
    );
    const target = { kind: "builtin", connectorSlug: "openai" } as const;
    const selected = { connectionId: connected.body.id, target };
    const missing = { connectionId: randomUUID(), target };
    const mismatched = {
      connectionId: connected.body.id,
      target: { kind: "builtin", connectorSlug: "github" } as const,
    };
    const selections = [missing, selected, mismatched, selected];
    const available = {
      kind: "available",
      connectionId: connected.body.id,
      target,
      authMethod: "api-token",
      displayName: "Work",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      connectionStatus: "connected",
      reconnectReason: null,
      setupStatus: "complete",
      missingRequiredFields: [],
      configuredFieldKeys: ["apiKey"],
    };
    const inspected = await accept(
      accounts.inspect({ headers: authHeaders(), body: { selections } }),
      [200],
    );
    expect(inspected.body.results).toStrictEqual([
      { kind: "unavailable", ...missing },
      available,
      { kind: "unavailable", ...mismatched },
      available,
    ]);

    const renamed = await accept(
      accounts.rename({
        headers: authHeaders(),
        params: { connectionId: connected.body.id },
        body: { target, displayName: "Renamed work" },
      }),
      [200],
    );
    expect(renamed.body).toMatchObject({
      id: connected.body.id,
      target,
      displayName: "Renamed work",
    });
    const renamedInspection = await accept(
      accounts.inspect({ headers: authHeaders(), body: { selections } }),
      [200],
    );
    expect(renamedInspection.body.results).toStrictEqual([
      { kind: "unavailable", ...missing },
      { ...available, displayName: renamed.body.displayName },
      { kind: "unavailable", ...mismatched },
      { ...available, displayName: renamed.body.displayName },
    ]);

    const deleted = await accept(
      accounts.delete({
        headers: authHeaders(),
        params: { connectionId: connected.body.id },
        body: { target },
      }),
      [200],
    );
    expect(deleted.body.deletedConnectionId).toBe(connected.body.id);
    const deletedInspection = await accept(
      accounts.inspect({ headers: authHeaders(), body: { selections } }),
      [200],
    );
    expect(deletedInspection.body.results).toStrictEqual(
      selections.map((selection) => {
        return { kind: "unavailable", ...selection };
      }),
    );
  });

  it("accepts a claimed Runner credential for account inspection", async () => {
    const fixture = await seedFixture();
    mockClerkMembership(
      context,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "org:admin",
        email: "connector-account-inspection@example.test",
      },
      "org:admin",
    );

    const allowed = await accept(
      accountClient().inspect({
        headers: {
          authorization: `Bearer ${await claimedToken(fixture)}`,
        },
        body: { selections: [] },
      }),
      [200],
    );
    expect(allowed.body).toStrictEqual({ results: [] });
  });

  it("accepts one bounded inspection batch and rejects a larger one", async () => {
    await seedFixture();
    const selection = {
      connectionId: randomUUID(),
      target: { kind: "builtin" as const, connectorSlug: "openai" },
    };

    const maximum = await accept(
      accountClient().inspect({
        headers: authHeaders(),
        body: {
          selections: Array.from(
            { length: CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS },
            () => {
              return selection;
            },
          ),
        },
      }),
      [200],
    );
    expect(maximum.body.results).toHaveLength(
      CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
    );
    expect(maximum.body.results[0]).toStrictEqual({
      kind: "unavailable",
      ...selection,
    });

    await accept(
      accountClient().inspect({
        headers: authHeaders(),
        body: {
          selections: Array.from(
            { length: CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS + 1 },
            () => {
              return selection;
            },
          ),
        },
      }),
      [400],
    );
  });

  it("keeps default transitions exact and isolated across custom targets", async () => {
    await seedFixture();
    const groups: {
      readonly target: {
        readonly kind: "custom";
        readonly customConnectorId: string;
      };
      readonly ids: readonly string[];
    }[] = [];
    for (const label of ["Primary", "Separate"]) {
      const definition = await accept(
        customConnectorClient().create({
          headers: authHeaders(),
          body: {
            displayName: `Default ${label}`,
            prefixTemplates: ["https://api.example.com/"],
            fields: [
              {
                key: "secret",
                label: "Secret",
                kind: "secret",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.secret}}",
              },
            ],
            queryInjections: [],
          },
        }),
        [201],
      );
      const ids: string[] = [];
      for (const displayName of label === "Primary"
        ? ["Work", "Personal", "Removed"]
        : ["Other"]) {
        const connected = await accept(
          customConnectorValuesClient().set({
            headers: authHeaders(),
            params: { id: definition.body.id },
            body: {
              values: [
                {
                  key: "secret",
                  kind: "secret",
                  value: `token-${label}-${displayName}`,
                },
              ],
              account: { intent: "add", displayName },
            },
          }),
          [200],
        );
        expect(connected.body.connected).toBeTruthy();
        expect(connected.body.connectedAccountId).toStrictEqual(
          expect.any(String),
        );
        if (!connected.body.connectedAccountId) {
          throw new Error("Public connection did not return an account ID");
        }
        ids.push(connected.body.connectedAccountId);
      }
      groups.push({
        target: { kind: "custom", customConnectorId: definition.body.id },
        ids,
      });
    }
    const [primary, separate] = groups;
    if (!primary || !separate) {
      throw new Error("Public custom targets were not created");
    }
    const [workId, personalId, removedId] = primary.ids;
    const [otherId] = separate.ids;
    if (!workId || !personalId || !removedId || !otherId) {
      throw new Error("Public custom accounts were not created");
    }
    const wrongTarget = await accept(
      accountClient().setDefault({
        headers: authHeaders(),
        params: { connectionId: personalId },
        body: { target: separate.target },
      }),
      [404],
    );
    expect(wrongTarget.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: "Connector account not found",
    });
    const deleted = await accept(
      accountClient().delete({
        headers: authHeaders(),
        params: { connectionId: removedId },
        body: { target: primary.target },
      }),
      [200],
    );
    expect(deleted.body).toStrictEqual({
      deletedConnectionId: removedId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });
    const missing = await accept(
      accountClient().setDefault({
        headers: authHeaders(),
        params: { connectionId: removedId },
        body: { target: primary.target },
      }),
      [404],
    );
    expect(missing.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: "Connector account not found",
    });
    const unchanged = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: primary.target,
      }),
      [200],
    );
    expect(unchanged.body.connections).toHaveLength(2);
    expect(
      unchanged.body.connections
        .filter((account) => {
          return account.isDefault;
        })
        .map((account) => {
          return account.id;
        }),
    ).toStrictEqual([workId]);
    const filteredCustomPage = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { ...primary.target, limit: 1, search: "Personal" },
      }),
      [200],
    );
    expect(filteredCustomPage.body.connections).toMatchObject([
      { id: personalId, isDefault: false },
    ]);
    expect(filteredCustomPage.body.defaultConnection).toMatchObject({
      id: workId,
      target: primary.target,
      isDefault: true,
    });
    for (let selection = 0; selection < 2; selection += 1) {
      const selected = await accept(
        accountClient().setDefault({
          headers: authHeaders(),
          params: { connectionId: personalId },
          body: { target: primary.target },
        }),
        [200],
      );
      expect(selected.body).toMatchObject({
        id: personalId,
        target: primary.target,
        displayName: "Personal",
        isDefault: true,
      });
    }
    for (const [group, expectedIds, defaultId] of [
      [primary, [workId, personalId], personalId],
      [separate, [otherId], otherId],
    ] as const) {
      const listed = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: group.target,
        }),
        [200],
      );
      expect(
        listed.body.connections
          .map((account) => {
            return account.id;
          })
          .sort(),
      ).toStrictEqual([...expectedIds].sort());
      expect(
        listed.body.connections
          .filter((account) => {
            return account.isDefault;
          })
          .map((account) => {
            return account.id;
          }),
      ).toStrictEqual([defaultId]);
      expect(listed.body.defaultConnection).toMatchObject({
        id: defaultId,
        target: group.target,
        isDefault: true,
      });
      for (const account of listed.body.connections) {
        expect(account.target).toStrictEqual(group.target);
      }
      expect(JSON.stringify(listed.body)).not.toContain("token-Primary-");
      expect(JSON.stringify(listed.body)).not.toContain("token-Separate-");
    }
  });

  it("adds siblings and manages exact default and deletion lifecycle", async () => {
    await seedFixture();

    const first = await accept(
      connectorClient().connect({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: "sk-work" },
        },
      }),
      [200],
    );
    const unnamed = await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: first.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(unnamed.body.displayName).toBeNull();
    await accept(
      accountClient().rename({
        headers: authHeaders(),
        params: { connectionId: first.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          displayName: "Work",
        },
      }),
      [200],
    );
    const initialImpact = await accept(
      accountClient().deletionImpact({
        headers: authHeaders(),
        params: { connectionId: first.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(initialImpact.body).toStrictEqual({
      connectionId: first.body.id,
      explicitSelectionCount: 0,
      hasSibling: false,
    });
    const initialPage = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(initialPage.body).toMatchObject({
      connections: [
        { id: first.body.id, displayName: "Work", isDefault: true },
      ],
      nextCursor: null,
      defaultConnection: { id: first.body.id, isDefault: true },
    });
    const second = await accept(
      connectorClient().connect({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Personal" },
          values: { apiKey: "sk-personal" },
        },
      }),
      [200],
    );
    expect(second.body.id).not.toBe(first.body.id);

    const exact = await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(exact.body).toMatchObject({
      id: second.body.id,
      displayName: "Personal",
      isDefault: false,
    });
    await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        query: { kind: "builtin", connectorSlug: "github" },
      }),
      [404],
    );

    const listed = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(listed.body.connections).toHaveLength(1);
    expect(listed.body.nextCursor).not.toBeNull();
    expect(listed.body.defaultConnection).toMatchObject({
      id: first.body.id,
      isDefault: true,
    });

    const next = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          cursor: listed.body.nextCursor!,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(next.body.connections).toHaveLength(1);
    expect(next.body.defaultConnection).toMatchObject({
      id: first.body.id,
      isDefault: true,
    });
    expect(
      new Set([listed.body.connections[0]!.id, next.body.connections[0]!.id]),
    ).toStrictEqual(new Set([first.body.id, second.body.id]));

    const beforeRename = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          search: "Personal renamed",
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(beforeRename.body.connections).toStrictEqual([]);
    expect(beforeRename.body.defaultConnection).toMatchObject({
      id: first.body.id,
      isDefault: true,
    });

    const renamed = await accept(
      accountClient().rename({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          displayName: "Personal renamed",
        },
      }),
      [200],
    );
    expect(renamed.body.displayName).toBe("Personal renamed");

    const selectedDefault = await accept(
      accountClient().setDefault({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        body: { target: { kind: "builtin", connectorSlug: "openai" } },
      }),
      [200],
    );
    expect(selectedDefault.body.isDefault).toBeTruthy();

    const currentPage = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(currentPage.body.defaultConnection).toMatchObject({
      id: second.body.id,
      displayName: "Personal renamed",
      isDefault: true,
    });
    const afterRename = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          search: "Personal renamed",
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(afterRename.body.connections).toMatchObject([
      { id: second.body.id, displayName: "Personal renamed", isDefault: true },
    ]);
    expect(afterRename.body.nextCursor).toBeNull();
    expect(afterRename.body.defaultConnection).toMatchObject({
      id: second.body.id,
      displayName: "Personal renamed",
      isDefault: true,
    });

    const [currentFirst, currentSecond, currentFirstImpact] = await Promise.all(
      [
        accept(
          accountClient().connection({
            headers: authHeaders(),
            params: { connectionId: first.body.id },
            query: { kind: "builtin", connectorSlug: "openai" },
          }),
          [200],
        ),
        accept(
          accountClient().connection({
            headers: authHeaders(),
            params: { connectionId: second.body.id },
            query: { kind: "builtin", connectorSlug: "openai" },
          }),
          [200],
        ),
        accept(
          accountClient().deletionImpact({
            headers: authHeaders(),
            params: { connectionId: first.body.id },
            query: { kind: "builtin", connectorSlug: "openai" },
          }),
          [200],
        ),
      ],
    );
    expect(currentFirst.body).toMatchObject({
      id: first.body.id,
      displayName: "Work",
      isDefault: false,
    });
    expect(currentSecond.body).toMatchObject({
      id: second.body.id,
      displayName: "Personal renamed",
      isDefault: true,
    });
    expect(currentFirstImpact.body).toStrictEqual({
      connectionId: first.body.id,
      explicitSelectionCount: 0,
      hasSibling: true,
    });

    const legacyProjection = await accept(
      connectorProjectionClient().get({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
      }),
      [200],
    );
    expect(legacyProjection.body.id).toBe(second.body.id);

    const summary = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.summaries).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "openai" },
        accountCount: 2,
        attentionCount: 0,
        defaultConnection: expect.objectContaining({ id: second.body.id }),
      }),
    );

    const impact = await accept(
      accountClient().deletionImpact({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(impact.body).toStrictEqual({
      connectionId: second.body.id,
      explicitSelectionCount: 0,
      hasSibling: true,
    });

    const deleted = await accept(
      accountClient().delete({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    expect(deleted.body).toStrictEqual({
      deletedConnectionId: second.body.id,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: first.body.id,
    });

    await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [404],
    );
    await accept(
      accountClient().deletionImpact({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [404],
    );

    const remaining = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 100,
          search: "Work",
        },
      }),
      [200],
    );
    expect(remaining.body.connections).toHaveLength(1);
    expect(remaining.body.connections[0]).toMatchObject({
      id: first.body.id,
      displayName: "Work",
      isDefault: true,
    });
    expect(remaining.body.defaultConnection).toMatchObject({
      id: first.body.id,
      displayName: "Work",
      isDefault: true,
    });
    const remainingImpact = await accept(
      accountClient().deletionImpact({
        headers: authHeaders(),
        params: { connectionId: first.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(remainingImpact.body).toStrictEqual({
      connectionId: first.body.id,
      explicitSelectionCount: 0,
      hasSibling: false,
    });
    const remainingPage = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(remainingPage.body).toMatchObject({
      connections: [
        { id: first.body.id, displayName: "Work", isDefault: true },
      ],
      nextCursor: null,
      defaultConnection: { id: first.body.id, isDefault: true },
    });
  });

  async function createRenameAccount(
    actor: ApiTestUser,
    kind: "builtin" | "manual" | "oauth",
  ): Promise<{
    readonly connectionId: string;
    readonly target: ConnectorAccountTarget;
  }> {
    if (kind === "builtin") {
      const added = await accept(
        connectorClient().connect({
          headers: authHeaders(),
          params: { connectorSlug: "openai" },
          body: {
            authMethod: "api-token",
            account: { intent: "add", displayName: "Original" },
            values: { apiKey: `sk-test-${randomUUID()}` },
          },
        }),
        [200],
      );
      return {
        connectionId: added.body.id,
        target: { kind: "builtin", connectorSlug: "openai" },
      };
    }
    const connectorApi = createConnectorBddApi(context);
    const provider =
      kind === "oauth"
        ? mockCustomConnectorOAuth2Provider(context, { initialScope: "read" })
        : null;
    const definition = await connectorApi.createCustomConnector(actor, {
      displayName: "Rename custom account",
      prefixTemplates: [`https://${randomUUID()}.rename.example.test/`],
      queryInjections: [],
      ...(provider
        ? {
            authMode: "oauth",
            fields: [],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{oauth.access_token}}",
              },
            ],
            oauthConfig: {
              providerAdapter: "standard",
              clientId: "rename-client",
              clientSecret: "rename-client-secret",
              authorizationUrl: provider.authorizationUrl,
              tokenUrl: provider.tokenUrl,
              tokenEndpointAuthMethod: "client_secret_post",
              pkceMethod: "none",
              scopes: ["read"],
              authorizationParams: {},
            },
          }
        : {
            fields: [
              {
                key: "secret",
                label: "Secret",
                kind: "secret",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.secret}}",
              },
            ],
          }),
    });
    if (provider) {
      const authorization = new URL(
        await connectorApi.startCustomConnectorOAuth2AtBaseUrl(
          actor,
          definition.id,
          "https://api.okou.ai",
          { intent: "add", displayName: "Original" },
        ),
      );
      const state = authorization.searchParams.get("state");
      if (!state) {
        throw new Error("Expected custom connector OAuth state");
      }
      await connectorApi.completeCustomConnectorOAuth2Callback(
        { code: `rename-${randomUUID()}`, state },
        { baseUrl: "https://api.okou.ai" },
      );
    } else {
      await connectorApi.setCustomConnectorValues(
        actor,
        definition.id,
        [{ key: "secret", kind: "secret", value: "rename-secret" }],
        { intent: "add", displayName: "Original" },
      );
    }
    const [account] = await connectorApi.listCustomConnectorAccounts(
      actor,
      definition.id,
    );
    if (!account) {
      throw new Error("Expected a publicly connected custom account");
    }
    return {
      connectionId: account.id,
      target: { kind: "custom", customConnectorId: definition.id },
    };
  }

  it.each([
    ["user", "builtin"],
    ["organization", "builtin"],
    ["user", "manual"],
    ["organization", "manual"],
    ["user", "oauth"],
    ["organization", "oauth"],
  ] as const)(
    "renames only exact owned accounts across %s boundaries for %s accounts",
    async (boundary, kind) => {
      const bdd = createBddApi(context);
      const owner = bdd.user();
      const foreign =
        boundary === "user"
          ? bdd.user({ orgId: owner.orgId })
          : bdd.user({ userId: owner.userId });
      if (!owner.orgId || !foreign.orgId) {
        throw new Error("Account fixtures require an organization");
      }
      const ownerActor = { ...owner, orgId: owner.orgId };
      const foreignActor = { ...foreign, orgId: foreign.orgId };
      await track(Promise.resolve(foreignActor));
      await track(Promise.resolve(ownerActor));
      const activate = async (actor: typeof ownerActor) => {
        await bdd.readMe(actor);
        mockClerkMembership(context, actor, "org:admin");
      };
      const checks = await settle(
        (async () => {
          await bdd.completeOnboarding(ownerActor);
          await bdd.completeOnboarding(foreignActor);
          await activate(ownerActor);
          const { connectionId, target } = await createRenameAccount(
            ownerActor,
            kind,
          );
          const readOwned = () => {
            return accept(
              accountClient().connection({
                headers: authHeaders(),
                params: { connectionId },
                query: target,
              }),
              [200],
            );
          };
          const original = await readOwned();
          const ownedImpact = await accept(
            accountClient().deletionImpact({
              headers: authHeaders(),
              params: { connectionId },
              query: target,
            }),
            [200],
          );
          expect(ownedImpact.body).toStrictEqual({
            connectionId,
            explicitSelectionCount: 0,
            hasSibling: false,
          });
          const rejectedBodies: unknown[] = [];
          for (const request of [
            { actor: foreignActor, connectionId, target },
            { actor: foreignActor, connectionId: randomUUID(), target },
            { actor: ownerActor, connectionId: randomUUID(), target },
            {
              actor: ownerActor,
              connectionId,
              target: {
                kind: "custom",
                customConnectorId: randomUUID(),
              } as const,
            },
            {
              actor: ownerActor,
              connectionId,
              target: { kind: "builtin", connectorSlug: "github" } as const,
            },
          ]) {
            await activate(request.actor);
            const rejected = await accept(
              accountClient().rename({
                headers: authHeaders(),
                params: { connectionId: request.connectionId },
                body: { target: request.target, displayName: "Rejected" },
              }),
              [404],
            );
            rejectedBodies.push(rejected.body);
            const rejectedImpact = await accept(
              accountClient().deletionImpact({
                headers: authHeaders(),
                params: { connectionId: request.connectionId },
                query: request.target,
              }),
              [404],
            );
            expect(rejectedImpact.body).toStrictEqual(rejected.body);
          }
          const notFound = {
            error: {
              code: "NOT_FOUND",
              message: "Connector account not found",
            },
          };
          expect(rejectedBodies).toStrictEqual([
            notFound,
            notFound,
            notFound,
            notFound,
            notFound,
          ]);
          await activate(ownerActor);
          const unchanged = await readOwned();
          expect(unchanged.body).toStrictEqual(original.body);
          for (const displayName of ["Renamed", null]) {
            const renamed = await accept(
              accountClient().rename({
                headers: authHeaders(),
                params: { connectionId },
                body: { target, displayName },
              }),
              [200],
            );
            expect(renamed.body.displayName).toBe(displayName);
            const readBack = await readOwned();
            expect(readBack.body).toStrictEqual(renamed.body);
          }
        })(),
      );
      const cleanupErrors: unknown[] = [];
      for (const actor of [foreignActor, ownerActor]) {
        const cleaned = await settle(
          (async () => {
            await activate(actor);
            await cleanupFixture(actor);
          })(),
        );
        if (!cleaned.ok) {
          cleanupErrors.push(cleaned.error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [...(!checks.ok ? [checks.error] : []), ...cleanupErrors],
          "Account rename fixture cleanup failed",
        );
      }
      if (!checks.ok) {
        throw checks.error;
      }
    },
  );

  it("keeps concurrent sibling creation to exactly one default", async () => {
    await seedFixture();

    const responses = await Promise.all(
      ["Concurrent A", "Concurrent B"].map((displayName) => {
        return connectorClient().connect({
          headers: authHeaders(),
          params: { connectorSlug: "openai" },
          body: {
            authMethod: "api-token",
            account: { intent: "add", displayName },
            values: { apiKey: `sk-${displayName}` },
          },
        });
      }),
    );
    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    const accounts = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai", limit: 100 },
      }),
      [200],
    );
    expect(accounts.body.connections).toHaveLength(2);

    const preserved = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai", limit: 100 },
      }),
      [200],
    );
    expect(preserved.body.connections).toHaveLength(2);
    expect(
      accounts.body.connections.filter((account) => {
        return account.isDefault;
      }),
    ).toHaveLength(1);
  });

  async function createAccounts(accountCount: number): Promise<string[]> {
    // A unique user and organization own every account created by this case.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const createdAccountIds: string[] = [];
    // Account pagination does not depend on credential storage. Connect real
    // public accounts instead of provisioning an API key for every row.
    const connectorsApi = setupApp({
      context,
      routes: builtinConnectorsRoutes.filter(({ route }) => {
        return route === builtinConnectorNoAuthGrantContract.connect;
      }),
    })(builtinConnectorNoAuthGrantContract);
    // Up to sixteen owned streams keep requests moving without unbounded
    // fan-out. Wait for every stream before fixture cleanup after a failure.
    const created = await Promise.allSettled(
      Array.from({ length: Math.min(16, accountCount) }, async (_, stream) => {
        for (let index = stream; index < accountCount; index += 16) {
          const label = `Bulk ${index.toString().padStart(3, "0")}`;
          const response = await accept(
            connectorsApi.connect({
              headers: authHeaders(),
              params: { connectorSlug: "public-mcp" },
              body: {
                authMethod: "none",
                account: { intent: "add", displayName: label },
              },
            }),
            [200],
          );
          createdAccountIds[index] = response.body.id;
        }
      }),
    );
    for (const result of created) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    return createdAccountIds;
  }

  it("returns the default account outside the requested page", async () => {
    const createdAccountIds = await createAccounts(3);
    const firstTwo = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "public-mcp", limit: 2 },
      }),
      [200],
    );
    expect(firstTwo.body.connections).toHaveLength(2);
    const outsideFirstTwo = createdAccountIds.find((id) => {
      return !firstTwo.body.connections.some((account) => {
        return account.id === id;
      });
    });
    if (!outsideFirstTwo) {
      throw new Error("Expected an account outside the first two rows");
    }
    const defaultAccount = await accept(
      accountClient().setDefault({
        headers: authHeaders(),
        params: { connectionId: outsideFirstTwo },
        body: { target: { kind: "builtin", connectorSlug: "public-mcp" } },
      }),
      [200],
    );
    expect(defaultAccount.body).toMatchObject({
      id: outsideFirstTwo,
      isDefault: true,
    });
    const firstPage = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "public-mcp",
          limit: 1,
          includeScopeMismatch: "true",
        },
      }),
      [200],
    );
    expect(firstPage.body.connections).toHaveLength(1);
    expect(firstPage.body.connections[0]!.id).toBe(
      firstTwo.body.connections[0]!.id,
    );
    expect(firstPage.body.defaultConnection).toMatchObject({
      id: defaultAccount.body.id,
      isDefault: true,
    });
    expect(firstPage.body.nextCursor).not.toBeNull();
  });

  describe("more than one hundred accounts", () => {
    let createdAccountIds: string[];

    beforeEach(async () => {
      // Each case gets the fixed catalog and owns all 101 API-created accounts.
      createdAccountIds = await createAccounts(101);
    });

    it("paginates more than one hundred accounts", async () => {
      const ids = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await accept(
          accountClient().connections({
            headers: authHeaders(),
            query: {
              kind: "builtin",
              connectorSlug: "public-mcp",
              limit: 23,
              ...(cursor ? { cursor } : {}),
            },
          }),
          [200],
        );
        for (const account of page.body.connections) {
          ids.add(account.id);
        }
        cursor = page.body.nextCursor ?? undefined;
      } while (cursor);
      expect(ids.size).toBe(101);
      expect(ids).toStrictEqual(new Set(createdAccountIds));
    });

    it("summarizes more than one hundred accounts", async () => {
      const summary = await accept(
        accountClient().summaries({ headers: authHeaders() }),
        [200],
      );
      expect(summary.body.summaries).toContainEqual(
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "public-mcp" },
          accountCount: 101,
        }),
      );
    });

    it("searches display names across more than one hundred accounts", async () => {
      const searched = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "public-mcp",
            limit: 100,
            search: "Bulk 042",
          },
        }),
        [200],
      );
      expect(searched.body.connections).toHaveLength(1);
      expect(searched.body.connections[0]!.displayName).toBe("Bulk 042");
    });

    it("searches fallback names outside the first account page", async () => {
      const firstPage = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: { kind: "builtin", connectorSlug: "public-mcp", limit: 23 },
        }),
        [200],
      );
      const firstPageIds = new Set(
        firstPage.body.connections.map((account) => {
          return account.id;
        }),
      );
      const accountOutsideFirstPage = createdAccountIds.find((id) => {
        return !firstPageIds.has(id);
      });
      if (!accountOutsideFirstPage) {
        throw new Error("Expected an account outside the first page");
      }
      await accept(
        accountClient().rename({
          headers: authHeaders(),
          params: { connectionId: accountOutsideFirstPage },
          body: {
            target: { kind: "builtin", connectorSlug: "public-mcp" },
            displayName: null,
          },
        }),
        [200],
      );
      const searchedByFallback = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "public-mcp",
            limit: 100,
            search: accountOutsideFirstPage.slice(0, 8),
          },
        }),
        [200],
      );
      expect(searchedByFallback.body.connections).toContainEqual(
        expect.objectContaining({
          id: accountOutsideFirstPage,
          displayName: null,
        }),
      );
    });
  });

  it("does not enumerate or mutate another member account", async () => {
    const owner = await seedFixture();
    const account = await accept(
      connectorClient().connect({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Owner" },
          values: { apiKey: "sk-owner" },
        },
      }),
      [200],
    );
    const other = await seedFixture({ orgId: owner.orgId });
    mocks.clerk.session(other.userId, other.orgId);

    const listed = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 100,
          search: account.body.id.slice(0, 8),
        },
      }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([]);
    await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: account.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [404],
    );
    const inspected = await accept(
      accountClient().inspect({
        headers: authHeaders(),
        body: {
          selections: [
            {
              connectionId: account.body.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [200],
    );
    expect(inspected.body.results).toStrictEqual([
      {
        kind: "unavailable",
        connectionId: account.body.id,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    ]);
    await accept(
      accountClient().rename({
        headers: authHeaders(),
        params: { connectionId: account.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          displayName: "Stolen",
        },
      }),
      [404],
    );

    await seedFixture();
    const crossOrganization = await accept(
      accountClient().inspect({
        headers: authHeaders(),
        body: {
          selections: [
            {
              connectionId: account.body.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [200],
    );
    expect(crossOrganization.body.results[0]?.kind).toBe("unavailable");
  });

  it.each([
    {
      label: "HTTP",
      body: {
        displayName: "No-auth account HTTP",
        prefixTemplates: ["https://no-auth-api.example.com/"],
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "none" as const,
      } satisfies CreateCustomConnectorBody,
    },
    {
      label: "MCP",
      body: {
        kind: "mcp" as const,
        displayName: "No-auth account MCP",
        endpoint: "https://no-auth-mcp.example.com/",
        transport: "streamable-http" as const,
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "none" as const,
      } satisfies CreateCustomConnectorBody,
    },
  ])(
    "projects no-auth custom $label accounts as connected without credential checks",
    async ({ body }) => {
      const fixture = await seedFixture();
      mocks.clerk.session(fixture.userId, fixture.orgId);
      const definition = await accept(
        customConnectorClient().create({ headers: authHeaders(), body }),
        [201],
      );
      const connected = await accept(
        customConnectorValuesClient().set({
          headers: authHeaders(),
          params: { id: definition.body.id },
          body: { values: [], account: { intent: "add" } },
        }),
        [200],
      );
      const accountId = connected.body.connectedAccountId;
      if (!accountId) {
        throw new Error("Expected a connected no-auth custom account");
      }

      if (body.kind === "mcp") {
        await accept(
          customConnectorByIdClient().update({
            headers: authHeaders(),
            params: { id: definition.body.id },
            body: { ...body, storageVersion: 2 },
          }),
          [200],
        );
      }

      const accounts = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
            limit: 100,
          },
        }),
        [200],
      );
      expect(accounts.body.connections).toMatchObject([
        {
          id: accountId,
          authMethod: "none",
          isDefault: true,
          connectionStatus: "connected",
          reconnectReason: null,
          setupStatus: "complete",
          missingRequiredFields: [],
          configuredFieldKeys: [],
        },
      ]);

      const exact = await accept(
        accountClient().connection({
          headers: authHeaders(),
          params: { connectionId: accountId },
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
          },
        }),
        [200],
      );
      expect(exact.body).toMatchObject({
        id: accountId,
        authMethod: "none",
        connectionStatus: "connected",
        reconnectReason: null,
      });

      const summaries = await accept(
        accountClient().summaries({ headers: authHeaders() }),
        [200],
      );
      expect(summaries.body.summaries).toContainEqual({
        target: {
          kind: "custom",
          customConnectorId: definition.body.id,
        },
        accountCount: 1,
        attentionCount: 0,
        defaultConnection: exact.body,
      });
    },
  );

  it.each([
    {
      label: "HTTP",
      body: {
        displayName: "Account HTTP",
        prefixTemplates: ["https://api.example.com/"],
        fields: [
          {
            key: "secret",
            label: "Secret",
            kind: "secret" as const,
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [],
      } satisfies CreateCustomConnectorBody,
    },
    {
      label: "MCP",
      body: {
        kind: "mcp" as const,
        displayName: "Account MCP",
        endpoint: "https://mcp.example.com/",
        transport: "streamable-http" as const,
        fields: [
          {
            key: "secret",
            label: "Secret",
            kind: "secret" as const,
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [],
      } satisfies CreateCustomConnectorBody,
    },
  ])(
    "supports exact lifecycle for custom $label accounts",
    async ({ body }) => {
      const fixture = await seedFixture();
      mocks.clerk.session(fixture.userId, fixture.orgId);
      const definition = await accept(
        customConnectorClient().create({ headers: authHeaders(), body }),
        [201],
      );

      const connectedAccountIds: string[] = [];
      for (const displayName of [null, "Personal"]) {
        const connected = await accept(
          customConnectorValuesClient().set({
            headers: authHeaders(),
            params: { id: definition.body.id },
            body: {
              values: [
                {
                  key: "secret",
                  kind: "secret",
                  value: displayName
                    ? `token-${displayName.toLowerCase()}`
                    : "token-work",
                },
              ],
              account: displayName
                ? { intent: "add", displayName }
                : { intent: "add" },
            },
          }),
          [200],
        );
        expect(connected.body.connectedAccountId).toBeTruthy();
        expect(connected.body).toMatchObject({
          connected: true,
          configuredFieldKeys: ["secret"],
          missingRequiredFields: [],
        });
        if (connected.body.connectedAccountId) {
          connectedAccountIds.push(connected.body.connectedAccountId);
        }
      }

      const detail = await accept(
        customConnectorByIdClient().get({
          headers: authHeaders(),
          params: { id: definition.body.id },
        }),
        [200],
      );
      const listedDefinitions = await accept(
        customConnectorClient().list({ headers: authHeaders() }),
        [200],
      );
      for (const projection of [
        detail.body,
        listedDefinitions.body.connectors.find((connector) => {
          return connector.id === definition.body.id;
        }),
      ]) {
        expect(projection).toMatchObject({
          id: definition.body.id,
          connected: true,
          connectedAccountId: connectedAccountIds[0],
          connectedAccountUpdatedAt: expect.any(String),
          configuredFieldKeys: ["secret"],
          missingRequiredFields: [],
        });
      }
      const visible = JSON.stringify([detail.body, listedDefinitions.body]);
      expect(visible).not.toContain("token-work");
      expect(visible).not.toContain("token-personal");

      const accounts = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
            limit: 100,
          },
        }),
        [200],
      );
      expect(accounts.body.connections).toHaveLength(2);
      expect(
        accounts.body.connections.filter((account) => {
          return account.isDefault;
        }),
      ).toHaveLength(1);
      expect(
        accounts.body.connections.map((account) => {
          return account.displayName;
        }),
      ).toStrictEqual(expect.arrayContaining([null, "Personal"]));
      expect(connectedAccountIds.sort()).toStrictEqual(
        accounts.body.connections
          .map((account) => {
            return account.id;
          })
          .sort(),
      );

      const exact = await accept(
        accountClient().connection({
          headers: authHeaders(),
          params: { connectionId: accounts.body.connections[0]!.id },
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
          },
        }),
        [200],
      );
      expect(exact.body.target).toStrictEqual({
        kind: "custom",
        customConnectorId: definition.body.id,
      });

      const inspected = await accept(
        accountClient().inspect({
          headers: authHeaders(),
          body: {
            selections: [
              {
                connectionId: exact.body.id,
                target: {
                  kind: "custom",
                  customConnectorId: definition.body.id,
                },
              },
            ],
          },
        }),
        [200],
      );
      expect(inspected.body.results).toStrictEqual([
        {
          kind: "available",
          connectionId: exact.body.id,
          target: {
            kind: "custom",
            customConnectorId: definition.body.id,
          },
          authMethod: "manual",
          displayName: exact.body.displayName,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          connectionStatus: "connected",
          reconnectReason: null,
          setupStatus: "complete",
          missingRequiredFields: [],
          configuredFieldKeys: ["secret"],
        },
      ]);

      const work = accounts.body.connections.find((account) => {
        return account.displayName === null;
      });
      const personal = accounts.body.connections.find((account) => {
        return account.displayName === "Personal";
      });
      if (!work || !personal) {
        throw new Error("Expected both custom connector accounts");
      }

      const searchedByFallback = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
            limit: 100,
            search: work.id.slice(0, 8),
          },
        }),
        [200],
      );
      expect(searchedByFallback.body.connections).toContainEqual(work);

      const renamed = await accept(
        accountClient().rename({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          body: {
            target: {
              kind: "custom",
              customConnectorId: definition.body.id,
            },
            displayName: "Personal renamed",
          },
        }),
        [200],
      );
      expect(renamed.body.displayName).toBe("Personal renamed");

      await accept(
        accountClient().setDefault({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          body: {
            target: {
              kind: "custom",
              customConnectorId: definition.body.id,
            },
          },
        }),
        [200],
      );
      const defaultDetail = await accept(
        customConnectorByIdClient().get({
          headers: authHeaders(),
          params: { id: definition.body.id },
        }),
        [200],
      );
      const defaultDefinitions = await accept(
        customConnectorClient().list({ headers: authHeaders() }),
        [200],
      );
      for (const projection of [
        defaultDetail.body,
        defaultDefinitions.body.connectors.find((connector) => {
          return connector.id === definition.body.id;
        }),
      ]) {
        expect(projection).toMatchObject({
          id: definition.body.id,
          connected: true,
          connectedAccountId: personal.id,
          connectedAccountUpdatedAt: expect.any(String),
          configuredFieldKeys: ["secret"],
          missingRequiredFields: [],
        });
      }
      const defaultVisible = JSON.stringify([
        defaultDetail.body,
        defaultDefinitions.body,
      ]);
      expect(defaultVisible).not.toContain("token-work");
      expect(defaultVisible).not.toContain("token-personal");

      const impact = await accept(
        accountClient().deletionImpact({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
          },
        }),
        [200],
      );
      expect(impact.body).toStrictEqual({
        connectionId: personal.id,
        explicitSelectionCount: 0,
        hasSibling: true,
      });

      const deleted = await accept(
        accountClient().delete({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          body: {
            target: {
              kind: "custom",
              customConnectorId: definition.body.id,
            },
          },
        }),
        [200],
      );
      expect(deleted.body).toStrictEqual({
        deletedConnectionId: personal.id,
        resolvedSelectionCount: 0,
        promotedDefaultConnectionId: work.id,
      });

      const remaining = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
            limit: 100,
          },
        }),
        [200],
      );
      expect(remaining.body.connections).toMatchObject([
        { id: work.id, displayName: null, isDefault: true },
      ]);

      await accept(
        accountClient().delete({
          headers: authHeaders(),
          params: { connectionId: work.id },
          body: {
            target: {
              kind: "custom",
              customConnectorId: definition.body.id,
            },
          },
        }),
        [200],
      );
      const disconnected = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
            limit: 100,
          },
        }),
        [200],
      );
      expect(disconnected.body.connections).toStrictEqual([]);
    },
  );
});
