import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { dataRouterRequestContract } from "@okouai/api-contracts/contracts/data-router";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { webhooksAgentDataRequestRoutes } from "../../webhooks-agent-data-request";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** Register through the production MITM webhook and mock only the remote Router. */
export async function registerPublicDataUsage(
  context: TestContext,
  runId: string,
  sandboxToken: string,
  credits: number,
): Promise<void> {
  const endpoint = "https://data-router-billing.test/mcp";
  const requestId = randomUUID();
  mockEnv("OKOU_DATA_ROUTER_URL", endpoint);
  mockEnv("OKOU_DATA_TOKEN", "billing-fixture-data-token");
  await accept(
    setupApp({ context, routes: webhooksAgentDataRequestRoutes })(
      dataRouterRequestContract,
    ).register({
      headers: { authorization: `Bearer ${sandboxToken}` },
      body: { runId, requestId },
    }),
    [200],
  );
  server.use(
    http.post(endpoint, async ({ request }) => {
      await expect(request.json()).resolves.toMatchObject({
        method: "tools/call",
        params: {
          name: "billing_get",
          arguments: { requestIds: expect.arrayContaining([requestId]) },
        },
      });
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { records: [{ requestId, credits }] } },
      });
    }),
  );
}

/** Debit through a real Run completion, without inserting billing business rows. */
export async function chargePublicDataUsage(
  context: TestContext,
  actor: ApiTestUser,
  credits: number,
): Promise<void> {
  const memberships =
    context.mocks.clerk.organizations.getOrganizationMembershipList.getMockImplementation();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const agent = await bdd.createAgent(actor, {
    displayName: "Data billing fixture",
    visibility: "private",
  });
  const runnerGroup = runs.configureRunnerGroup();
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Consume data for billing verification",
    model: null,
  });
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  // Run setup authenticates its actor and installs a single-member directory.
  // Restore the caller's provider fixture before the debit refreshes membership.
  if (memberships) {
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      memberships,
    );
  }
  await registerPublicDataUsage(
    context,
    run.runId,
    claim.sandboxToken,
    credits,
  );
  await createWebhookCallbackApi(context).requestAgentComplete(
    { runId: run.runId, exitCode: 1, error: "Billing fixture finished" },
    { authorization: `Bearer ${claim.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
}
