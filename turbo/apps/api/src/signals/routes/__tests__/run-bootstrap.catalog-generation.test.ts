import { connectX } from "./helpers/connector-auth-provider-fixtures";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();

async function connectorActor() {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const actor = bdd.user();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = await api.configureRunnerGroup();

  const providerIds: string[] = [];
  const waitingThreads = new Set<string>();
  const owner = publicRunOwner(context, actor, {
    beforeRuns: async () => {
      for (const threadId of waitingThreads) {
        await createChatFilesBddApi(context).deleteThread(actor, threadId);
      }
      if (waitingThreads.size > 0) {
        await flushWaitUntilForTest();
      }
    },
    afterRuns: async () => {
      await connectors.deleteFeatureSwitches(actor);

      for (const id of providerIds) {
        await createAuthDeviceSupportApi(
          context,
        ).deletePersonalModelProviderAccount(actor, id);
      }
      for (const slug of ["openai", "runtime", "x"] as const) {
        for (const account of await connectors.listBuiltinConnectorAccounts(
          actor,
          slug,
        )) {
          await connectors.deleteBuiltinConnectorAccount(
            actor,
            slug,
            account.id,
          );
        }
      }
    },
  });
  return await owner.run(async () => {
    await publicPlanLifecycle(context, actor).update("active");
    await bdd.completeOnboarding(actor);

    const provider = await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    providerIds.push(provider.providerId);
    const agent = await bdd.createAgent(actor, {
      displayName: "Connector selection",
      visibility: "private",
    });

    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    await connectX(connectors, actor);
    return {
      actor,
      agentId: agent.agentId,
      api,
      connectors,
      async send(prompt: string, threadId?: string) {
        return await api.createThreadRun(actor, {
          agentId: agent.agentId,
          prompt,
          threadId,
          model: "claude-fable-5-1",
        });
      },
      async executionInput(runId: string) {
        await api.heartbeatRunner(runnerGroup);
        return await owner.executionInput(runId);
      },
      async queue(prompt: string) {
        const queued = await createChatEventsFixture(context).queueChatRun(
          actor,
          { prompt, model: "claude-fable-5-1" },
          (blocker) => {
            owner.rememberExecution(blocker.runId, blocker.sandboxToken);
            waitingThreads.add(blocker.threadId);
          },
        );
        return {
          async launch() {
            const run = await queued.launch();
            await owner.executionInput(run.runId);
            waitingThreads.delete(queued.blocker.threadId);
            return run;
          },
        };
      },
      async cancel(runId: string, token: string) {
        await api.requestCancelRun(actor, runId, [200]);
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${token}` },
          [200],
        );
        await flushWaitUntilForTest();
      },
    };
  });
}

describe("Run connector selection through normal user changes", () => {
  it("omits a connected but unselected connector from a real Runner execution", async () => {
    const fixture = await connectorActor();
    const { actor, connectors } = fixture;
    const account = await connectors.readDefaultBuiltinAccount(actor, "x");
    await createChatConnectorAccessApi(context).setDefault(
      actor,
      {
        target: { kind: "builtin", connectorSlug: "x" },
        connectionId: account.id,
      },
      false,
    );
    const run = await fixture.send("omit an unselected connector");
    const execution = await fixture.executionInput(run.runId);
    expect(execution.environment ?? {}).not.toHaveProperty("X_TOKEN");
    expect(execution.secretConnectorMap ?? {}).not.toHaveProperty("X_TOKEN");
    expect(
      execution.firewalls?.some((entry) => {
        return entry.kind === "builtin" && entry.name === "x";
      }),
    ).toBeFalsy();
    expect(execution.billableFirewalls).not.toContain("x");
    expect(execution.networkPolicies ?? {}).not.toHaveProperty("x");
    await fixture.cancel(run.runId, execution.sandboxToken);
  });

  it("uses current native connector selections during preparation and keeps the delivered Run configuration", async () => {
    const fixture = await connectorActor();
    const { actor, connectors } = fixture;
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: `bootstrap-owned-${randomUUID()}` },
    );
    const runtime = await connectors.connectManualGrant(
      actor,
      "runtime",
      "api-token",
      { apiKey: `runtime-owned-${randomUUID()}` },
    );
    const access = createChatConnectorAccessApi(context);
    const selection = {
      target: { kind: "builtin", connectorSlug: "openai" },
      connectionId: connection.id,
    } as const;
    const runtimeSelection = {
      target: { kind: "builtin", connectorSlug: "runtime" },
      connectionId: runtime.id,
    } as const;
    const x = await connectors.readDefaultBuiltinAccount(actor, "x");
    await access.setDefault(
      actor,
      {
        target: { kind: "builtin", connectorSlug: "x" },
        connectionId: x.id,
      },
      false,
    );
    await access.setDefault(actor, runtimeSelection, false);
    const queued = await fixture.queue("use the prepared connector selection");
    await access.setDefault(actor, selection, false);
    await access.setDefault(actor, runtimeSelection, true);
    const prepared = await queued.launch();
    const execution = await fixture.executionInput(prepared.runId);
    expect(execution.secretConnectorMetadataMap?.RUNTIME_API_KEY).toMatchObject(
      {
        sourceId: runtime.id,
      },
    );
    expect(execution.environment ?? {}).not.toHaveProperty("OPENAI_TOKEN");
    expect(execution.secretConnectorMap ?? {}).not.toHaveProperty(
      "OPENAI_TOKEN",
    );
    await access.setDefault(actor, selection, true);
    await access.setDefault(actor, runtimeSelection, false);
    expect(execution.environment).toHaveProperty("RUNTIME_API_KEY");
    await fixture.cancel(prepared.runId, execution.sandboxToken);
    const next = await fixture.send(
      "use the new connector selection",
      prepared.threadId,
    );
    const nextExecution = await fixture.executionInput(next.runId);
    expect(
      nextExecution.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({
      sourceId: connection.id,
    });
    expect(nextExecution.environment).not.toHaveProperty("RUNTIME_API_KEY");
    await fixture.cancel(next.runId, nextExecution.sandboxToken);
  });
});
