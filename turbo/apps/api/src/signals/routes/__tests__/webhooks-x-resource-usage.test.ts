import { randomUUID } from "node:crypto";

import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

type UsageEvent = z.infer<
  (typeof webhookUsageEventContract.send)["body"]
>["events"][number];
type ResourceEvent = Extract<UsageEvent, { protocol: "x-resource-v1" }>;

interface RunFixture {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runId: string;
  readonly authorization: string;
}

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const DAY_MS = 86_400_000;

beforeEach(() => {
  mockEnv("ENV", "development");
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
});

async function createRun(actor = bdd.user()): Promise<RunFixture> {
  if (!actor.orgId) {
    throw new Error("X resource test requires an organization");
  }
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "X resource accounting",
    visibility: "private",
  });
  const runnerGroup = runs.configureRunnerGroup();
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Read X resources",
  });
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  return {
    actor,
    agentId: agent.agentId,
    runId: run.runId,
    authorization: `Bearer ${claim.sandboxToken}`,
  };
}

function resourceId(): string {
  // A test owns each global identity before making any shared-table writes.
  return BigInt(
    `0x${randomUUID().replaceAll("-", "").slice(0, 24)}`,
  ).toString();
}

function observation(
  ids: readonly string[],
  overrides: Partial<ResourceEvent> = {},
): ResourceEvent {
  return {
    protocol: "x-resource-v1",
    idempotencyKey: randomUUID(),
    kind: "connector",
    provider: "x",
    category: "posts.read",
    quantity: ids.length,
    observedAt: nowDate().toISOString(),
    resources: ids.map((id) => {
      return { id, occurrences: 1 };
    }),
    remainder: [],
    ...overrides,
  };
}

function submit(fixture: RunFixture, events: UsageEvent[]) {
  return setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookUsageEventContract).send({
    headers: { authorization: fixture.authorization },
    body: { runId: fixture.runId, events },
  });
}

describe("X daily resource usage webhook", () => {
  it("rejects a deleted run token while another run remains usable", async () => {
    const deleted = await createRun();
    const survivor = await createRun();
    const sharedId = resourceId();
    const freshId = resourceId();
    await accept(submit(deleted, [observation([sharedId])]), [200]);
    await runs.requestCancelRun(deleted.actor, deleted.runId, [200]);
    await flushWaitUntilForTest();
    await bdd.requestDeleteAgent(deleted.actor, deleted.agentId, [204]);
    await runs.requestReadRun(deleted.actor, deleted.runId, [404]);

    const rejected = await accept(
      submit(deleted, [observation([freshId])]),
      [404],
    );
    expect(rejected.status).toBe(404);
    await accept(submit(survivor, [observation([sharedId, freshId])]), [200]);
  });

  it("rolls back a whole mixed batch when a source UUID belongs to another organization", async () => {
    const first = await createRun();
    const second = await createRun();
    const original = observation([resourceId()]);
    const fresh = observation([resourceId()]);
    const countEvent: UsageEvent = {
      idempotencyKey: randomUUID(),
      kind: "connector",
      provider: "x",
      category: "posts.read",
      quantity: 5,
    };
    await accept(submit(first, [original]), [200]);
    const rejected = await accept(
      submit(second, [fresh, countEvent, original]),
      [409],
    );
    expect(rejected.status).toBe(409);
    // The failed request left its fresh source UUID available to this owner.
    await accept(submit(first, [fresh]), [200]);
    await accept(
      submit(second, [
        observation(
          fresh.resources.map(({ id }) => {
            return id;
          }),
        ),
      ]),
      [200],
    );
  });

  it.each(["user", "organization"] as const)(
    "rejects a source UUID when only its %s owner differs",
    async (scope) => {
      const first = await createRun();
      const second = await createRun(
        scope === "user"
          ? bdd.user({ orgId: first.actor.orgId })
          : bdd.user({ userId: first.actor.userId }),
      );
      const owned = observation([resourceId()]);
      const fresh = observation([resourceId()]);
      await accept(submit(first, [owned]), [200]);
      const rejected = await accept(submit(second, [owned, fresh]), [409]);
      expect(rejected.status).toBe(409);
      await accept(submit(first, [fresh]), [200]);
    },
  );

  it.each([undefined, "1"])(
    "enforces actual streamed bytes with content-length=%s",
    async (contentLength) => {
      const fixture = await createRun();
      const event = observation([resourceId()]);
      const json = JSON.stringify({ runId: fixture.runId, events: [event] });
      // JSON permits trailing whitespace, so rejection proves the transport
      // limit rather than a schema/JSON failure or a trusted length header.
      const bytes = new TextEncoder().encode(json.padEnd(256 * 1024 + 1, " "));
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes.subarray(offset, offset + 16 * 1024));
          offset += 16 * 1024;
          if (offset >= bytes.length) {
            controller.close();
          }
        },
      });
      const request: RequestInit & { readonly duplex: "half" } = {
        method: "POST",
        headers: {
          authorization: fixture.authorization,
          "content-type": "application/json",
          ...(contentLength === undefined
            ? {}
            : { "content-length": contentLength }),
        },
        body,
        duplex: "half",
      };
      const response = await setupRawAppRequest({
        context,
        routes: webhooksAgentHealthUsageTelemetryRoutes,
      })("/api/webhooks/agent/usage-event", request);
      expect(response.status).toBe(413);
      // Nothing was claimed by the rejected oversized request.
      await accept(submit(fixture, [event]), [200]);
    },
  );

  it.each([
    { name: "older than the two UTC dates", offset: -2 * DAY_MS },
    { name: "ahead of the database clock", offset: 6 * 60_000 },
    { name: "before this run existed", offset: -6 * 60_000 },
  ])(
    "rejects observations $name without claiming the identity",
    async ({ offset }) => {
      const fixture = await createRun();
      const event = observation([resourceId()]);
      const rejected = await accept(
        submit(fixture, [
          { ...event, observedAt: new Date(now() + offset).toISOString() },
        ]),
        [400],
      );
      expect(rejected.status).toBe(400);
      await accept(submit(fixture, [event]), [200]);
    },
  );
});
