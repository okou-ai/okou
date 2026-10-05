import { createHash, randomUUID } from "node:crypto";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { HttpResponse, http } from "msw";

import {
  CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  builtinConnectorManualGrantContract,
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
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  API_TEST_CONNECTOR_CATALOG,
  captureApiTestConnectorCatalogCleanup,
} from "../../../test-fixtures/connector-catalog";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { settle } from "../../utils";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  catalogWithAuthMethod,
  catalogWithManualConnector,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";

const context = testContext();
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
  return setupApp({ context, routes })(connectorAccountsContract);
}

function connectorClient() {
  return setupApp({ context, routes })(builtinConnectorManualGrantContract);
}

function customConnectorClient() {
  return setupApp({ context, routes })(customConnectorsContract);
}

function customConnectorByIdClient() {
  return setupApp({ context, routes })(customConnectorByIdContract);
}

async function deleteBuiltinAccountPage(
  connectorSlug: "openai" | "github",
  connections: readonly { readonly id: string }[],
): Promise<void> {
  const accountsApi = accountClient();
  for (let offset = 0; offset < connections.length; offset += 4) {
    const deleted = await Promise.allSettled(
      connections.slice(offset, offset + 4).map(async (account) => {
        await accept(
          accountsApi.delete({
            headers: authHeaders(),
            params: { connectionId: account.id },
            body: { target: { kind: "builtin", connectorSlug } },
          }),
          [200, 404],
        );
      }),
    );
    for (const result of deleted) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  }
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const accountsApi = accountClient();
  for (const connectorSlug of ["openai", "github"] as const) {
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

  it("reviews requested scopes for one exact account across default changes", async () => {
    const fixture = await seedFixture();
    const currentScopes = ["repo", "project", "workflow"] as const;
    const actor = createBddApi(context).user(fixture);
    const connectors = createConnectorBddApi(context);
    const catalog = createPublicConnectorCatalog(context);
    const staleCatalog = catalogWithAuthMethod(
      { connectorSlug: "github", authMethodId: "oauth" },
      (method) => {
        if (method.grant.kind !== "auth-code") {
          throw new Error("Expected the GitHub authorization-code method");
        }
        return { ...method, grant: { ...method.grant, scopes: ["repo"] } };
      },
    );
    const accountIds: string[] = [];
    catalog.onCleanup(async () => {
      const accounts = await connectors.listBuiltinConnectorAccounts(
        actor,
        "github",
      );
      for (const account of accounts) {
        if (accountIds.includes(account.id)) {
          await connectors.deleteBuiltinConnectorAccount(
            actor,
            "github",
            account.id,
          );
        }
      }
    });
    const connectAccount = async (userId: number) => {
      mockGitHubConnectorOAuth({ userId, login: `scope-review-${userId}` });
      // Grants can be narrower than the selected catalog's requested scopes.
      server.use(
        http.post("https://github.com/login/oauth/access_token", () => {
          return HttpResponse.json({
            access_token: `scope-review-${userId}`,
            scope: "repo",
          });
        }),
      );
      const started = await connectors.startOauth(actor, "github", "oauth");
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected GitHub OAuth state");
      }
      await connectors.completeOauthCallback("github", {
        code: `scope-review-${userId}`,
        state,
      });
      const accounts = await connectors.listBuiltinConnectorAccounts(
        actor,
        "github",
      );
      const account = accounts.find((candidate) => {
        return candidate.externalId === String(userId);
      });
      if (!account) {
        throw new Error("Expected the exact GitHub provider identity");
      }
      accountIds.push(account.id);
      return account.id;
    };
    await catalog.publish(staleCatalog);
    const staleId = await connectAccount(1001);
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);
    const currentId = await connectAccount(1002);
    await connectors.setDefaultBuiltinConnectorAccount(
      actor,
      "github",
      currentId,
    );

    const legacyList = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "github", limit: 100 },
      }),
      [200],
    );
    expect(
      legacyList.body.connections.every((account) => {
        return !("scopeMismatch" in account);
      }),
    ).toBeTruthy();
    expect("defaultConnection" in legacyList.body).toBeFalsy();

    const enrichedList = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "github",
          includeScopeMismatch: "true",
          limit: 100,
        },
      }),
      [200],
    );
    const mismatchById = new Map(
      enrichedList.body.connections.map((account) => {
        return [account.id, account.scopeMismatch] as const;
      }),
    );
    expect(mismatchById).toStrictEqual(
      new Map([
        [staleId, true],
        [currentId, false],
      ]),
    );
    expect(enrichedList.body.defaultConnection).toMatchObject({
      id: currentId,
      scopeMismatch: false,
    });

    const filteredList = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "github",
          includeScopeMismatch: "true",
          limit: 100,
          search: staleId,
        },
      }),
      [200],
    );
    expect(filteredList.body.connections).toHaveLength(1);
    expect(filteredList.body.connections[0]?.id).toBe(staleId);
    expect("defaultConnection" in filteredList.body).toBeFalsy();

    const staleDiff = await accept(
      accountClient().scopeDiff({
        headers: authHeaders(),
        params: { connectionId: staleId },
        query: { connectorSlug: "github" },
      }),
      [200],
    );
    expect(staleDiff.body).toStrictEqual({
      addedScopes: ["project", "workflow"],
      removedScopes: [],
      currentScopes,
      storedScopes: ["repo"],
    });
    const currentDiff = await accept(
      accountClient().scopeDiff({
        headers: authHeaders(),
        params: { connectionId: currentId },
        query: { connectorSlug: "github" },
      }),
      [200],
    );
    expect(currentDiff.body).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes,
      storedScopes: currentScopes,
    });

    await accept(
      accountClient().setDefault({
        headers: authHeaders(),
        params: { connectionId: staleId },
        body: { target: { kind: "builtin", connectorSlug: "github" } },
      }),
      [200],
    );
    const currentDiffAfterDefaultChange = await accept(
      accountClient().scopeDiff({
        headers: authHeaders(),
        params: { connectionId: currentId },
        query: { connectorSlug: "github" },
      }),
      [200],
    );
    expect(currentDiffAfterDefaultChange.body).toStrictEqual(currentDiff.body);

    await accept(
      accountClient().scopeDiff({
        headers: authHeaders(),
        params: { connectionId: currentId },
        query: { connectorSlug: "openai" },
      }),
      [404],
    );
    await seedFixture();
    await accept(
      accountClient().scopeDiff({
        headers: authHeaders(),
        params: { connectionId: currentId },
        query: { connectorSlug: "github" },
      }),
      [404],
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    await accept(
      accountClient().delete({
        headers: authHeaders(),
        params: { connectionId: currentId },
        body: { target: { kind: "builtin", connectorSlug: "github" } },
      }),
      [200],
    );
    await accept(
      accountClient().scopeDiff({
        headers: authHeaders(),
        params: { connectionId: currentId },
        query: { connectorSlug: "github" },
      }),
      [404],
    );
    await catalog.cleanup();
  });

  async function createBulkAccounts(): Promise<string[]> {
    await seedFixture();

    const createdAccountIds: string[] = [];
    const connectorsApi = connectorClient();
    // Four owned streams keep independent requests moving without unbounded
    // fan-out. Wait for every stream before fixture cleanup after a failure.
    const created = await Promise.allSettled(
      Array.from({ length: 4 }, async (_, stream) => {
        for (let index = stream; index < 101; index += 4) {
          const label = `Bulk ${index.toString().padStart(3, "0")}`;
          const response = await accept(
            connectorsApi.connect({
              headers: authHeaders(),
              params: { connectorSlug: "openai" },
              body: {
                authMethod: "api-token",
                account: { intent: "add", displayName: label },
                values: { apiKey: `sk-${label}` },
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

  it("treats a removed built-in catalog target as absent", async () => {
    const fixture = await seedFixture();
    const actor = createBddApi(context).user(fixture);
    const connectors = createConnectorBddApi(context);
    const catalog = createPublicConnectorCatalog(context);
    const available = catalogWithManualConnector({
      connectorSlug: "retired-connector",
      authMethodId: "api-token",
    });
    await catalog.publish(available);
    const account = await connectors.connectManualGrant(
      actor,
      "retired-connector",
      "api-token",
      {
        credential: "retired-connector-secret",
      },
    );
    const accountId = account.id;
    catalog.onCleanup(async () => {
      await catalog.publish(available);
      await connectors.deleteDefaultBuiltinConnectorAccount(
        actor,
        "retired-connector",
      );
    });
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);

    const summary = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.summaries).not.toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "retired-connector" },
      }),
    );
    await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "retired-connector",
          limit: 100,
        },
      }),
      [404],
    );
    await accept(
      accountClient().connection({
        headers: authHeaders(),
        params: { connectionId: accountId },
        query: {
          kind: "builtin",
          connectorSlug: "retired-connector",
        },
      }),
      [404],
    );
    await accept(
      accountClient().rename({
        headers: authHeaders(),
        params: { connectionId: accountId },
        body: {
          target: { kind: "builtin", connectorSlug: "retired-connector" },
          displayName: "Must remain absent",
        },
      }),
      [404],
    );
    await catalog.cleanup();
  });
});
