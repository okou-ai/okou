import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { HttpResponse, http } from "msw";
import { server } from "../../../mocks/server";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { builtinConnectorsRoutes } from "../connectors";
import { createHash, randomUUID } from "node:crypto";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorCatalogRoutes } from "../connector-catalog";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  connectorCatalogArtifactSchema,
  CONNECTOR_CATALOG_ACTIVE_KEY,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { getApiTestMocks } from "../../../__tests__/mocks";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { createRouteMocks } from "./helpers/route-test";

import { describe, expect, it } from "vitest";

const context = testContext();
const routeMocks = createRouteMocks(context);

function release(version: string, label: string) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  const first = artifact.connectors[0];
  if (!first) {
    throw new Error("Missing fixed catalog connector");
  }
  first.label = label;
  return publication(artifact);
}

function publication(artifact: ConnectorCatalogArtifact) {
  const raw = Buffer.from(JSON.stringify(artifact));
  const hash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const key = `connectors/v4/releases/${artifact.catalogVersion}/catalog.json`;
  const pointer = Buffer.from(
    JSON.stringify({
      catalogVersion: artifact.catalogVersion,
      catalogKey: key,
      catalogDigest: hash,
    }),
  );
  return { artifact, raw, hash, key, pointer };
}

function serve(candidate: ReturnType<typeof release>) {
  getApiTestMocks().s3.send.mockImplementation((command: unknown) => {
    const input = (command as { input: { Key?: string } }).input;
    const bytes =
      input.Key === CONNECTOR_CATALOG_ACTIVE_KEY
        ? candidate.pointer
        : input.Key === candidate.key
          ? candidate.raw
          : undefined;
    if (!bytes) {
      throw new Error("Uncontrolled lifecycle R2 key");
    }
    return Promise.resolve({
      ContentLength: bytes.length,
      Body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    });
  });
}

describe("immutable connector catalog publication", () => {
  it("serves a complete catalog after concurrent publication requests", async () => {
    const released = release("2099-01-01.competitors", "Concurrent catalog");
    // Use public methods with no platform OAuth configuration or feature gate.
    const candidate = publication({
      ...released.artifact,
      connectors: released.artifact.connectors.filter((connector) => {
        return ["public-mcp", "manual-mcp", "openai"].includes(connector.slug);
      }),
    });
    serve(candidate);
    // Initialize the selected database before issuing competing requests.
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    const client = app(cronConnectorCatalogContract);
    const responses = await Promise.all([
      accept(
        client.sync({ headers: { authorization: "Bearer test-cron-secret" } }),
        [200],
      ),
      accept(
        client.sync({ headers: { authorization: "Bearer test-cron-secret" } }),
        [200],
      ),
    ]);
    expect(
      responses.map((response) => {
        return response.body.outcome;
      }),
    ).toContain("accepted");
    for (const response of responses) {
      expect(["accepted", "unchanged"]).toContain(response.body.outcome);
      expect(response.body.failureCode).toBeNull();
    }
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const listed = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      listed.body.connectors
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    ).toStrictEqual(
      candidate.artifact.connectors
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    );
  });
});

describe("current-publication account readers", () => {
  const mocks = routeMocks;
  const routes = Object.freeze([
    ...connectorAccountRoutes,
    ...builtinConnectorsRoutes,
  ]);

  function authHeaders() {
    return { authorization: "Bearer clerk-session" };
  }

  function accountClient() {
    return setupApp({ context, routes })(connectorAccountsContract);
  }

  describe("connector account lifecycle routes", () => {
    it("reviews requested scopes for one exact account across default changes", async () => {
      const currentScopes = ["repo", "project", "workflow"] as const;
      const connectors = createConnectorBddApi(context);
      const owner = createPublicConnectorActor(context, {
        optionalEnvironmentNames: [
          "GH_OAUTH_CLIENT_ID",
          "GH_OAUTH_CLIENT_SECRET",
        ],
        beforeWorkspaceCleanup: async (): Promise<void> => {
          const accounts = await connectors.listBuiltinConnectorAccounts(
            actor,
            "github",
          );
          for (const account of accounts) {
            await connectors.deleteBuiltinConnectorAccount(
              actor,
              "github",
              account.id,
            );
          }
        },
      });
      const { actor, run: own } = owner;
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
        const state = new URL(started.authorizationUrl).searchParams.get(
          "state",
        );
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
        return account.id;
      };
      const firstId = await own(() => {
        return connectAccount(1001);
      });
      const currentId = await own(() => {
        return connectAccount(1002);
      });
      await own(() => {
        return connectors.setDefaultBuiltinConnectorAccount(
          actor,
          "github",
          currentId,
        );
      });

      const plainList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: { kind: "builtin", connectorSlug: "github", limit: 100 },
        }),
        [200],
      );
      expect(
        plainList.body.connections.every((account) => {
          return !("scopeMismatch" in account);
        }),
      ).toBeTruthy();
      expect(plainList.body.defaultConnection).toMatchObject({
        id: currentId,
        isDefault: true,
      });
      expect(plainList.body.defaultConnection).not.toHaveProperty(
        "scopeMismatch",
      );

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
          [firstId, false],
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
            search: firstId,
          },
        }),
        [200],
      );
      expect(filteredList.body.connections).toHaveLength(1);
      expect(filteredList.body.connections[0]?.id).toBe(firstId);
      expect(filteredList.body.defaultConnection).toMatchObject({
        id: currentId,
        isDefault: true,
        scopeMismatch: false,
      });

      const firstDiff = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: firstId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(firstDiff.body).toStrictEqual({
        addedScopes: [],
        removedScopes: [],
        currentScopes,
        storedScopes: currentScopes,
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
        own(() => {
          return accountClient().setDefault({
            headers: authHeaders(),
            params: { connectionId: firstId },
            body: { target: { kind: "builtin", connectorSlug: "github" } },
          });
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
      expect(currentDiffAfterDefaultChange.body).toStrictEqual(
        currentDiff.body,
      );

      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "openai" },
        }),
        [404],
      );
      const otherActor = createBddApi(context).user();
      mocks.clerk.session(otherActor.userId, otherActor.orgId);
      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [404],
      );

      mocks.clerk.session(actor.userId, actor.orgId);
      await accept(
        own(() => {
          return accountClient().delete({
            headers: authHeaders(),
            params: { connectionId: currentId },
            body: { target: { kind: "builtin", connectorSlug: "github" } },
          });
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
  });
});
