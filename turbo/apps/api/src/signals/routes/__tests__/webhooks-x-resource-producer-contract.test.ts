import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  createUsagePricingFixture,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { withXResourceClock } from "../../../test-fixtures/x-resource-admission";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";

const examples = z
  .object({
    cases: z.array(
      z.object({
        name: z.string(),
        capability: z.object({ startDate: z.string() }),
        chunks: z.array(z.object({ observedAt: z.iso.datetime() })).min(1),
        expectedPayloads: z.array(webhookUsageEventContract.send.body).min(1),
        expectedFirstUnits: z.number(),
        expectedRepeatUnits: z.number(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../packages/api-contracts/src/contracts/__tests__/fixtures/x-resource-observations.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  ).cases;

type UsagePayload = z.infer<typeof webhookUsageEventContract.send.body>;

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

async function createRun() {
  const actor = bdd.user();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "X producer contract",
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Read X resources",
    modelProvider: "anthropic-api-key",
  });
  return {
    actor,
    runId: run.runId,
    authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
  };
}

async function pricing(): Promise<UsagePricingFixture> {
  // Operator pricing has no production mutation API. Private lookup rows keep
  // the public net-credit assertion independent of shared X prices.
  const fixture = await createUsagePricingFixture({
    configured: ["posts.read", "user.read"].map((category) => {
      return {
        kind: "connector",
        provider: "x",
        category,
        unitPrice: 1,
        unitSize: 1,
      };
    }),
  });
  onTestFinished(fixture.cleanup);
  return fixture;
}

async function chargedUnits(
  actor: ApiTestUser,
  configuredPricing: UsagePricingFixture,
) {
  await billing.processOrgUsageEvents(actor, configuredPricing.resolution);
  return (await billing.readUsageRecord(actor)).body.totalCredits;
}

describe("X producer payload billing contract", () => {
  it.each(examples)("$name", async (example) => {
    const configuredPricing = await pricing();
    const firstObservation = example.chunks[0];
    if (!firstObservation) {
      throw new Error("Shared example needs an observation timestamp");
    }
    const fixtureDay = Date.parse(
      `${firstObservation.observedAt.slice(0, 10)}T00:00:00.000Z`,
    );
    // Keep the fixture's UTC boundaries and relative activation date, while
    // placing every observation after the real test Runs are created.
    const testDay = Math.floor(now() / DAY_MS) * DAY_MS + DAY_MS;
    const offset = testDay - fixtureDay;
    mockEnv(
      "X_RESOURCE_BILLING_START_DATE",
      new Date(Date.parse(example.capability.startDate) + offset)
        .toISOString()
        .slice(0, 10),
    );
    const first = await createRun();
    const anotherOrg = await createRun();
    const resourcePrefix = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    ).toString();

    function payloadsFor(runId: string): UsagePayload[] {
      const sourceIds = new Map<string, string>();
      return example.expectedPayloads.map((payload) => {
        return {
          runId,
          events: payload.events.map((event) => {
            let sourceId = sourceIds.get(event.idempotencyKey);
            if (!sourceId) {
              sourceId = randomUUID();
              sourceIds.set(event.idempotencyKey, sourceId);
            }
            const identity = { ...event, idempotencyKey: sourceId };
            if (!("protocol" in event)) {
              return identity;
            }
            return {
              ...identity,
              observedAt: new Date(
                Date.parse(event.observedAt) + offset,
              ).toISOString(),
              resources: event.resources.map((resource) => {
                return {
                  ...resource,
                  // Preserve leading zeros: the API must distinguish 001 from 1,
                  // including when their numeric values would otherwise coincide.
                  id: resource.id.replace(/^0*/, `$&${resourcePrefix}`),
                };
              }),
            };
          }),
        };
      });
    }

    const firstPayloads = payloadsFor(first.runId);
    const repeatedPayloads = payloadsFor(anotherOrg.runId);
    const observationClock = new Date(
      Math.max(
        ...example.chunks.map((chunk) => {
          return Date.parse(chunk.observedAt);
        }),
      ) + offset,
    );

    async function submit(
      authorization: string,
      payloads: UsagePayload[],
      clock: Date,
      expectedStatus: 200 | 400 = 200,
    ) {
      await withXResourceClock(
        () => {
          return clock;
        },
        async () => {
          for (const body of payloads) {
            await accept(
              setupApp({
                context,
                routes: webhooksAgentHealthUsageTelemetryRoutes,
              })(webhookUsageEventContract).send({
                headers: { authorization },
                body,
              }),
              [expectedStatus],
            );
          }
        },
      );
    }

    await submit(first.authorization, firstPayloads, observationClock);
    await expect(chargedUnits(first.actor, configuredPricing)).resolves.toBe(
      example.expectedFirstUnits,
    );

    // Re-delivery of the identical source cannot charge its remainder again.
    await submit(first.authorization, firstPayloads, observationClock);
    await expect(chargedUnits(first.actor, configuredPricing)).resolves.toBe(
      example.expectedFirstUnits,
    );

    // A different organization and source share resource claims, but retain
    // independently billable remainder (or the legacy count before activation).
    await submit(anotherOrg.authorization, repeatedPayloads, observationClock);
    await expect(
      chargedUnits(anotherOrg.actor, configuredPricing),
    ).resolves.toBe(example.expectedRepeatUnits);

    if (
      firstPayloads.some((payload) => {
        return payload.events.some((event) => {
          return "protocol" in event;
        });
      })
    ) {
      await submit(
        first.authorization,
        firstPayloads,
        new Date(observationClock.getTime() + 2 * DAY_MS),
        400,
      );
      await expect(chargedUnits(first.actor, configuredPricing)).resolves.toBe(
        example.expectedFirstUnits,
      );
    }
  });
});
