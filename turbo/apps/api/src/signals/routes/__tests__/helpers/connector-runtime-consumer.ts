import { expect, onTestFinished } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createFirewallApi } from "./api-bdd-firewall";
import { createRunsApi } from "./api-bdd-runs";

type RunClaim = Awaited<
  ReturnType<ReturnType<typeof createRunsApi>["claimRunnerJob"]>
>;
type ConnectorRuntimeAuthBody = Omit<
  Parameters<ReturnType<typeof createFirewallApi>["requestFirewallAuth"]>[1],
  "encryptedSecrets" | "secretConnectorMap" | "secretConnectorMetadataMap"
>;

async function resolveClaimedAuth(
  claim: RunClaim,
  firewall: ReturnType<typeof createFirewallApi>,
  body: ConnectorRuntimeAuthBody,
) {
  if (!claim.encryptedSecrets) {
    throw new Error("Expected encrypted secrets from the real Runner claim");
  }
  const response = await firewall.requestFirewallAuth(
    { authorization: `Bearer ${claim.sandboxToken}` },
    {
      ...body,
      encryptedSecrets: claim.encryptedSecrets,
      secretConnectorMap: claim.secretConnectorMap ?? undefined,
      secretConnectorMetadataMap: claim.secretConnectorMetadataMap ?? undefined,
    },
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected the claimed connector credential to resolve");
  }
  return response.body;
}

/** Consume an already connected account through a real Thread and Runner. */
export async function withConnectorRuntime(
  context: TestContext,
  actor: ApiTestUser,
  connectorSlug: string,
  consume: (args: {
    readonly claim: RunClaim;
    readonly resolveAuth: (
      body: ConnectorRuntimeAuthBody,
    ) => ReturnType<typeof resolveClaimedAuth>;
  }) => Promise<void> | void,
): Promise<void> {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const firewall = createFirewallApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
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
  });
  const runId = run.runId;
  owned.runId = runId;
  await runs.heartbeatRunner(runnerGroup);
  await flushWaitUntilForTest();
  expect((await runs.pollRunner(runnerGroup)).body.job?.runId).toBe(runId);
  const claim = await runs.claimRunnerJob(runId);
  expect((await runs.readRun(actor, runId)).status).toBe("running");
  await consume({
    claim,
    resolveAuth: async (body) => {
      return await resolveClaimedAuth(claim, firewall, body);
    },
  });
  await cleanup();
}
