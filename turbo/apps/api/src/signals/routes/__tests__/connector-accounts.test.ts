import { randomUUID } from "node:crypto";

import {
  CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  connectorManualGrantContract,
  connectorsBySlugContract,
} from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  customConnectorByIdContract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { featureSwitchesRoutes } from "../feature-switches";
import {
  seedConnectorStorageRow,
  setBuiltinOAuthScopeFacts,
  setConnectorDefaultState,
} from "./helpers/connector-credential-storage-state";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const routes = Object.freeze([
  ...connectorAccountRoutes,
  ...connectorsRoutes,
  ...customConnectorsRoutes,
  ...customConnectorsDeleteRoutes,
  ...customConnectorsValuesSetRoutes,
  ...featureSwitchesRoutes,
]);

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function sandboxToken(
  fixture: Fixture,
  capabilities: readonly Capability[],
): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: fixture.userId,
    orgId: fixture.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function accountClient() {
  return setupApp({ context, routes })(connectorAccountsContract);
}

function connectorClient() {
  return setupApp({ context, routes })(connectorManualGrantContract);
}

function connectorProjectionClient() {
  return setupApp({ context, routes })(connectorsBySlugContract);
}

function featureClient() {
  return setupApp({ context, routes })(featureSwitchesContract);
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
  await accept(featureClient().delete({ headers: authHeaders() }), [200]);
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

  it("reviews requested scopes for one exact account across default changes", async () => {
    const fixture = await seedFixture();
    const currentScopes = ["repo", "project", "workflow"] as const;
    const staleId = await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "github",
      authMethod: "oauth",
      storageVersion: 1,
    });
    await setConnectorDefaultState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorId: staleId,
      isDefault: false,
    });
    const currentId = await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "github",
      authMethod: "oauth",
      storageVersion: 1,
    });
    await setBuiltinOAuthScopeFacts(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "github",
      connectorId: staleId,
      oauthScopes: ["repo"],
      oauthGrantedScopes: ["repo"],
    });
    await setBuiltinOAuthScopeFacts(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "github",
      connectorId: currentId,
      oauthScopes: currentScopes,
      // A provider may return fewer granted scopes than the app requested.
      // Scope review must compare against the requested snapshot instead.
      oauthGrantedScopes: ["repo"],
    });

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
  });

  it("inspects only exact owned accounts without leaking credentials", async () => {
    await seedFixture();
    const connected = await accept(
      connectorClient().connect({
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
    const missingId = randomUUID();

    const inspected = await accept(
      accountClient().inspect({
        headers: authHeaders(),
        body: {
          selections: [
            {
              connectionId: missingId,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
            {
              connectionId: connected.body.id,
              target: { kind: "builtin", connectorSlug: "github" },
            },
            {
              connectionId: connected.body.id,
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
        connectionId: missingId,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
      {
        kind: "unavailable",
        connectionId: connected.body.id,
        target: { kind: "builtin", connectorSlug: "github" },
      },
      {
        kind: "available",
        connectionId: connected.body.id,
        target: { kind: "builtin", connectorSlug: "openai" },
        authMethod: "api-token",
        displayName: "Work",
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        connectionStatus: "connected",
        reconnectReason: null,
      },
    ]);
  });

  it("requires connector read capability for account inspection", async () => {
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
          authorization: `Bearer ${sandboxToken(fixture, ["connector:read"])}`,
        },
        body: { selections: [] },
      }),
      [200],
    );
    expect(allowed.body).toStrictEqual({ results: [] });

    const denied = await accept(
      accountClient().inspect({
        headers: {
          authorization: `Bearer ${sandboxToken(fixture, [])}`,
        },
        body: { selections: [] },
      }),
      [403],
    );
    expect(denied.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
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
        query: { kind: "builtin", connectorSlug: "openai", limit: 1 },
      }),
      [200],
    );
    expect(listed.body.connections).toHaveLength(1);
    expect(listed.body.nextCursor).not.toBeNull();

    const next = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          cursor: listed.body.nextCursor!,
        },
      }),
      [200],
    );
    expect(next.body.connections).toHaveLength(1);
    expect(
      new Set([listed.body.connections[0]!.id, next.body.connections[0]!.id]),
    ).toStrictEqual(new Set([first.body.id, second.body.id]));

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
  });

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

  async function createBulkAccounts(): Promise<string[]> {
    await seedFixture();

    const createdAccountIds: string[] = [];
    const connectorsApi = connectorClient();
    for (let index = 0; index < 101; index += 1) {
      const label = `Bulk ${index.toString().padStart(3, "0")}`;
      const created = await accept(
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
      createdAccountIds.push(created.body.id);
    }
    return createdAccountIds;
  }

  it("paginates more than one hundred accounts", async () => {
    await createBulkAccounts();
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "openai",
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
  });

  it("summarizes more than one hundred accounts", async () => {
    await createBulkAccounts();
    const summary = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.summaries).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "openai" },
        accountCount: 101,
      }),
    );
  });

  it("searches display names across more than one hundred accounts", async () => {
    await createBulkAccounts();
    const searched = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
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
    const createdAccountIds = await createBulkAccounts();
    const firstPage = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai", limit: 23 },
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
          target: { kind: "builtin", connectorSlug: "openai" },
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
          connectorSlug: "openai",
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

  it("returns no matches for absent searches with more than one hundred accounts", async () => {
    await createBulkAccounts();
    const noMatch = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 100,
          search: "no-matching-connector-account",
        },
      }),
      [200],
    );
    expect(noMatch.body).toStrictEqual({
      connections: [],
      nextCursor: null,
    });
  });

  it("rejects blank searches with more than one hundred accounts", async () => {
    await createBulkAccounts();
    const response = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 100,
          search: " ",
        },
      }),
      [400],
    );
    expect(response.status).toBe(400);
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

  it("treats a removed built-in catalog target as absent", async () => {
    const fixture = await seedFixture();
    const accountId = await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "retired-connector",
      authMethod: "api-token",
      storageVersion: 1,
    });

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
    "projects current no-auth custom $label accounts as connected",
    async ({ body }) => {
      const fixture = await seedFixture();
      mocks.clerk.session(fixture.userId, fixture.orgId);
      await accept(
        featureClient().update({
          headers: authHeaders(),
          body: {
            switches: {
              [FeatureSwitchKey.CustomConnectorMcp]: true,
            },
          },
        }),
        [200],
      );
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
      await accept(
        featureClient().update({
          headers: authHeaders(),
          body: {
            switches: {
              [FeatureSwitchKey.CustomConnectorMcp]: true,
            },
          },
        }),
        [200],
      );
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
        if (connected.body.connectedAccountId) {
          connectedAccountIds.push(connected.body.connectedAccountId);
        }
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
