import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { builtinConnectorExternalCodeSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { agentsRoutes } from "../agents";
import { builtinConnectorsExternalCodeRoutes } from "../connectors-external-code";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);

function createActor() {
  mockAwsExternalCodeProvider();
  return createPublicConnectorActor(context, {
    beforeWorkspaceCleanup: () => {
      clearMockNow();
      return Promise.resolve();
    },
  });
}

function completionInput(
  session: BuiltinConnectorExternalCodeSessionStartResponse,
) {
  return {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    code: awsVerificationCode(session.authorizationUrl),
  };
}

function expectNoSecrets(body: unknown, sessionToken: string): void {
  const serialized = JSON.stringify(body);
  for (const secret of [
    sessionToken,
    "aws-secret-access-key",
    "aws-login-refresh-token",
    "aws-session-token",
    "aws-id-token",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

async function completeSession(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
) {
  const completed = await connectors.completeExternalCode(
    actor,
    "aws",
    completionInput(session),
  );
  expect(completed).toMatchObject({
    status: "complete",
    connector: {
      slug: "aws",
      authMethod: "cli",
      connectionStatus: "connected",
    },
  });
  expectNoSecrets(completed, session.sessionToken);
  return completed;
}

async function expectAccounts(
  actor: ApiTestUser,
  expected: readonly { readonly id: string; readonly isDefault: boolean }[],
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(actor, "aws");
  const byId = (
    left: { readonly id: string },
    right: { readonly id: string },
  ) => {
    return left.id.localeCompare(right.id);
  };
  expect(
    accounts
      .map(({ id, isDefault }) => {
        return { id, isDefault };
      })
      .sort(byId),
  ).toStrictEqual([...expected].sort(byId));
}

describe("Builtin external-code completed replay", () => {
  it("replays current non-default account state after reconnect and the original session lifetime", async () => {
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const startedAt = now();
      mockNow(startedAt);
      const defaultSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const siblingAccount = await completeSession(actor, siblingSession);
      expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);

      mockNow(startedAt + siblingSession.expiresIn * 1000 + 1);
      const reconnect = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        {
          intent: "reconnect",
          connectionId: siblingAccount.connector.id,
        },
      );
      const reconnected = await completeSession(actor, reconnect);
      expect(reconnected.connector.id).toBe(siblingAccount.connector.id);
      expect(reconnected.connector.updatedAt).not.toBe(
        siblingAccount.connector.updatedAt,
      );
      expect(reconnected.connector.tokenExpiresAt).not.toBe(
        siblingAccount.connector.tokenExpiresAt,
      );
      server.use(
        http.post("https://us-east-1.signin.aws.amazon.com/v1/token", () => {
          return HttpResponse.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
        }),
      );
      await expect(
        completeSession(actor, siblingSession),
      ).resolves.toStrictEqual(reconnected);
      await expectAccounts(actor, [
        { id: defaultAccount.connector.id, isDefault: true },
        { id: siblingAccount.connector.id, isDefault: false },
      ]);
      await expect(
        connectors.readConnectorBySlug(actor, "aws"),
      ).resolves.toMatchObject({
        id: defaultAccount.connector.id,
      });
    });
  });

  it("fails replay after the completed non-default account is deleted while its default survives", async () => {
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const defaultSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
      );
      const siblingAccount = await completeSession(actor, siblingSession);
      expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "aws",
        siblingAccount.connector.id,
      );

      const replay = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(siblingSession),
        [500],
      );
      expect(replay.body).toStrictEqual({ error: "Internal server error" });
      expectNoSecrets(replay.body, siblingSession.sessionToken);
      await expectAccounts(actor, [
        { id: defaultAccount.connector.id, isDefault: true },
      ]);
      await expect(
        connectors.readConnectorBySlug(actor, "aws"),
      ).resolves.toMatchObject({
        id: defaultAccount.connector.id,
      });
    });
  });

  it("rechecks explicit Agent authorization when a completed session is replayed after Agent deletion", async () => {
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      bdd.acceptAgentStorageWrites();
      const agent = await bdd.createAgent(actor, {
        displayName: "Replay authorization target",
      });
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const grants = setupApp({ context, routes: agentsRoutes })(
        userBuiltinConnectorsContract,
      );
      const headers = { authorization: "Bearer clerk-session" };
      const before = await accept(
        grants.get({ headers, params: { id: agent.agentId } }),
        [200],
      );
      expect(before.body.enabledConnectorSlugs).toStrictEqual([]);
      const started = await accept(
        setupApp({ context, routes: builtinConnectorsExternalCodeRoutes })(
          builtinConnectorExternalCodeSessionContract,
        ).create({
          headers,
          params: { connectorSlug: "aws" },
          body: {
            authMethod: "cli",
            agentId: agent.agentId,
            authorizeAgent: true,
            account: { intent: "add" },
          },
        }),
        [200],
      );
      const completed = await completeSession(actor, started.body);
      const authorized = await accept(
        grants.get({ headers, params: { id: agent.agentId } }),
        [200],
      );
      expect(authorized.body.enabledConnectorSlugs).toStrictEqual(["aws"]);
      await bdd.deleteAgent(actor, agent.agentId);

      const replay = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(started.body),
        [400],
      );
      expect(replay.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: `Agent not found: ${agent.agentId}`,
        },
      });
      expectNoSecrets(replay.body, started.body.sessionToken);
      await expectAccounts(actor, [
        { id: completed.connector.id, isDefault: true },
      ]);
      await expect(
        connectors.readConnectorBySlug(actor, "aws"),
      ).resolves.toMatchObject({
        id: completed.connector.id,
      });
      const agents = await bdd.listAgents(actor);
      expect(
        agents.map(({ agentId }) => {
          return agentId;
        }),
      ).not.toContain(agent.agentId);
    });
  });
});
