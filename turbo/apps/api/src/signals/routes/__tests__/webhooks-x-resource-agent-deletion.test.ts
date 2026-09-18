import { randomUUID } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createUsagePricingFixture } from "../../../test-fixtures/system-config-seeds";
import { holdUsageEventCompactionLockFixture } from "../../../test-fixtures/usage-event-compaction";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const billing = createBillingMediaApi(context);
const callbacks = createWebhookCallbackApi(context);

describe("X resource accounting during Agent deletion", () => {
  it("waits for ledger maintenance before owning the Agent's Run", async () => {
    mockEnv("ENV", "development");
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    mockEnv(
      "X_RESOURCE_BILLING_START_DATE",
      nowDate().toISOString().slice(0, 10),
    );
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    // Operator pricing has no production mutation endpoint. Each logical
    // provider resolves to this fixture's privately owned pricing row.
    const pricing = await createUsagePricingFixture({
      configured: [
        {
          kind: "connector",
          provider: "x",
          category: "tweet.read",
          unitPrice: 1,
          unitSize: 1,
        },
      ],
    });
    onTestFinished(pricing.cleanup);
    const actor = bdd.user();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Delete an Agent during ledger maintenance",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Read a resource before deleting the Agent",
      modelProvider: "anthropic-api-key",
    });
    const idempotencyKey = randomUUID();
    const resourceId = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    ).toString();
    await callbacks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          {
            protocol: "x-resource-v1",
            idempotencyKey,
            kind: "connector",
            provider: "x",
            category: "tweet.read",
            quantity: 1,
            observedAt: nowDate().toISOString(),
            resources: [{ id: resourceId, occurrences: 1 }],
            remainder: [],
          },
        ],
      },
      { authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}` },
      [200],
    );
    await billing.processOrgUsageEvents(actor, pricing.resolution);
    expect((await billing.readUsageRecord(actor)).body.totalCredits).toBe(1);
    await runs.requestCancelRun(actor, run.runId, [200], pricing.resolution);
    await flushWaitUntilForTest();
    const settledCredits = (await runs.readBillingStatus(actor)).credits;

    // Infrastructure exception: HTTP cannot pause maintenance between its
    // owned ledger lock and the Run KEY SHARE required by a rollup's FK.
    // All affected business records were created through production APIs.
    const gate = await holdUsageEventCompactionLockFixture(context.signal, {
      idempotencyKey,
      runId: run.runId,
    });
    const completion = Promise.allSettled([gate.done]);
    const deletion = Promise.allSettled([
      gate.withAcquisitionAttemptTracking(async () => {
        return await bdd.requestDeleteAgent(actor, agent.agentId, [204, 409]);
      }),
    ]);
    onTestFinished(async () => {
      gate.release();
      await completion;
      await deletion;
      await flushWaitUntilForTest();
    });

    // Release at the admission boundary, within Agent deletion's bounded wait.
    // Without admission the endpoint itself returns 409 while holding the Run
    // ahead of the blocked ledger mutation; do not wait for a missing test hook.
    await Promise.race([gate.acquisitionAttempted, deletion]);
    gate.release();
    const [released] = await completion;
    if (released.status === "rejected") {
      throw released.reason;
    }
    const [deleted] = await deletion;
    if (deleted.status === "rejected") {
      throw deleted.reason;
    }
    expect(deleted.value.status).toBe(204);
    await bdd.requestReadAgent(actor, agent.agentId, [404]);
    await runs.requestReadRun(actor, run.runId, [404]);
    expect((await runs.readBillingStatus(actor)).credits).toBe(settledCredits);
  });
});
