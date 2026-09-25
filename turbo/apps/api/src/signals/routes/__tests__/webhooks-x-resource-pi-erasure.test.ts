import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { xResourceAdmissionDbFixture } from "../../../test-fixtures/db-fixture";
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

const context = testContext({
  connectorCatalog: true,
  dbFixtures: [xResourceAdmissionDbFixture],
});
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
  return { actor, run };
}

describe("X resource usage during Pi account erasure", () => {
  it("holds a terminal Pi Run while an admitted upload completes and fences new uploads", async () => {
    const { actor, run } = await completedPiRun();
    const at = nowDate().toISOString();
    const resourceId = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    ).toString();
    const event = {
      protocol: "x-resource-v1" as const,
      idempotencyKey: randomUUID(),
      kind: "connector" as const,
      provider: "x" as const,
      category: "posts.read" as const,
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
    const deletion = callbacks.requestClerkWebhook("{}", {}, [200]);
    // Start deletion while upload is admitted, then release its database lock
    // promptly; the user hold does not need to wait for Run deletion.
    gate.release();
    await deletion;
    const [released] = await completion;
    if (released.status === "rejected") {
      throw released.reason;
    }
    const [uploaded] = await upload;
    if (uploaded.status === "rejected") {
      throw uploaded.reason;
    }
    await flushWaitUntilForTest();
    await fixture.api.requestReadRun(actor, run.runId, [200]);
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
