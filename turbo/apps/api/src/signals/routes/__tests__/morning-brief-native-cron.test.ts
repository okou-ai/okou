import { randomUUID } from "node:crypto";

import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { userCache } from "@okouai/db/schema/user-cache";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { db } from "../../../lib/db";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedInstalledMorningBrief } from "../../../test-fixtures/morning-brief-collection";
import { cronExecuteMorningBriefsRoutes } from "../cron-execute-morning-briefs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";

/**
 * The native Morning Brief cron, exercised through its registered route.
 *
 * Everything below runs the real modules: the actual `ROUTES` handler behind its
 * real cron-secret check, the real bootstrap and cutover writers, the real S5
 * generation engine and the real S6 Chat and shared-outbox delivery. The only
 * doubles are the external Slack, OpenRouter and Resend HTTP boundaries, so the
 * ownership, admission, single-invocation and delivery decisions under test are
 * the production ones.
 *
 * No test seeds a generation or delivery row directly, and none calls a preview
 * route: a delivered brief here is one the scheduler actually produced.
 */

const context = testContext();
const store = createStore();

const CRON_SECRET = "native-morning-brief-cron-secret";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const RESEND_URL = "https://api.resend.com/emails";

afterEach(() => {
  clearMockNow();
});

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
}

function cronClient() {
  return setupApp({ context, routes: cronExecuteMorningBriefsRoutes })(
    cronExecuteMorningBriefsContract,
  );
}

function tick(secret: string = CRON_SECRET) {
  return cronClient().execute({
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function fixture(
  options: { readonly feature?: boolean; readonly email?: string | null } = {},
): Promise<Fixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { userId, orgId, role: "admin" },
    context.signal,
  );
  const brief = await seedInstalledMorningBrief({ orgId, userId });
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: options.feature !== false },
  );
  const installation = await store.set(
    seedSlackOrgInstallation$,
    { orgId, botToken: `xoxb-test-${randomUUID()}` },
    context.signal,
  );
  await store.set(
    seedSlackOrgConnection$,
    { slackWorkspaceId: installation.slackWorkspaceId, userId },
    context.signal,
  );
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockOptionalEnv("OPENROUTER_API_KEY", "platform-openrouter-key");
  mockOptionalEnv("RESEND_API_KEY", "platform-resend-key");
  mockOptionalEnv("RESEND_FROM_DOMAIN", "mail.okou.test");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  if (options.email !== null) {
    await db()
      .insert(userCache)
      .values({
        userId,
        email: options.email ?? `${userId}@example.test`,
        name: "Test Member",
        cachedAt: new Date(now()),
      })
      .onConflictDoNothing();
  }
  return {
    orgId,
    userId,
    agentId: brief.agentId,
    workflowId: brief.workflowId,
    automationId: brief.automationId,
  };
}

/** One shared Slack channel with one in-window message. */
function scriptSlack(): void {
  server.use(
    http.get(SLACK_CONVERSATIONS_URL, () => {
      return HttpResponse.json({
        ok: true,
        channels: [{ id: "C100", name: "general", is_private: false }],
        response_metadata: { next_cursor: "" },
      });
    }),
    http.get("https://slack.com/api/conversations.replies", () => {
      return HttpResponse.json({ ok: true, messages: [] });
    }),
    http.get(SLACK_HISTORY_URL, ({ request }) => {
      const channel = new URL(request.url).searchParams.get("channel");
      const anchorSeconds = Math.floor(now() / 1000) - 3600;
      return HttpResponse.json(
        channel === "C100"
          ? {
              ok: true,
              messages: [
                {
                  type: "message",
                  ts: `${anchorSeconds}.000100`,
                  user: "U1",
                  text: "ship the release",
                },
              ],
            }
          : { ok: true, messages: [] },
      );
    }),
  );
}

interface ProviderCalls {
  readonly generation: string[];
  readonly email: unknown[];
}

