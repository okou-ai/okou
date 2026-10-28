import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import { dataRouterRequestContract } from "@okouai/api-contracts/contracts/data-router";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { chatInputStatusRoutes } from "../../chat-input-status";
import { webhooksAgentDataRequestRoutes } from "../../webhooks-agent-data-request";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createRouteMocks } from "./route-test";

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
  await bdd.completeOnboarding(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Data billing fixture",
    visibility: "private",
  });
  const runnerGroup = runs.configureRunnerGroup();
  const clientEventId = randomUUID();
  const sent = await createChatFilesBddApi(context).requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "Consume data for billing verification",
      model: null,
      clientEventId,
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the billing Thread input to be accepted");
  }
  await flushWaitUntilForTest();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  // Only the consuming Run ID is needed; observe this exact public input
  // without materializing its history or reading unused Run details.
  const observed = await accept(
    setupApp({ context, routes: chatInputStatusRoutes })(
      chatInputStatusContract,
    ).get({
      headers: { authorization: "Bearer clerk-session" },
      params: { threadId: sent.body.threadId, eventId: clientEventId },
    }),
    [200],
  );
  expect(observed.body).toMatchObject({
    threadId: sent.body.threadId,
    eventId: clientEventId,
    status: "consumed",
  });
  if (observed.body.status !== "consumed") {
    throw new Error("Expected the billing Thread input to launch a Run");
  }
  const runId = observed.body.runId;
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(runId);
  // Run setup authenticates its actor and installs a single-member directory.
  // Restore the caller's provider fixture before the debit refreshes membership.
  if (memberships) {
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      memberships,
    );
  }
  await registerPublicDataUsage(context, runId, claim.sandboxToken, credits);
  await createWebhookCallbackApi(context).requestAgentComplete(
    { runId, exitCode: 1, error: "Billing fixture finished" },
    { authorization: `Bearer ${claim.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
}
