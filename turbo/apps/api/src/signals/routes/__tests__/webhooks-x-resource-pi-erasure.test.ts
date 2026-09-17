import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { holdXResourceClaimForTest } from "../../../test-fixtures/x-resource-admission";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
  createPiApiFirstTurnUsagePricingResolution,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { piResponsesTextSse } from "./helpers/pi-responses";
import { readRunLaunchSnapshotFixture } from "./helpers/runtime-state";

const context = testContext();
const fixture = createChatEventsFixture(context);

async function completedPiRun() {
  configureNativeCliArtifact();
  const { actor, agentId } = await fixture.entitledChatActor();
  const model = "gpt-5.6-terra";
  const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
  const withOpenRouterRoute = await fixture.configureBuiltInPiModelOnOpenRouter(
    actor,
    model,
  );
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: requireOrgId(actor) },
    {
      [FeatureSwitchKey.PiLoop]: true,
      [FeatureSwitchKey.PiDeferredSandbox]: true,
      [FeatureSwitchKey.OpenRouterUsRouting]: false,
    },
  );
  fixture.mockPiResourceArchiveDownloads();
  fixture.mockPiCheckpointObjectStore();
  server.use(
    http.post("https://openrouter.ai/api/v1/responses", () => {
      return new HttpResponse(
        piResponsesTextSse("Finished before deletion", 1),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }),
  );
  const run = await withOpenRouterRoute(async () => {
    return await fixture.sendChatRun(
      actor,
      { agentId, prompt: "Finish the Pi turn", model },
      pricing,
    );
  });
  await fixture.waitForRunStatus(actor, run.runId, "completed", 10_000);
  await flushWaitUntilForTest();
  // The snapshot is writer-only; this bounded read proves the API-created Run
  // exercises the durable Pi preflight rather than the legacy Pi lifecycle.
  await expect(
    readRunLaunchSnapshotFixture(context, run.runId),
  ).resolves.toMatchObject({
    exists: true,
    launch_snapshot: {
      schemaVersion: 4,
      executionMode: "api-inference",
    },
  });
  return { actor, run };
}

describe("X resource usage during Pi account erasure", () => {
  it("drains an admitted terminal Pi upload before the Clerk erasure preflight", async () => {
    const { actor, run } = await completedPiRun();
    const at = nowDate().toISOString();
    mockEnv("X_RESOURCE_BILLING_START_DATE", at.slice(0, 10));
    const resourceId = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    ).toString();
    const event = {
      protocol: "x-resource-v1" as const,
      idempotencyKey: randomUUID(),
      kind: "connector" as const,
      provider: "x" as const,
      category: "tweet.read" as const,
      quantity: 1,
      observedAt: at,
      resources: [{ id: resourceId, occurrences: 1 }],
      remainder: [],
    };
    const headers = {
      authorization: `Bearer ${fixture.api.sandboxTokenForRun(actor, run.runId)}`,
    };
    const callbacks = fixture.webhooks;
    callbacks.configureClerkWebhookSecret();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [{ publicUserData: { userId: `survivor-${randomUUID()}` } }] },
    );

    // Infrastructure exception: the upload is real, but an HTTP caller cannot
    // hold its own resource INSERT uncommitted across Clerk's Run preflight.
    const gate = await holdXResourceClaimForTest(
      { utcDay: at.slice(0, 10), resourceType: "post", resourceId },
      context.signal,
    );
    const completion = Promise.allSettled([gate.done]);
    const upload = Promise.allSettled([
      callbacks.requestAgentUsageEvent(
        { runId: run.runId, events: [event] },
        headers,
        [200],
      ),
    ]);
    onTestFinished(async () => {
      gate.release();
      await completion;
      await upload;
      await flushWaitUntilForTest();
    });
    await expect.poll(gate.blockedWaiterCount).toBe(1);
    callbacks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: actor.userId },
    });
    await callbacks.requestClerkWebhook("{}", {}, [200]);
    await expect.poll(gate.blockedRunDeletionCount).toBe(1);
    gate.release();
    const [released] = await completion;
    if (released.status === "rejected") {
      throw released.reason;
    }
    const [uploaded] = await upload;
    if (uploaded.status === "rejected") {
      throw uploaded.reason;
    }
    await flushWaitUntilForTest();
    await fixture.api.requestReadRun(actor, run.runId, [404]);
    await callbacks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [{ ...event, idempotencyKey: randomUUID() }],
      },
      headers,
      [404],
    );
  });
});
