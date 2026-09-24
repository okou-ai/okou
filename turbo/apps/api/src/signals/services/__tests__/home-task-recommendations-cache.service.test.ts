import { randomUUID } from "node:crypto";

import { cronRefreshHomeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/cron";
import { homeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { HomeTaskRecommendationEntry } from "@okouai/db/jsonb-contracts/home-task-recommendation";
import { homeTaskRecommendations } from "@okouai/db/schema/home-task-recommendation";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { HttpResponse, http } from "msw";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { server } from "../../../mocks/server";
import { createScopedHomeTaskRecommendationCronRoutesForTest } from "../../routes/cron-refresh-home-task-recommendations";
import { homeTaskRecommendationRoutes } from "../../routes/home-task-recommendations";
import { createChatEventsFixture } from "../../routes/__tests__/helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "../../routes/__tests__/helpers/feature-switches";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const context = testContext({ connectorCatalog: true });
const fixture = createChatEventsFixture(context);

// No production endpoint writes arbitrary cache JSONB or holds a refresh claim.
// These historical/corrupt persisted states require this narrow DB setup;
// assertions still use the real GET and cron routes, not service internals.
describe("home task recommendation cache recovery", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
  const db = drizzle(pool);
  afterEach(() => {
    clearMockNow();
  });

  afterAll(async () => {
    await pool.end();
  });

  function client() {
    return setupApp({ context, routes: homeTaskRecommendationRoutes })(
      homeTaskRecommendationsContract,
    );
  }

  function cronClient(scope: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  }) {
    return setupApp({
      context,
      routes: createScopedHomeTaskRecommendationCronRoutesForTest(scope),
    })(cronRefreshHomeTaskRecommendationsContract);
  }

  const oldCard: HomeTaskRecommendationEntry = {
    id: "r1",
    title: "Review the next step",
    prompt: "Help me prepare the next step.",
    rationale: "Recent conversation",
    actionability: 90,
    target: { kind: "new-thread" },
    connectors: [],
  };

  it("resets a pre-purpose cache on GET and regenerates it on the next cron", async () => {
    const { actor, agentId, runnerGroup } = await fixture.entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const thread = await fixture.chat.createThread(actor, {
      agentId,
      title: "Follow-up",
    });
    const run = await fixture.sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Prepare the customer follow-up for review.",
    });
    const claim = await fixture.claimChatRun(runnerGroup, run.runId);
    await fixture.completeChatRunOk(run.runId, claim.sandboxHeaders);
    await flushWaitUntilForTest();

    const base = now();
    mockNow(base);
    mockEnv("CRON_SECRET", "home-task-cron-secret");
    mockOptionalEnv("OPENROUTER_API_KEY", "home-task-openrouter-key");
    server.use(
      http.post(OPENROUTER_DECISIONS_URL, () => {
        return HttpResponse.json({
          answers: {
            c1_actionability: {
              type: "score",
              score: 3,
              confidence: 0.95,
              probabilities: { "0": 0, "1": 0, "2": 0.1, "3": 0.9 },
            },
            c1_grounded: { type: "noul", noul: 0.95 },
            c1_destination: { type: "noul", noul: 0.95 },
          },
          usage: { input_tokens: 200, output_tokens: 0 },
        });
      }),
      http.post(OPENROUTER_CHAT_URL, () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify([
                  {
                    candidateId: "c1",
                    title: "Prepare the customer follow-up",
                    prompt: "Draft the customer follow-up for my review.",
                    rationale: "A recent conversation needs a follow-up",
                  },
                ]),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        });
      }),
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.HomeTaskRecommendations]: true },
    );
    await accept(
      client().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    await db
      .update(homeTaskRecommendations)
      .set({
        entries: [oldCard],
        inputDigest: "stale-digest",
        generatedAt: new Date(base),
        nextRefreshAt: new Date(base + 15 * 60 * 1000),
        updatedAt: new Date(base),
      })
      .where(
        and(
          eq(homeTaskRecommendations.userId, actor.userId),
          eq(homeTaskRecommendations.orgId, actor.orgId),
          eq(homeTaskRecommendations.agentId, agentId),
        ),
      );

    const recovered = await accept(
      client().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(recovered.body).toMatchObject({
      status: "unavailable",
      recommendations: [],
      refreshAfterMs: 0,
    });

    const cron = await accept(
      cronClient({ userId: actor.userId, orgId: actor.orgId, agentId }).refresh(
        {
          headers: { authorization: "Bearer home-task-cron-secret" },
        },
      ),
      [200],
    );
    expect(cron.body).toMatchObject({ scanned: 1, refreshed: 1, failed: 0 });
    const regenerated = await accept(
      client().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(regenerated.body).toMatchObject({
      status: "available",
      recommendations: [
        {
          title: "Prepare the customer follow-up",
          purpose: "task",
          target: { kind: "existing-thread", threadId: thread.id },
        },
      ],
    });
  });

  it("does not overwrite an active claim for an explicitly invalid purpose", async () => {
    const { actor, agentId } = await fixture.entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const base = now();
    mockNow(base);
    mockEnv("CRON_SECRET", "home-task-cron-secret");
    mockOptionalEnv("OPENROUTER_API_KEY", "home-task-openrouter-key");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.HomeTaskRecommendations]: true },
    );
    await accept(
      client().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    await db
      .update(homeTaskRecommendations)
      .set({
        entries: sql`${JSON.stringify([{ ...oldCard, purpose: "invalid" }])}::jsonb`,
        inputDigest: "stale-digest",
        generatedAt: new Date(base),
        nextRefreshAt: new Date(base),
        claimId: randomUUID(),
        claimExpiresAt: new Date(base + 5 * 60 * 1000),
        updatedAt: new Date(base),
      })
      .where(
        and(
          eq(homeTaskRecommendations.userId, actor.userId),
          eq(homeTaskRecommendations.orgId, actor.orgId),
          eq(homeTaskRecommendations.agentId, agentId),
        ),
      );

    const duringClaim = await accept(
      client().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(duringClaim.body).toMatchObject({
      status: "unavailable",
      recommendations: [],
    });
    const blockedCron = await accept(
      cronClient({ userId: actor.userId, orgId: actor.orgId, agentId }).refresh(
        {
          headers: { authorization: "Bearer home-task-cron-secret" },
        },
      ),
      [200],
    );
    expect(blockedCron.body).toMatchObject({ scanned: 0 });

    mockNow(base + 5 * 60 * 1000 + 1);
    const afterExpiry = await accept(
      client().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(afterExpiry.body).toMatchObject({
      status: "unavailable",
      recommendations: [],
      refreshAfterMs: 0,
    });
    const recoveredCron = await accept(
      cronClient({ userId: actor.userId, orgId: actor.orgId, agentId }).refresh(
        {
          headers: { authorization: "Bearer home-task-cron-secret" },
        },
      ),
      [200],
    );
    expect(recoveredCron.body).toMatchObject({ scanned: 1, failed: 0 });
  });
});