/** Script both provider boundaries and count every crossing request. */
function scriptProviders(): { readonly calls: ProviderCalls } {
  const calls: ProviderCalls = { generation: [], email: [] };
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      calls.generation.push(await request.text());
      return HttpResponse.json({
        id: "gen-01HNATIVECRON",
        model: "google/gemini-3.8-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                decision: "deliver",
                title: "Release readiness",
                sections: [
                  {
                    heading: "Decisions",
                    items: [
                      { text: "The release ships today.", sourceIds: ["m1"] },
                    ],
                  },
                ],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cost: 0.0001,
        },
      });
    }),
    http.post(RESEND_URL, async ({ request }) => {
      calls.email.push(await request.json());
      return HttpResponse.json({ id: `resend_${randomUUID()}` });
    }),
  );
  return { calls };
}

async function readSchedule(f: Fixture) {
  const [row] = await db()
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, f.orgId),
        eq(morningBriefNativeSchedules.userId, f.userId),
      ),
    )
    .limit(1);
  return row;
}

async function readOccurrences(f: Fixture) {
  return await db()
    .select()
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, f.orgId),
        eq(morningBriefNativeOccurrences.userId, f.userId),
      ),
    );
}

async function readGenerations(f: Fixture) {
  return await db()
    .select()
    .from(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, f.orgId),
        eq(morningBriefGenerations.userId, f.userId),
      ),
    );
}

async function readDeliveries(f: Fixture) {
  return await db()
    .select()
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, f.orgId),
        eq(morningBriefDeliveries.userId, f.userId),
      ),
    );
}

async function readAutomation(f: Fixture) {
  const [row] = await db()
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, f.automationId))
    .limit(1);
  return row;
}

/** Drive the real cutover to completion through ordinary ticks. */
async function tickUntilNative(f: Fixture): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await accept(tick(), [200]);
    if ((await readSchedule(f))?.phase === "native") {
      return;
    }
  }
  throw new Error("The native cutover did not converge within five ticks");
}

/** Make the member's native obligation due right now. */
async function makeNativeDue(f: Fixture): Promise<Date> {
  const due = new Date(now() - 60 * 1000);
  await db()
    .update(morningBriefNativeSchedules)
    .set({ nextRunAt: due, scheduleOwner: "native" })
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, f.orgId),
        eq(morningBriefNativeSchedules.userId, f.userId),
      ),
    );
  return due;
}

