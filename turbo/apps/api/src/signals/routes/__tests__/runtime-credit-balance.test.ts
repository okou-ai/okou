import { randomUUID } from "node:crypto";

import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { createBddApi } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createPublicFirewallFixture } from "./helpers/public-firewall-fixture";

const context = testContext();
const pi = createChatEventsFixture(context);

async function fundedFreeRuns() {
  const fixture = createPublicFirewallFixture(context);
  return await fixture.run(async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    pi.mockPiObjectStore();
    const runnerGroup = await runs.configureRunnerGroup();
    const { actor } = fixture;
    const granted = await fixture.fund(actor, 100_000);
    await webhooks.postStripeEvent(
      {
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: granted.subscriptionId, metadata: {} } },
      },
      [200],
    );
    await flushWaitUntilForTest();
    await expect(runs.readBillingStatus(actor)).resolves.toMatchObject({
      tier: "limited-free-1",
      status: "active",
      credits: 100_000,
    });

    async function startRunExecution(prompt: string) {
      const run = await runs.createThreadRun(actor, {
        model: null,
        prompt,
      });
      fixture.registerRun(run.runId);
      await runs.heartbeatRunner(runnerGroup);
      const execution = await runs.executionInput(run.runId);
      fixture.registerExecution(run.runId, execution.sandboxToken);
      return {
        run,
        execution,
        headers: { authorization: `Bearer ${execution.sandboxToken}` },
      };
    }

    const active = await startRunExecution("Keep using managed services");
    const peer = await startRunExecution(
      "Complete and settle shared credit usage",
    );
    const firewallBody = {
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
      },
      secretConnectorMap: active.execution.secretConnectorMap ?? undefined,
      secretConnectorMetadataMap:
        active.execution.secretConnectorMetadataMap ?? undefined,
      firewallBillable: true,
    };

    return {
      fixture,
      actor,
      active,
      firewallBody,
      async settleBalance(remainingCredits: number) {
        const before = await runs.readBillingStatus(actor);
        const member = await runs.readUsagePackCredits(actor);
        await webhooks.requestAgentUsageEvent(
          {
            runId: peer.run.runId,
            events: [
              {
                idempotencyKey: randomUUID(),
                kind: "model",
                provider: "@preset/okou-1-0",
                category: "tokens.input",
                // The fixed public Auto fixture costs one credit per 1,000
                // input tokens. Report usage through the real Runner protocol.
                quantity:
                  (before.credits + member.totalCredits - remainingCredits) *
                  1000,
              },
            ],
          },
          peer.headers,
          [200],
        );
        await webhooks.requestAgentComplete(
          { runId: peer.run.runId, exitCode: 1 },
          peer.headers,
          [200],
        );
        await flushWaitUntilForTest();
        await expect(runs.readBillingStatus(actor)).resolves.toMatchObject({
          status: "active",
          credits: remainingCredits,
        });
        await expect(
          runs.readRun(actor, active.run.runId),
        ).resolves.toMatchObject({
          status: "running",
        });
      },
    };
  });
}

describe("current credit balance during an active free Run", () => {
  it.each([0, -1])(
    "rejects further billable requests with %s credits remaining",
    async (remainingCredits) => {
      const scenario = await fundedFreeRuns();
      await scenario.fixture.run(async () => {
        const fw = createFirewallApi(context);
        const { active, firewallBody } = scenario;
        const before = Math.floor(now() / 1000);
        const funded = await fw.requestFirewallAuth(
          { authorization: `Bearer ${active.execution.firewallToken}` },
          firewallBody,
          [200],
        );
        if (funded.status !== 200) {
          throw new Error("Expected funded billable authorization");
        }
        expect(funded.body.expiresAt).toBeGreaterThanOrEqual(before + 25);
        expect(funded.body.expiresAt).toBeLessThanOrEqual(before + 35);

        const toolToken = active.execution.platformEnvironment.OKOU_TOKEN;
        if (!toolToken) {
          throw new Error("Expected the real managed Run's Okou token");
        }
        const toolHeaders = { authorization: `Bearer ${toolToken}` };
        await scenario.settleBalance(remainingCredits);
        const denied = await fw.requestFirewallAuth(
          { authorization: `Bearer ${active.execution.firewallToken}` },
          firewallBody,
          [402],
        );
        expect(denied.body).toMatchObject({
          error: { code: "INSUFFICIENT_CREDITS" },
        });
        const imageDenied = await accept(
          setupApp({ context, routes: imageIoGenerateRoutes })(
            imageIoGenerateContract,
          ).post({
            headers: toolHeaders,
            body: { prompt: "Generate an image after credit exhaustion" },
          }),
          [402],
        );
        expect(imageDenied.body.error.code).toBe("INSUFFICIENT_CREDITS");

        await fw.requestFirewallAuth(
          { authorization: `Bearer ${active.execution.firewallToken}` },
          { ...firewallBody, firewallBillable: false },
          [200],
        );
      });
    },
  );

  it("shortens renewed billable authorization when a free Run has low credits", async () => {
    const scenario = await fundedFreeRuns();
    await scenario.fixture.run(async () => {
      await scenario.settleBalance(500);
      const before = Math.floor(now() / 1000);
      const leased = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${scenario.active.execution.firewallToken}` },
        scenario.firewallBody,
        [200],
      );
      if (leased.status !== 200) {
        throw new Error("Expected low-balance authorization to succeed");
      }
      expect(leased.body.expiresAt).toBeGreaterThanOrEqual(before + 5);
      expect(leased.body.expiresAt).toBeLessThan(before + 10);
    });
  });
});
