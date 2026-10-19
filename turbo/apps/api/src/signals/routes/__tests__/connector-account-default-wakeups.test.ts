import { randomUUID } from "node:crypto";
import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);

function requestDefault(
  actor: ApiTestUser,
  target: ConnectorAccountTarget,
  connectionId: string,
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  ).setDefault({
    headers: { authorization: "Bearer clerk-session" },
    params: { connectionId },
    body: { target },
  });
}

function expectedWakeup(
  runnerGroup: string,
  runId: string,
  target: ConnectorAccountTarget,
) {
  return {
    channels: [`runner-group:${runnerGroup}`],
    messages: [
      {
        name: "connector-runtime-sync",
        data: JSON.stringify({ runId, target }),
        encoding: "json",
      },
    ],
  };
}

describe("default connector account runtime wakeups", () => {
  it("notifies only the account owner's running run, excluding pending and cancelled states", async () => {
    mockEnv("ABLY_API_KEY", "test.key:secret");
    const owned = await publicChatActor(context, {
      tier: "team",
      optionalEnvironmentNames: ["ABLY_API_KEY"],
    });
    const bdd = createBddApi(context);
    const member = bdd.user({
      orgId: owned.actor.orgId,
      orgRole: "org:member",
    });
    const memberRuns = publicRunOwner(context, member);
    const target = { kind: "builtin", connectorSlug: "openai" } as const;

    await owned.run(async () => {
      const first = await connectors.connectManualGrant(
        owned.actor,
        "openai",
        "api-token",
        { apiKey: "sk-work" },
      );
      const second = await connectors.connectManualGrant(
        owned.actor,
        "openai",
        "api-token",
        { apiKey: "sk-personal" },
      );
      const run = await runs.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Observe my account default",
      });
      const otherRun = await memberRuns.run(async () => {
        await bdd.completeOnboarding(member);
        await runs.ensurePersonalSubscriptionModel(member);
        const agent = await bdd.createAgent(member);
        const created = await runs.createThreadRun(member, {
          agentId: agent.agentId,
          prompt: "Keep a teammate's run active",
        });
        await memberRuns.claim(created.runId);
        return created;
      });
      await expect(runs.readRun(member, otherRun.runId)).resolves.toMatchObject(
        {
          status: "running",
        },
      );
      context.mocks.ably.batchPublish.mockClear();

      await accept(requestDefault(member, target, second.id), [404]);
      await accept(requestDefault(owned.actor, target, randomUUID()), [404]);
      expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
      await expect(
        connectors.listBuiltinConnectorAccounts(owned.actor, "openai"),
      ).resolves.toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, isDefault: true }),
          expect.objectContaining({ id: second.id, isDefault: false }),
        ]),
      );

      const changed = await accept(
        requestDefault(owned.actor, target, second.id),
        [200],
      );
      expect(changed.body).toMatchObject({ id: second.id, isDefault: true });
      expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
      await expect(runs.readRun(owned.actor, run.runId)).resolves.toMatchObject(
        {
          status: "pending",
        },
      );
      await expect(
        connectors.listBuiltinConnectorAccounts(owned.actor, "openai"),
      ).resolves.toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, isDefault: false }),
          expect.objectContaining({ id: second.id, isDefault: true }),
        ]),
      );

      await owned.claimRunnerRun(run.runId);
      await accept(requestDefault(owned.actor, target, first.id), [200]);
      expect(context.mocks.ably.batchPublish).toHaveBeenCalledExactlyOnceWith(
        expectedWakeup(owned.runnerGroup, run.runId, target),
      );
      await expect(
        connectors.listBuiltinConnectorAccounts(owned.actor, "openai"),
      ).resolves.toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, isDefault: true }),
          expect.objectContaining({ id: second.id, isDefault: false }),
        ]),
      );

      await runs.requestCancelRun(owned.actor, run.runId, [200]);
      context.mocks.ably.batchPublish.mockClear();
      await accept(requestDefault(owned.actor, target, second.id), [200]);
      expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
      await expect(runs.readRun(member, otherRun.runId)).resolves.toMatchObject(
        {
          status: "running",
        },
      );
    });
  });

  it("keeps a custom default committed after notification failure and confines recovery to its workspace", async () => {
    mockEnv("ABLY_API_KEY", "test.key:secret");
    const owned = await publicChatActor(context, {
      optionalEnvironmentNames: ["ABLY_API_KEY"],
    });
    const outsider = await publicChatActor(context, {
      optionalEnvironmentNames: ["ABLY_API_KEY"],
    });

    await outsider.run(async () => {
      const foreignRun = await runs.createThreadRun(outsider.actor, {
        agentId: outsider.agentId,
        prompt: "A different workspace remains active",
      });
      await outsider.claimRunnerRun(foreignRun.runId);
    });
    await owned.run(async () => {
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", owned.runnerGroup);
      const custom = await connectors.createCustomConnector(
        owned.actor,
        manualHttpCustomConnectorCreateBody({
          displayName: "Default wakeup recovery",
          prefixTemplates: [`https://${randomUUID()}.example.test/`],
        }),
      );
      await connectors.setCustomConnectorSecret(owned.actor, custom.id, "work");
      await connectors.setCustomConnectorSecret(
        owned.actor,
        custom.id,
        "personal",
      );
      const accounts = await connectors.listCustomConnectorAccounts(
        owned.actor,
        custom.id,
      );
      const first = accounts.find((account) => {
        return account.isDefault;
      });
      const second = accounts.find((account) => {
        return !account.isDefault;
      });
      if (!first || !second) {
        throw new Error("Expected two public custom connector accounts");
      }
      const target = { kind: "custom", customConnectorId: custom.id } as const;
      const run = await runs.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Observe custom account defaults",
      });
      await owned.claimRunnerRun(run.runId);
      context.mocks.ably.batchPublish.mockClear();
      context.mocks.ably.batchPublish.mockRejectedValueOnce(
        new Error("Ably rejected this notification"),
      );

      await accept(requestDefault(owned.actor, target, second.id), [200]);
      expect(context.mocks.ably.batchPublish).toHaveBeenCalledExactlyOnceWith(
        expectedWakeup(owned.runnerGroup, run.runId, target),
      );
      await expect(
        connectors.listCustomConnectorAccounts(owned.actor, custom.id),
      ).resolves.toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, isDefault: false }),
          expect.objectContaining({ id: second.id, isDefault: true }),
        ]),
      );

      context.mocks.ably.batchPublish.mockClear();
      await accept(requestDefault(owned.actor, target, first.id), [200]);
      expect(context.mocks.ably.batchPublish).toHaveBeenCalledExactlyOnceWith(
        expectedWakeup(owned.runnerGroup, run.runId, target),
      );
      await expect(
        connectors.listCustomConnectorAccounts(owned.actor, custom.id),
      ).resolves.toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, isDefault: true }),
          expect.objectContaining({ id: second.id, isDefault: false }),
        ]),
      );
    });
  });
});
