import { CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();

describe("Runner run lookup ownership", () => {
  it("scopes active runtime synchronization to its owner without exposing terminal state", async () => {
    const api = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const owned = await publicChatActor(context);
    const { actor, agentId } = owned;
    const member = createBddApi(context).user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    const body = {
      targets: [{ kind: "builtin" as const, connectorSlug: "missing-builtin" }],
    };

    await owned.run(async () => {
      await api.updateUserModelPreference(actor, "claude-fable-5-1");
      const ownerKey = await api.createCliToken(actor);
      const memberKey = await api.createCliToken(member);
      const ownerBearer = `Bearer ${ownerKey.token}`;
      const memberBearer = `Bearer ${memberKey.token}`;
      const run = await api.createThreadRun(actor, {
        agentId,
        prompt: "the owner's queued lookup",
      });

      await api.requestSyncConnectorRuntimeAs(
        memberBearer,
        run.runId,
        body,
        [403],
      );
      const execution = await owned.claimRunnerRun(run.runId);
      expect(execution).toMatchObject({
        prompt: "the owner's queued lookup",
        isFirstRun: true,
        cliAgentType: "claude-code",
      });
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "running",
      });
      const synced = await api.requestSyncConnectorRuntimeAs(
        ownerBearer,
        run.runId,
        body,
        [200],
      );
      expect(synced.body.results).toStrictEqual([
        {
          target: body.targets[0],
          state: "absent",
          reason: "connector-unavailable",
        },
      ]);
      const foreign = await api.requestSyncConnectorRuntimeAs(
        memberBearer,
        run.runId,
        body,
        [403],
      );
      expect(foreign.body.error.message).toBe("Run does not belong to user");

      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          lastEventSequence: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: run.runId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "completed",
      });
      const terminal = await api.requestSyncConnectorRuntimeAs(
        ownerBearer,
        run.runId,
        body,
        [409],
      );
      expect(terminal.body.error.code).toBe(
        CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
      );
      await api.requestSyncConnectorRuntimeAs(
        memberBearer,
        run.runId,
        body,
        [404],
      );
    });
  });

  it("keeps completed and running lookups separate across distinct executions", async () => {
    const api = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const owned = await publicChatActor(context);
    const { actor, agentId } = owned;
    const body = {
      targets: [{ kind: "builtin" as const, connectorSlug: "missing-builtin" }],
    };

    await owned.run(async () => {
      await api.updateUserModelPreference(actor, "claude-fable-5-1");
      const key = await api.createCliToken(actor);
      const bearer = `Bearer ${key.token}`;
      const first = await api.createThreadRun(actor, {
        agentId,
        prompt: "complete this lookup first",
      });
      const firstClaim = await owned.claimRunnerRun(first.runId);
      expect(firstClaim.cliAgentType).toBe("claude-code");
      await webhooks.requestAgentComplete(
        {
          runId: first.runId,
          exitCode: 0,
          lastEventSequence: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: first.runId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        { authorization: `Bearer ${firstClaim.sandboxToken}` },
        [200],
      );
      await expect(api.readRun(actor, first.runId)).resolves.toMatchObject({
        status: "completed",
      });

      const next = await api.createThreadRun(actor, {
        agentId,
        prompt: "a distinct queued lookup",
      });
      expect(next.status).toBe("running");
      await api.requestSyncConnectorRuntimeAs(bearer, first.runId, body, [409]);

      const nextClaim = await owned.claimRunnerRun(next.runId);
      expect(nextClaim).toMatchObject({
        prompt: "a distinct queued lookup",
        isFirstRun: true,
      });
      const current = await api.requestSyncConnectorRuntimeAs(
        bearer,
        next.runId,
        body,
        [200],
      );
      expect(current.body.results).toStrictEqual([
        {
          target: body.targets[0],
          state: "absent",
          reason: "connector-unavailable",
        },
      ]);
      await api.requestSyncConnectorRuntimeAs(bearer, first.runId, body, [409]);
      await expect(api.readRun(actor, next.runId)).resolves.toMatchObject({
        status: "running",
      });
    });
  });
});
