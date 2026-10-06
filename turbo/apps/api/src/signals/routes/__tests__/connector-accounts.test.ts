import { randomUUID } from "node:crypto";

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

import { now } from "../../../lib/time";

import { signSandboxJwtForTests } from "../../auth/tokens";
import { settle } from "../../utils";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";

import { createBddApi } from "./helpers/api-bdd";

import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

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
  });

  it.each(["user", "organization"] as const)(
    "renames only exact owned accounts across %s boundaries",
    async (boundary) => {
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
          const connectionId = added.body.id;
          const target = { kind: "builtin", connectorSlug: "openai" } as const;
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
          expect(rejectedBodies).toStrictEqual([notFound, notFound, notFound]);
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

  describe("more than one hundred accounts", () => {
    let createdAccountIds: string[];

    beforeEach(async () => {
      // Pagination changes accounts, not catalog generations. Use the existing
      // shared fixed catalog; the tracker still owns all 101 API-created accounts.
      createdAccountIds = await createBulkAccounts();
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
