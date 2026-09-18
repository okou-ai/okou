import { randomUUID } from "node:crypto";

import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";

const context = testContext();

beforeEach(() => {
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
});

describe("agent usage event webhook", () => {
  it.each([false, true])(
    "requires an existing authenticated run for resource observations (mixed=%s)",
    async (mixed) => {
      const runId = randomUUID();
      const token = generateSandboxToken(
        `user_${randomUUID()}`,
        runId,
        `org_${randomUUID()}`,
      );
      const resourceEvent = {
        protocol: "x-resource-v1" as const,
        idempotencyKey: randomUUID(),
        kind: "connector" as const,
        provider: "x" as const,
        category: "posts.read" as const,
        quantity: 1,
        observedAt: nowDate().toISOString(),
        resources: [{ id: "9007199254740993", occurrences: 1 }],
        remainder: [],
      };
      const client = setupApp({
        context,
        routes: webhooksAgentHealthUsageTelemetryRoutes,
      })(webhookUsageEventContract);
      const response = await accept(
        client.send({
          headers: { authorization: `Bearer ${token}` },
          body: {
            runId,
            events: mixed
              ? [
                  {
                    idempotencyKey: randomUUID(),
                    kind: "connector",
                    provider: "x",
                    category: "tweet.read",
                    quantity: 2,
                  },
                  resourceEvent,
                ]
              : [resourceEvent],
          },
        }),
        [404],
      );
      expect(response.body.error.code).toBe("NOT_FOUND");

      const unauthorized = await accept(
        client.send({
          headers: { authorization: `Bearer ${token}` },
          body: { runId: randomUUID(), events: [resourceEvent] },
        }),
        [401],
      );
      expect(unauthorized.body.error.code).toBe("UNAUTHORIZED");
    },
  );

  it("returns not found when a usage event targets a missing run", async () => {
    const runId = randomUUID();
    const orgId = `org_usage_missing_${randomUUID().slice(0, 8)}`;
    const userId = `user_usage_missing_${randomUUID().slice(0, 8)}`;
    const sandboxToken = generateSandboxToken(userId, runId, orgId);

    const response = await accept(
      setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
        webhookUsageEventContract,
      ).send({
        headers: { authorization: `Bearer ${sandboxToken}` },
        body: {
          runId,
          events: [
            {
              idempotencyKey: randomUUID(),
              kind: "connector",
              provider: "x",
              category: "tweet.read",
              quantity: Number.MAX_SAFE_INTEGER,
            },
          ],
        },
      }),
      [404],
    );

    expect(response.status).toBe(404);
  });

  it("rejects a usage quantity above the exact integer range", async () => {
    const runId = randomUUID();
    const orgId = `org_usage_unsafe_${randomUUID().slice(0, 8)}`;
    const userId = `user_usage_unsafe_${randomUUID().slice(0, 8)}`;
    const sandboxToken = generateSandboxToken(userId, runId, orgId);

    const response = await accept(
      setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
        webhookUsageEventContract,
      ).send({
        headers: { authorization: `Bearer ${sandboxToken}` },
        body: {
          runId,
          events: [
            {
              idempotencyKey: randomUUID(),
              kind: "connector",
              provider: "x",
              category: "tweet.read",
              quantity: Number.MAX_SAFE_INTEGER + 1,
            },
          ],
        },
      }),
      [400],
    );

    expect(response.status).toBe(400);
  });
});
