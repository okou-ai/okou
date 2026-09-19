import { randomUUID } from "node:crypto";

import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import type { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  createUsagePricingFixture,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { holdUsageEventCompactionLockFixture } from "../../../test-fixtures/usage-event-compaction";
import { holdUsageSettlementCreditWriteForTest } from "../../../test-fixtures/usage-settlement-lock";
import {
  holdXResourceClaimForTest,
  withXResourceClock,
} from "../../../test-fixtures/x-resource-admission";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedBuiltInDefaultModelKey } from "./helpers/runtime-state";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";

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
const billing = createBillingMediaApi(context);
const DAY_MS = 86_400_000;

beforeEach(() => {
  mockEnv("ENV", "development");
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
});

async function createRun(
  actor = bdd.user(),
  deduplicationEnabled = true,
  modelProvider: "anthropic-api-key" | "built-in" = "anthropic-api-key",
): Promise<RunFixture> {
  if (!actor.orgId) {
    throw new Error("X resource test requires an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.XResourceDeduplication]: deduplicationEnabled,
    },
  );
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "X resource accounting",
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Read X resources",
    modelProvider,
  });
  return {
    actor,
    agentId: agent.agentId,
    runId: run.runId,
    authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
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

async function pricing(): Promise<UsagePricingFixture> {
  // Operator pricing has no production mutation API. This fixture maps the
  // canonical provider to private lookup rows; it never changes shared X prices.
  const fixture = await createUsagePricingFixture({
    configured: [
      ...["posts.read", "user.read"].map((category) => {
        return {
          kind: "connector",
          provider: "x",
          category,
          unitPrice: 1,
          unitSize: 1,
        };
      }),
      {
        kind: "model",
        provider: "x-resource-test-model",
        category: "tokens.input",
        unitPrice: 1,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "x-resource-test-image",
        category: "output_tokens",
        unitPrice: 1,
        unitSize: 1,
      },
    ],
  });
  onTestFinished(fixture.cleanup);
  return fixture;
}

async function chargedUnits(
  fixture: RunFixture,
  configuredPricing: UsagePricingFixture,
): Promise<number> {
  await billing.processOrgUsageEvents(
    fixture.actor,
    configuredPricing.resolution,
  );
  // One credit per unit makes the public usage response expose the net charge.
  const response = await billing.readUsageRecord(fixture.actor);
  return response.body.totalCredits;
}

describe("X daily resource usage webhook", () => {
  it.each([false, true])(
    "discards zero quantities for every usage kind (mixed=%s)",
    async (mixed) => {
      const configuredPricing = await pricing();
      // Built-in credentials are operator configuration with no product write
      // endpoint. The fixture owns its key and scopes selection to this test.
      await seedBuiltInDefaultModelKey(context);
      const fixture = await createRun(bdd.user(), false, "built-in");
      const zeroEvents = (
        [
          { kind: "connector", provider: "x", category: "posts.read" },
          {
            kind: "model",
            provider: "x-resource-test-model",
            category: "tokens.input",
          },
          {
            kind: "image",
            provider: "x-resource-test-image",
            category: "output_tokens",
          },
        ] satisfies Pick<UsageEvent, "kind" | "provider" | "category">[]
      ).map((event) => {
        return { ...event, idempotencyKey: randomUUID(), quantity: 0 };
      });
      const events = mixed ? [...zeroEvents, observation([])] : zeroEvents;
      await accept(submit(fixture, events), [200]);
      await accept(submit(fixture, events), [200]);
      await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(0);
      expect(
        (await billing.readUsageRecord(fixture.actor)).body.rows,
      ).toStrictEqual([]);

      // Empty events reserve no source identity for any usage kind. Later
      // positive observations with those UUIDs are accepted exactly once.
      const positive = zeroEvents.map((event) => {
        return { ...event, quantity: 2 };
      });
      const positiveBatch = mixed ? [...positive, observation([])] : positive;
      await accept(submit(fixture, positiveBatch), [200]);
      await accept(submit(fixture, positiveBatch), [200]);
      await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(6);
    },
  );

  it("shares an allowance-funded first read with another organization", async () => {
    const configuredPricing = await pricing();
    const first = await createRun();
    const second = await createRun();
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId: first.actor.orgId!,
      userId: first.actor.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: `sub_x_resources_${randomUUID()}`,
      effectiveAt: new Date(now() - 60_000),
      expiresAt: new Date(now() + DAY_MS),
      shortWindowSeconds: 3600,
      shortWindowUnits: 10,
      weeklyWindowSeconds: 7 * 86_400,
      weeklyWindowUnits: 10,
    });
    const initialCredits = (await runs.readBillingStatus(first.actor)).credits;
    const id = resourceId();

    await accept(submit(first, [observation([id])]), [200]);
    await expect(chargedUnits(first, configuredPricing)).resolves.toBe(1);
    const fundedStatus = await runs.readBillingStatus(first.actor);
    expect(fundedStatus.credits).toBe(initialCredits);
    expect(fundedStatus.usageAllowance?.windows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "short", consumedUnits: 1 }),
        expect.objectContaining({ kind: "weekly", consumedUnits: 1 }),
      ]),
    );
    await accept(submit(second, [observation([id])]), [200]);
    await expect(chargedUnits(second, configuredPricing)).resolves.toBe(0);
    expect(
      (await billing.readUsageRecord(second.actor)).body.rows,
    ).toStrictEqual([]);
  });

  it("charges distinct identities and remainder across organizations and namespaces", async () => {
    const configuredPricing = await pricing();
    const first = await createRun();
    const second = await createRun();
    const firstId = resourceId();
    const secondId = resourceId();
    const thirdId = resourceId();
    const event = observation([], {
      quantity: 9,
      resources: [
        { id: firstId, occurrences: 3 },
        { id: secondId, occurrences: 2 },
      ],
      remainder: [{ reason: "missing_id", quantity: 4 }],
    });

    await accept(submit(first, [event]), [200]);
    await accept(submit(first, [event]), [200]);
    await accept(submit(second, [observation([firstId, thirdId])]), [200]);
    await accept(
      submit(second, [observation([firstId], { category: "user.read" })]),
      [200],
    );

    await expect(chargedUnits(first, configuredPricing)).resolves.toBe(6);
    await expect(chargedUnits(second, configuredPricing)).resolves.toBe(2);
  });

  it("keeps exact decimal string identities, including leading zeroes", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun();
    const id = resourceId();
    await accept(submit(fixture, [observation([id, `0${id}`])]), [200]);
    await accept(submit(fixture, [observation([id, `0${id}`])]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(2);
  });

  it("charges the same resource again on the next UTC date but not yesterday's retry", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun();
    const event = observation([resourceId()]);
    const tomorrow = new Date(now() + DAY_MS);
    await accept(submit(fixture, [event]), [200]);
    // Infrastructure exception: callers cannot advance PostgreSQL's clock.
    // The fixture scopes the clock to this API operation; auth/settlement and
    // every database write still run through their normal endpoints.
    await withXResourceClock(
      () => {
        return tomorrow;
      },
      async () => {
        await accept(submit(fixture, [event]), [200]);
        await accept(
          submit(fixture, [
            {
              ...event,
              idempotencyKey: randomUUID(),
              observedAt: tomorrow.toISOString(),
            },
          ]),
          [200],
        );
      },
    );
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(2);
  });

  it("accepts yesterday's first delivery and rejects its retry once that date expires", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun();
    const event = observation([resourceId()]);
    const tomorrow = new Date(now() + DAY_MS);
    // Infrastructure exception: advance only this request's database clock to
    // exercise retained-date admission without waiting two real calendar days.
    await withXResourceClock(
      () => {
        return tomorrow;
      },
      async () => {
        await accept(submit(fixture, [event]), [200]);
        await accept(submit(fixture, [event]), [200]);
      },
    );
    await withXResourceClock(
      () => {
        return new Date(tomorrow.getTime() + DAY_MS);
      },
      async () => {
        await accept(submit(fixture, [event]), [400]);
      },
    );
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(1);
  });

  it("does not claim newly supplied resources when an owned source UUID is retried", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun();
    const original = observation([resourceId()]);
    const additionalId = resourceId();
    await accept(submit(fixture, [original]), [200]);
    // The source UUID is the retry authority; there is no separate request
    // digest. Changed content cannot add claims or change its existing charge.
    await accept(
      submit(fixture, [
        observation([additionalId], {
          idempotencyKey: original.idempotencyKey,
          quantity: 3,
          remainder: [{ reason: "missing_id", quantity: 2 }],
        }),
      ]),
      [200],
    );
    await accept(submit(fixture, [observation([additionalId])]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(2);
  });

  it("discards zero usage while charging unknown-only retries once", async () => {
    const configuredPricing = await pricing();
    const first = await createRun();
    const second = await createRun();
    const id = resourceId();
    const zero = observation([]);
    const unknown = observation([], {
      quantity: 3,
      remainder: [{ reason: "parse_fallback", quantity: 3 }],
    });
    await accept(submit(first, [observation([id])]), [200]);
    const duplicate = observation([id]);
    await accept(submit(second, [duplicate, zero]), [200]);
    await Promise.all([
      accept(submit(second, [duplicate, zero]), [200]),
      accept(submit(second, [duplicate, zero]), [200]),
    ]);
    await expect(chargedUnits(second, configuredPricing)).resolves.toBe(0);
    expect(
      (await billing.readUsageRecord(second.actor)).body.rows,
    ).toStrictEqual([]);
    await accept(submit(first, [zero, duplicate]), [200]);

    await accept(submit(second, [unknown]), [200]);
    await accept(submit(second, [unknown]), [200]);
    await accept(submit(first, [unknown]), [409]);

    await expect(chargedUnits(first, configuredPricing)).resolves.toBe(1);
    await expect(chargedUnits(second, configuredPricing)).resolves.toBe(3);
  });

  it("settles concurrent batches with inverse event and resource order once globally", async () => {
    const configuredPricing = await pricing();
    const first = await createRun();
    const second = await createRun();
    const ids = Array.from({ length: 4 }, resourceId);
    const firstEvents = [
      observation(ids.slice(0, 2)),
      observation(ids.slice(2)),
    ];
    const secondEvents = [
      observation(ids.slice(2).reverse()),
      observation(ids.slice(0, 2).reverse()),
    ];

    await Promise.all([
      accept(submit(first, firstEvents), [200]),
      accept(submit(second, secondEvents), [200]),
    ]);
    // Retry both complete batches after the winner is committed.
    await accept(submit(first, firstEvents), [200]);
    await accept(submit(second, secondEvents), [200]);
    const firstCharge = await chargedUnits(first, configuredPricing);
    const secondCharge = await chargedUnits(second, configuredPricing);
    expect(firstCharge + secondCharge).toBe(4);
  });

  it("rolls back a whole mixed batch when a source UUID belongs to another organization", async () => {
    const configuredPricing = await pricing();
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
    await accept(submit(second, [fresh, countEvent, original]), [409]);
    await expect(chargedUnits(second, configuredPricing)).resolves.toBe(0);
    // The failed request claimed neither its fresh source UUID nor its resource.
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

    await expect(chargedUnits(first, configuredPricing)).resolves.toBe(2);
    await expect(chargedUnits(second, configuredPricing)).resolves.toBe(0);
  });

  it("waits for ongoing credit settlement before deleting a user's ledger and runs", async () => {
    const configuredPricing = await pricing();
    const deleted = await createRun();
    await runs.requestCancelRun(
      deleted.actor,
      deleted.runId,
      [200],
      configuredPricing.resolution,
    );
    await flushWaitUntilForTest();
    await accept(submit(deleted, [observation([resourceId()])]), [200]);
    const orgId = deleted.actor.orgId;
    if (!orgId) {
      throw new Error("Settlement fixture requires an organization");
    }

    const callbacks = createWebhookCallbackApi(context);
    callbacks.configureClerkWebhookSecret();
    context.mocks.s3.send.mockResolvedValue({});
    // Keep another member so this user deletion does not also delete the org.
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [{ publicUserData: { userId: `survivor-${randomUUID()}` } }] },
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    // Infrastructure exception: pause the real credit deduction after it has
    // updated this source row, without creating synthetic processed usage.
    const gate = await holdUsageSettlementCreditWriteForTest(
      orgId,
      context.signal,
    );
    const completion = Promise.allSettled([gate.done]);
    const settlement = Promise.allSettled([
      billing.processOrgUsageEvents(
        deleted.actor,
        configuredPricing.resolution,
      ),
    ]);
    onTestFinished(async () => {
      gate.release();
      await completion;
      await settlement;
      await flushWaitUntilForTest();
    });
    await expect.poll(gate.settlementWaiterCount).toBe(1);

    callbacks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: deleted.actor.userId },
    });
    await callbacks.requestClerkWebhook("{}", {}, [200]);
    // Cleanup can queue multiple database participants behind the same
    // settlement. Their exact count is an implementation detail; the contract
    // here is that cleanup reached the verified blocking chain before release.
    await expect.poll(gate.cleanupWaiterCount).toBeGreaterThanOrEqual(1);
    gate.release();
    const [released] = await completion;
    if (released.status === "rejected") {
      throw released.reason;
    }
    const [settled] = await settlement;
    if (settled.status === "rejected") {
      throw settled.reason;
    }
    await flushWaitUntilForTest();

    await runs.requestReadRun(deleted.actor, deleted.runId, [404]);
    await accept(submit(deleted, [observation([resourceId()])]), [404]);
    expect(
      (await billing.readUsageRecord(deleted.actor)).body.totalCredits,
    ).toBe(0);
  });

  it.each(["user", "organization"] as const)(
    "rejects a source UUID when only its %s owner differs",
    async (scope) => {
      const configuredPricing = await pricing();
      const first = await createRun();
      const second = await createRun(
        scope === "user"
          ? bdd.user({ orgId: first.actor.orgId })
          : bdd.user({ userId: first.actor.userId }),
      );
      const owned = observation([resourceId()]);
      const fresh = observation([resourceId()]);
      await accept(submit(first, [owned]), [200]);
      await accept(submit(second, [owned, fresh]), [409]);
      await accept(submit(first, [fresh]), [200]);
      await expect(chargedUnits(first, configuredPricing)).resolves.toBe(2);
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
      const configuredPricing = await pricing();
      const fixture = await createRun();
      const event = observation([resourceId()]);
      await accept(
        submit(fixture, [
          { ...event, observedAt: new Date(now() + offset).toISOString() },
        ]),
        [400],
      );
      await accept(submit(fixture, [event]), [200]);
      await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(1);
    },
  );

  it("rejects observations after run completion even inside the database time window", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun();
    const event = observation([resourceId()]);
    await runs.requestCancelRun(
      fixture.actor,
      fixture.runId,
      [200],
      configuredPricing.resolution,
    );
    // Cancellation owns asynchronous settlement. Complete it with this test's
    // pricing before submitting the intentionally late observation.
    await flushWaitUntilForTest();
    const tooLate = new Date(now() + 6 * 60_000);
    // Infrastructure exception: advance this request's database clock so only
    // the completed-run bound, rather than the future-clock bound, rejects it.
    await withXResourceClock(
      () => {
        return tooLate;
      },
      async () => {
        await accept(
          submit(fixture, [{ ...event, observedAt: tooLate.toISOString() }]),
          [400],
        );
      },
    );
    await accept(submit(fixture, [event]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(1);
  });

  it("rolls back sources and claims when a resource lock wait expires the observation", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun();
    const event = observation([resourceId()]);
    const originalTime = new Date(event.observedAt);
    // Infrastructure exception: HTTP cannot hold an uncommitted unique-key
    // insert or advance PostgreSQL's clock while another insert waits for it.
    const gate = await holdXResourceClaimForTest(
      {
        utcDay: event.observedAt.slice(0, 10),
        resourceType: "post",
        resourceId: event.resources[0]!.id,
      },
      context.signal,
    );
    onTestFinished(async () => {
      gate.release();
      await gate.done;
    });
    let clock = originalTime;
    const pending = Promise.allSettled([
      withXResourceClock(
        () => {
          return clock;
        },
        async () => {
          return await submit(fixture, [event]);
        },
      ),
    ]);
    const waiting = await settleIncludingAbort(
      expect.poll(gate.blockedWaiterCount).toBe(1),
    );
    clock = new Date(originalTime.getTime() + 2 * DAY_MS);
    gate.release();
    await gate.done;
    const [completed] = await pending;
    if (!waiting.ok) {
      throw waiting.error;
    }
    if (completed.status === "rejected") {
      throw completed.reason;
    }
    expect(completed.value.status).toBe(400);
    // The original UUID and resource must both be reusable after rollback.
    await accept(submit(fixture, [event]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(1);
  });

  it("records resources with deduplication off and charges full quantities in mixed batches", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun(bdd.user(), false);
    const id = resourceId();
    const resource = observation([], {
      quantity: 5,
      resources: [{ id, occurrences: 3 }],
      remainder: [{ reason: "missing_id", quantity: 2 }],
    });
    const countEvent: UsageEvent = {
      idempotencyKey: randomUUID(),
      kind: "connector",
      provider: "x",
      category: "posts.read",
      quantity: 1,
    };
    await accept(submit(fixture, [countEvent, resource]), [200]);
    await accept(submit(fixture, [resource]), [200]);
    await accept(submit(fixture, [observation([id])]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(7);

    // An enabled owner sees the global history recorded by a disabled owner.
    const enabled = await createRun();
    await accept(submit(enabled, [observation([id])]), [200]);
    await expect(chargedUnits(enabled, configuredPricing)).resolves.toBe(0);
  });

  it("re-evaluates discarded zero usage after switch changes and preserves charged retries", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun(bdd.user(), false);
    if (!fixture.actor.orgId) {
      throw new Error("X resource test requires an organization");
    }
    const actor = { ...fixture.actor, orgId: fixture.actor.orgId };
    const id = resourceId();
    const whileOff = observation([], {
      quantity: 4,
      resources: [{ id, occurrences: 3 }],
      remainder: [{ reason: "missing_id", quantity: 1 }],
    });
    await accept(submit(fixture, [whileOff]), [200]);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.XResourceDeduplication]: true,
    });
    const whileOn = observation([id]);
    await accept(submit(fixture, [whileOff, whileOn]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(4);

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.XResourceDeduplication]: false,
    });
    const disabledAgain = observation([], {
      quantity: 3,
      resources: [{ id, occurrences: 2 }],
      remainder: [{ reason: "missing_id", quantity: 1 }],
    });
    await accept(submit(fixture, [whileOff, whileOn, disabledAgain]), [200]);
    await accept(submit(fixture, [whileOff, whileOn, disabledAgain]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(8);
  });

  it("keeps time admission and atomic validation while deduplication is off", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun(bdd.user(), false);
    const id = resourceId();
    const event = observation([id]);
    await accept(
      submit(fixture, [
        event,
        observation([resourceId()], {
          observedAt: new Date(now() - 2 * DAY_MS).toISOString(),
        }),
      ]),
      [400],
    );
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(0);
    const enabled = await createRun();
    await accept(submit(enabled, [observation([id])]), [200]);
    await expect(chargedUnits(enabled, configuredPricing)).resolves.toBe(1);
    await accept(submit(fixture, [event]), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(1);
  });

  it("accepts mixed batches while preserving user-owned model filtering", async () => {
    const configuredPricing = await pricing();
    const fixture = await createRun();
    const events: UsageEvent[] = [
      observation([resourceId(), resourceId()]),
      {
        idempotencyKey: randomUUID(),
        kind: "connector",
        provider: "x",
        category: "posts.read",
        quantity: 3,
      },
      {
        idempotencyKey: randomUUID(),
        kind: "model",
        provider: "x-resource-test-model",
        category: "tokens.input",
        quantity: 9,
      },
    ];
    await accept(submit(fixture, events), [200]);
    await accept(submit(fixture, events), [200]);
    await expect(chargedUnits(fixture, configuredPricing)).resolves.toBe(5);
  });

  it("retains shared resources after run deletion and rejects the deleted run token", async () => {
    const configuredPricing = await pricing();
    const deleted = await createRun();
    const survivor = await createRun();
    const sharedId = resourceId();
    const freshId = resourceId();
    await accept(submit(deleted, [observation([sharedId])]), [200]);
    await expect(chargedUnits(deleted, configuredPricing)).resolves.toBe(1);
    await runs.requestCancelRun(
      deleted.actor,
      deleted.runId,
      [200],
      configuredPricing.resolution,
    );
    await flushWaitUntilForTest();
    await bdd.requestDeleteAgent(deleted.actor, deleted.agentId, [204]);
    await runs.requestReadRun(deleted.actor, deleted.runId, [404]);

    await accept(submit(deleted, [observation([freshId])]), [404]);
    await accept(submit(survivor, [observation([sharedId, freshId])]), [200]);
    await expect(chargedUnits(survivor, configuredPricing)).resolves.toBe(1);
  });

  it("retains shared resource claims and billing after deleting their chat thread", async () => {
    const configuredPricing = await pricing();
    const owner = await createRun();
    const survivor = await createRun();
    const chat = createChatFilesBddApi(context);
    const callbacks = createChatCallbacksApi(context);
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    const thread = await chat.createThread(owner.actor, {
      agentId: owner.agentId,
      title: "X resource thread",
    });
    const sent = await chat.requestSendEvent(
      owner.actor,
      {
        agentId: owner.agentId,
        threadId: thread.id,
        prompt: "Read an X resource",
      },
      [201],
    );
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected a run for the chat thread");
    }
    const threaded = {
      ...owner,
      runId: sent.body.runId,
      authorization: `Bearer ${runs.sandboxTokenForRun(owner.actor, sent.body.runId)}`,
    };
    const id = resourceId();
    await accept(submit(threaded, [observation([id])]), [200]);
    await expect(chargedUnits(threaded, configuredPricing)).resolves.toBe(1);
    await runs.requestCancelRun(
      threaded.actor,
      threaded.runId,
      [200],
      configuredPricing.resolution,
    );
    await flushWaitUntilForTest();
    await chat.deleteThread(threaded.actor, thread.id);
    await chat.requestReadThread(threaded.actor, thread.id, [404]);
    // Thread removal preserves terminal runs and the billing ledger.
    await runs.requestReadRun(threaded.actor, threaded.runId, [200]);
    await expect(chargedUnits(threaded, configuredPricing)).resolves.toBe(1);
    await accept(submit(survivor, [observation([id])]), [200]);
    await expect(chargedUnits(survivor, configuredPricing)).resolves.toBe(0);
  });

  it.each(["user", "organization"] as const)(
    "drains an admitted terminal-run upload before %s deletion removes its ledger",
    async (subjectKind) => {
      const configuredPricing = await pricing();
      const deleted = await createRun();
      const survivor = await createRun();
      const sharedId = resourceId();
      const freshId = resourceId();
      const event = observation([sharedId]);
      await runs.requestCancelRun(
        deleted.actor,
        deleted.runId,
        [200],
        configuredPricing.resolution,
      );
      await flushWaitUntilForTest();

      const callbacks = createWebhookCallbackApi(context);
      callbacks.configureClerkWebhookSecret();
      context.mocks.s3.send.mockResolvedValue({});
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.retrieve.mockRejectedValue({
        code: "resource_missing",
      });
      const subjectId =
        subjectKind === "user" ? deleted.actor.userId : deleted.actor.orgId;
      if (!subjectId) {
        throw new Error("Deletion fixture requires an organization");
      }

      // Infrastructure exception: pause only this owned resource INSERT, so
      // the real HTTP upload holds its Run SHARE lock during Clerk deletion.
      const gate = await holdXResourceClaimForTest(
        {
          utcDay: event.observedAt.slice(0, 10),
          resourceType: "post",
          resourceId: sharedId,
        },
        context.signal,
      );
      const completion = Promise.allSettled([gate.done]);
      const upload = Promise.allSettled([
        accept(submit(deleted, [event]), [200]),
      ]);
      onTestFinished(async () => {
        gate.release();
        await completion;
        await upload;
        await flushWaitUntilForTest();
      });
      await expect.poll(gate.blockedWaiterCount).toBe(1);

      callbacks.verifyNextClerkWebhook({
        type: subjectKind === "user" ? "user.deleted" : "organization.deleted",
        data: { id: subjectId },
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

      await runs.requestReadRun(deleted.actor, deleted.runId, [404]);
      await accept(submit(deleted, [observation([freshId])]), [404]);
      await accept(submit(survivor, [observation([sharedId, freshId])]), [200]);
      await expect(chargedUnits(survivor, configuredPricing)).resolves.toBe(1);
    },
  );

  it.each(["user", "organization"] as const)(
    "waits for compaction before %s Run deletion and then fences old uploads",
    async (subjectKind) => {
      const configuredPricing = await pricing();
      const deleted = await createRun();
      const survivor = await createRun();
      const sharedId = resourceId();
      const freshId = resourceId();
      const source = observation([sharedId]);
      await accept(submit(deleted, [source]), [200]);
      await expect(chargedUnits(deleted, configuredPricing)).resolves.toBe(1);

      const callbacks = createWebhookCallbackApi(context);
      callbacks.configureClerkWebhookSecret();
      context.mocks.s3.send.mockResolvedValue({});
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.retrieve.mockRejectedValue({
        code: "resource_missing",
      });

      // Infrastructure exception: HTTP cannot pause compaction between its
      // source-row lock and the Run KEY SHARE needed by the new rollup's FK.
      // Lock only this test's API-created source; no historical rows are edited.
      const gate = await holdUsageEventCompactionLockFixture(context.signal, {
        idempotencyKey: source.idempotencyKey,
        runId: deleted.runId,
      });
      const completion = Promise.allSettled([gate.done]);
      onTestFinished(async () => {
        gate.release();
        await completion;
        await flushWaitUntilForTest();
      });
      const subjectId =
        subjectKind === "user" ? deleted.actor.userId : deleted.actor.orgId;
      if (!subjectId) {
        throw new Error("Deletion fixture requires an organization");
      }
      callbacks.verifyNextClerkWebhook({
        type: subjectKind === "user" ? "user.deleted" : "organization.deleted",
        data: { id: subjectId },
      });
      await callbacks.requestClerkWebhook("{}", {}, [200]);
      await expect.poll(gate.waiterCount).toBeGreaterThanOrEqual(1);

      // Clerk must wait before owning the Run. Taking it first would make its
      // SET NULL wait on the source row and block the compactor's FK check.
      await runs.requestReadRun(deleted.actor, deleted.runId, [200]);
      gate.release();
      const [completed] = await completion;
      if (completed.status === "rejected") {
        throw completed.reason;
      }
      await flushWaitUntilForTest();

      await runs.requestReadRun(deleted.actor, deleted.runId, [404]);
      await accept(submit(deleted, [observation([freshId])]), [404]);
      await accept(submit(survivor, [observation([sharedId, freshId])]), [200]);
      await expect(chargedUnits(survivor, configuredPricing)).resolves.toBe(1);
    },
  );

  it.each(["user", "organization"] as const)(
    "rejects a previously issued token after %s erasure admission closes",
    async (subjectKind) => {
      const configuredPricing = await pricing();
      const closed = await createRun();
      const survivor = await createRun();
      const sharedId = resourceId();
      const freshId = resourceId();
      await accept(submit(closed, [observation([sharedId])]), [200]);
      await expect(chargedUnits(closed, configuredPricing)).resolves.toBe(1);
      const subjectId =
        subjectKind === "user" ? closed.actor.userId : closed.actor.orgId;
      if (!subjectId) {
        throw new Error("Erasure fixture requires an organization");
      }
      // Infrastructure exception: erasure decision ingress is dormant and has
      // no production API. Close only this test-owned subject, leaving the run
      // present so the stale-token assertion specifically exercises admission.
      const closure = await closeErasureSubjectFixture({
        subjectKind,
        subjectId,
      });
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closure.jobId]);
      });
      await accept(submit(closed, [observation([freshId])]), [404]);
      await accept(submit(survivor, [observation([sharedId, freshId])]), [200]);
      await expect(chargedUnits(survivor, configuredPricing)).resolves.toBe(1);
    },
  );
});