describe("native Morning Brief cron", () => {
  it("performs zero work without a valid cron secret", async () => {
    const f = await fixture();
    const { calls } = scriptProviders();

    await accept(tick("wrong-secret"), [401]);

    expect(calls.generation).toHaveLength(0);
    await expect(readSchedule(f)).resolves.toBeUndefined();
  });

  it("materializes an installed brief as a legacy-phase row and cuts over", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();

    // The first tick may only bootstrap and start the cutover; it must never
    // take a member straight from "installed" to "native work admitted".
    const first = await accept(tick(), [200]);
    expect(first.body.materialized).toBe(1);

    const bootstrapped = await readSchedule(f);
    // Bootstrap itself only writes a `legacy` row; the same tick's separate
    // transition pass may already have closed legacy admission. Neither step
    // admits native work, which is the invariant that matters here.
    expect(["legacy", "draining"]).toContain(bootstrapped?.phase);
    expect(bootstrapped?.enabled).toBeTruthy();
    expect(bootstrapped?.timezone).toBe("Asia/Shanghai");
    expect(bootstrapped?.legacyAutomationId).toBe(f.automationId);
    await expect(readOccurrences(f)).resolves.toHaveLength(0);

    // Later ticks converge on the switch's current intent. The legacy poller's
    // own admission instant is cleared in the same transaction that enters
    // `draining`, and no native occurrence exists until the transfer commits.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const schedule = await readSchedule(f);
      if (schedule?.phase === "native") {
        break;
      }
      await expect(readOccurrences(f)).resolves.toHaveLength(0);
      await accept(tick(), [200]);
    }

    const cutover = await readSchedule(f);
    expect(cutover?.phase).toBe("native");
    expect(cutover?.scheduleOwner).toBe("native");
    expect(cutover?.nextRunAt).not.toBeNull();
    // The transfer bumped the epoch exactly once; nothing manufactured extras.
    expect(cutover?.ownerEpoch).toBe(2);
    // Legacy can no longer admit a claim for this member.
    expect((await readAutomation(f))?.nextRunAt).toBeNull();
    // The user's own choice is untouched by the cutover.
    expect((await readAutomation(f))?.enabled).toBeTruthy();
    expect(cutover?.enabled).toBeTruthy();
  });

  it("runs collection, one platform generation, Chat and shared email with the legacy scheduler disabled", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await tickUntilNative(f);

    // The legacy scheduler is now closed for this member. Everything below has
    // to work anyway, which is the whole point of the native authority.
    expect((await readAutomation(f))?.nextRunAt).toBeNull();
    const due = await makeNativeDue(f);

    const executed = await accept(tick(), [200]);
    expect(executed.body.claimed).toBe(1);
    expect(executed.body.settled).toBe(1);

    // Exactly one platform request, for the production purpose.
    expect(calls.generation).toHaveLength(1);
    const generations = await readGenerations(f);
    expect(generations).toHaveLength(1);
    expect(generations[0]?.executionPurpose).toBe("production");
    expect(generations[0]?.state).toBe("succeeded");
    expect(generations[0]?.model).toBe("google/gemini-3.8-flash");

    // One canonical Chat delivery, recorded under the production purpose.
    const deliveries = await readDeliveries(f);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.executionPurpose).toBe("production");
    const threadId = deliveries[0]?.chatThreadId;
    expect(threadId).toBeDefined();
    const events = await db()
      .select({ eventType: chatEvents.eventType })
      .from(chatEvents)
      .where(eq(chatEvents.chatThreadId, threadId ?? ""));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("output.message");

    // One shared-outbox email intent for the same accepted body.
    const intents = await db()
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, deliveries[0]?.emailOutboxId ?? randomUUID()));
    expect(intents).toHaveLength(1);

    // The slot settled exactly once, keeping its frozen anchor, and the next
    // occurrence is strictly in the future.
    const occurrences = await readOccurrences(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.outcome).toBe("delivered");
    expect(occurrences[0]?.scheduledFor.getTime()).toBe(due.getTime());
    expect(occurrences[0]?.settledAt).not.toBeNull();
    const after = await readSchedule(f);
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(now());

    // Zero Run and zero user-credit footprint.
    const runs = await db()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.orgId, f.orgId));
    expect(runs).toHaveLength(0);
  });

  it("does not contact the provider twice for the same slot across ticks", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await tickUntilNative(f);
    await makeNativeDue(f);
    await accept(tick(), [200]);
    expect(calls.generation).toHaveLength(1);

    // A later tick finds the slot settled and its successor in the future.
    const repeat = await accept(tick(), [200]);
    expect(repeat.body.claimed).toBe(0);
    expect(calls.generation).toHaveLength(1);
    await expect(readGenerations(f)).resolves.toHaveLength(1);
    await expect(readDeliveries(f)).resolves.toHaveLength(1);
  });

  it("admits no native occurrence while the implementation switch is off", async () => {
    const f = await fixture({ feature: false });
    scriptSlack();
    const { calls } = scriptProviders();

    await accept(tick(), [200]);
    await accept(tick(), [200]);

    const schedule = await readSchedule(f);
    expect(schedule?.phase).toBe("legacy");
    await expect(readOccurrences(f)).resolves.toHaveLength(0);
    expect(calls.generation).toHaveLength(0);
    // The member's own legacy admission was never closed.
    expect((await readAutomation(f))?.nextRunAt).not.toBeNull();
  });
});
