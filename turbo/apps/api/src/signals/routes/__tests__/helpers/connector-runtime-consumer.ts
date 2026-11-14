import { expect, onTestFinished } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createFirewallApi } from "./api-bdd-firewall";
import { createRunsApi, type RunModel } from "./api-bdd-runs";

type RunnerExecutionInput = Awaited<
  ReturnType<ReturnType<typeof createRunsApi>["executionInput"]>
>;
type ConnectorRuntimeAuthBody = Omit<
  Parameters<ReturnType<typeof createFirewallApi>["requestFirewallAuth"]>[1],
  "encryptedSecrets" | "secretConnectorMap" | "secretConnectorMetadataMap"
>;

async function resolveExecutionAuth(
  execution: RunnerExecutionInput,
  firewall: ReturnType<typeof createFirewallApi>,
  body: ConnectorRuntimeAuthBody,
) {
  if (!execution.encryptedSecrets) {
    throw new Error(
      "Expected encrypted secrets from the real Runner execution",
    );
  }
  const response = await firewall.requestFirewallAuth(
    { authorization: `Bearer ${execution.sandboxToken}` },
    {
      ...body,
      encryptedSecrets: execution.encryptedSecrets,
      secretConnectorMap: execution.secretConnectorMap ?? undefined,
      secretConnectorMetadataMap:
        execution.secretConnectorMetadataMap ?? undefined,
    },
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected the execution connector credential to resolve");
  }
  return response.body;
}

/** Consume an already connected account through a real Thread and Runner. */
export async function withConnectorRuntime(
  context: TestContext,
  actor: ApiTestUser,
  connectorSlug: string,
  consume: (args: {
    readonly execution: RunnerExecutionInput;
    readonly resolveAuth: (
      body: ConnectorRuntimeAuthBody,
    ) => ReturnType<typeof resolveExecutionAuth>;
  }) => Promise<void> | void,
  options: { readonly model?: RunModel } = {},
): Promise<void> {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const firewall = createFirewallApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, options);
  const agent = await bdd.createAgent(actor, {
    displayName: "Connector credential consumer",
    visibility: "private",
  });
  const owned: { runId?: string } = {};
  let cleanupPromise: Promise<void> | undefined;
  async function cleanupOwnedResources(): Promise<void> {
    context.mocks.s3.send.mockResolvedValue({ Contents: [] });
    if (owned.runId) {
      await runs.requestCancelRun(actor, owned.runId, [200]);
      await flushWaitUntilForTest();
    }
    await bdd.deleteAgent(actor, agent.agentId);
  }
  function cleanup(): Promise<void> {
    cleanupPromise ??= cleanupOwnedResources();
    return cleanupPromise;
  }
  onTestFinished(cleanup);

  await expect(
    runs.enableAgentConnectors(actor, agent.agentId, [connectorSlug]),
  ).resolves.toContain(connectorSlug);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use the connected account",
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const runId = run.runId;
  owned.runId = runId;
  await runs.heartbeatRunner(runnerGroup);
  await flushWaitUntilForTest();
  const execution = await runs.executionInput(runId);
  expect((await runs.readRun(actor, runId)).status).toBe("running");
  await consume({
    execution,
    resolveAuth: async (body) => {
      return await resolveExecutionAuth(execution, firewall, body);
    },
  });
  await cleanup();
}
