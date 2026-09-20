import { randomUUID } from "node:crypto";

import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";
import { morningBriefDebugTriggerContract } from "@okouai/api-contracts/contracts/morning-brief-debug-trigger";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedInstalledMorningBrief } from "../../../test-fixtures/morning-brief-collection";
import { waitForDeferredBlocker } from "../../../test-fixtures/pi-deferred-lock";
import {
  countEmailOutboxRows,
  countOrgAgentRuns,
  countOrgUsageEvents,
  holdNativeScheduleRow,
  interruptNativeSettlementAfterGeneration,
  readNativeDeliveries,
  readNativeOccurrences,
  readNativeSchedule,
  readThreadEventTypes,
  seedRecipientAddress,
} from "../../../test-fixtures/morning-brief-native-schedule";
import { createScopedMorningBriefCronRoutesForTest } from "../cron-execute-morning-briefs";
import { morningBriefDebugTriggerRoutes } from "../morning-brief-debug-trigger";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { userPreferencesRoutes } from "../user-preferences";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { mockClerkUsers } from "./helpers/clerk-users";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * The Settings > Debug on-demand trigger, exercised through its real route.
 *
 * The trigger never executes the pipeline. Every brief below is produced by the
 * ordinary cron route claiming the obligation this endpoint moved, through the
 * real bootstrap, cutover, claim, S5 generation and S6 delivery code. Only the
 * Slack, OpenRouter and Resend boundaries are doubled, so the admission,
 * single-invocation and scheduling decisions under test are the production ones.
 */

const context = testContext();
const mocks = createRouteMocks(context);
const store = createStore();

const CRON_SECRET = "native-morning-brief-trigger-secret";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * The seeded brief runs `0 7 * * *` in `Asia/Shanghai`, so its daily instant is
 * 23:00 UTC of the previous day. These two clocks sit on either side of it.
 */
function afterDailyInstant(): Date {
  return new Date("2026-09-20T06:00:00.000Z");
}

function beforeDailyInstant(): Date {
  return new Date("2026-09-20T22:00:00.000Z");
}

/** The daily occurrence that is already pending at both clocks above. */
function nextDailyInstant(): Date {
  return new Date("2026-09-20T23:00:00.000Z");
}

beforeEach(() => {
  context.mocks.resend.send.mockReset();
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-${randomUUID()}` },
    error: null,
  });
});

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

function cronClient(owner: Fixture) {
  return setupApp({
    context,
    routes: createScopedMorningBriefCronRoutesForTest(owner),
  })(cronExecuteMorningBriefsContract);
}

function tick(owner: Fixture) {
  return cronClient(owner).execute({
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

function triggerClient() {
  return setupApp({ context, routes: morningBriefDebugTriggerRoutes })(
    morningBriefDebugTriggerContract,
  );
}

/** Call the debug trigger as `owner`, who is therefore the only owner moved. */
function triggerAs(owner: Fixture) {
  mocks.clerk.session(owner.userId, owner.orgId);
  return triggerClient().trigger({
    headers: { authorization: "Bearer clerk-session" },
    body: {},
  });
}

function preferenceClient() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
}

/**
 * The obligation exactly as the owner reads it in Settings.
 *
 * `GET /api/preferences/morning-brief` projects a native owner's `next_run_at`
 * directly, so every scheduling assertion this suite makes about the obligation
 * itself goes through that production endpoint rather than the durable row.
 */
async function readObligation(owner: Fixture) {
  mocks.clerk.session(owner.userId, owner.orgId);
  const response = await accept(
    preferenceClient().get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  return response.body;
}

function userPreferencesClient() {
  return setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  );
}

async function fixture(): Promise<Fixture> {
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
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
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
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
  mockClerkUsers(context, [
    {
      id: userId,
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        { id: "idn_primary", emailAddress: `${userId}@example.test` },
      ],
    },
  ]);
  await seedRecipientAddress(userId, `${userId}@example.test`);
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

/** Script the model boundary and count every request that crosses it. */
function scriptProviders(): { readonly generation: string[] } {
  const generation: string[] = [];
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      generation.push(await request.text());
      return HttpResponse.json({
        id: `gen-${randomUUID()}`,
        model: "google/gemini-3.8-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                decision: "deliver",
                language: "en-US",
                title: "Release readiness",
                sections: [
                  {
                    heading: "Decisions",
                    items: [
                      { text: "The release ships today.", citations: ["c1"] },
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
  );
  return { generation };
}

/**
 * Run two competing writers against the held schedule row in a decided order.
 *
 * `first` blocks on the held row and `second` blocks behind `first`, so the
 * database itself serializes them and the commit order under test is the one
 * asserted rather than whichever the scheduler happened to pick.
 */
async function raceOnScheduleRow<A, B>(
  f: Fixture,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<{ readonly first: A; readonly second: B }> {
  const hold = await holdNativeScheduleRow(f, context.signal);
  const firstPending = first();
  const firstPid = await hold.waitForBlocked();
  const secondPending = second();
  await waitForDeferredBlocker(firstPid);
  await hold.release();
  return { first: await firstPending, second: await secondPending };
}

/** Drive the real cutover to completion through ordinary ticks. */
async function tickUntilNative(f: Fixture): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await accept(tick(f), [200]);
    if ((await readNativeSchedule(f))?.phase === "native") {
      return;
    }
  }
  throw new Error("The native cutover did not converge within five ticks");
}

/** A migrated, enabled native owner whose obligation is the next morning. */
async function nativeOwner(at: Date = afterDailyInstant()): Promise<Fixture> {
  mockNow(at);
  const f = await fixture();
  scriptSlack();
  await tickUntilNative(f);
  return f;
}

describe("on-demand native Morning Brief trigger", () => {
  it("queues the owner's obligation for the ordinary cron, which runs the real pipeline", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    await expect(readObligation(f)).resolves.toMatchObject({
      enabled: true,
      status: "enabled",
      nextRunAt: nextDailyInstant().toISOString(),
    });

    const queued = await accept(triggerAs(f), [200]);
    expect(queued.body.status).toBe("queued");
    expect(Date.parse(queued.body.scheduledFor)).toBe(
      afterDailyInstant().getTime(),
    );
    // The endpoint itself executes nothing: it only moved the obligation the
    // owner reads in Settings.
    expect(generation).toHaveLength(0);
    await expect(readObligation(f)).resolves.toMatchObject({
      enabled: true,
      nextRunAt: afterDailyInstant().toISOString(),
    });
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);

    const executed = await accept(tick(f), [200]);
    expect(executed.body.claimed).toBe(1);
    expect(executed.body.settled).toBe(1);

    // The ordinary claim froze the moved instant as this slot's anchor.
    const occurrences = await readNativeOccurrences(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.scheduledFor.getTime()).toBe(
      afterDailyInstant().getTime(),
    );
    expect(occurrences[0]?.outcome).toBe("delivered");
    expect(occurrences[0]?.settledAt).not.toBeNull();

    // One model request, one Chat message, one logical email.
    expect(generation).toHaveLength(1);
    const deliveries = await readNativeDeliveries(f);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.executionPurpose).toBe("production");
    await expect(
      readThreadEventTypes(deliveries[0]?.chatThreadId ?? ""),
    ).resolves.toStrictEqual(["output.message"]);
    await expect(
      countEmailOutboxRows(deliveries[0]?.emailOutboxId ?? randomUUID()),
    ).resolves.toBe(1);

    // Zero agent Run and zero user-credit footprint: native is platform-funded.
    await expect(countOrgAgentRuns(f.orgId)).resolves.toBe(0);
    await expect(countOrgUsageEvents(f.orgId)).resolves.toBe(0);
  });

  it("reinstalls the same next-morning instant, so the scheduled delivery is not lost", async () => {
    const f = await nativeOwner(afterDailyInstant());
    scriptProviders();
    const before = await readObligation(f);
    expect(before.nextRunAt).toBe(nextDailyInstant().toISOString());

    await accept(triggerAs(f), [200]);
    const executed = await accept(tick(f), [200]);
    // Exactly one settlement ran, and it is the writer that owns the successor.
    expect(executed.body.settled).toBe(1);

    // Settlement recomputes the successor from its own clock under the
    // persisted cron and timezone. For a daily cron triggered after that day's
    // instant, that is exactly the next-morning instant already pending, so the
    // owner's own Settings view is unchanged by the debug brief.
    const after = await readObligation(f);
    expect(after.nextRunAt).toBe(nextDailyInstant().toISOString());
    expect(after.nextRunAt).toBe(before.nextRunAt);
    expect(Date.parse(after.nextRunAt ?? "")).toBeGreaterThan(now());
    expect(after.status).toBe("enabled");
  });

  it("delivers two briefs at distinct anchors when triggered before the daily instant", async () => {
    const f = await nativeOwner(beforeDailyInstant());
    const { generation } = scriptProviders();
    await expect(readObligation(f)).resolves.toMatchObject({
      nextRunAt: nextDailyInstant().toISOString(),
    });

    await accept(triggerAs(f), [200]);
    await accept(tick(f), [200]);
    // The scheduled instant survived the debug brief and is still owed.
    await expect(readObligation(f)).resolves.toMatchObject({
      nextRunAt: nextDailyInstant().toISOString(),
    });

    mockNow(nextDailyInstant());
    await accept(tick(f), [200]);

    const occurrences = [...(await readNativeOccurrences(f))].sort((a, b) => {
      return a.scheduledFor.getTime() - b.scheduledFor.getTime();
    });
    expect(occurrences).toHaveLength(2);
    const anchors = occurrences.map((row) => {
      return row.scheduledFor.getTime();
    });
    expect(anchors).toStrictEqual([
      beforeDailyInstant().getTime(),
      nextDailyInstant().getTime(),
    ]);
    for (const occurrence of occurrences) {
      expect(occurrence.outcome).toBe("delivered");
      expect(occurrence.settledAt).not.toBeNull();
    }
    // Two slots, two briefs, one model request each.
    expect(generation).toHaveLength(2);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(2);
    await expect(countOrgAgentRuns(f.orgId)).resolves.toBe(0);
  });

  it("refuses a member whose durable native row does not exist yet", async () => {
    mockNow(afterDailyInstant());
    const f = await fixture();
    const { generation } = scriptProviders();

    const refused = await accept(triggerAs(f), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_SCHEDULE_ABSENT");
    expect(generation).toHaveLength(0);
    await expect(readNativeSchedule(f)).resolves.toBeUndefined();
  });

  it("refuses a member whose execution ownership is still legacy", async () => {
    mockNow(afterDailyInstant());
    const f = await fixture();
    scriptSlack();
    const { generation } = scriptProviders();
    // One tick materializes the durable row without reaching `native`.
    await accept(tick(f), [200]);
    const bootstrapped = await readNativeSchedule(f);
    expect(bootstrapped?.phase).not.toBe("native");

    const refused = await accept(triggerAs(f), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_NOT_NATIVE");
    expect(generation).toHaveLength(0);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: bootstrapped?.nextRunAt,
      ownerEpoch: bootstrapped?.ownerEpoch,
    });
  });

  it("refuses an owner whose own Morning Brief choice is off", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    mocks.clerk.session(f.userId, f.orgId);
    await accept(
      preferenceClient().update({
        headers: { authorization: "Bearer clerk-session" },
        body: { enabled: false },
      }),
      [200],
    );
    const disabled = await readNativeSchedule(f);
    expect(disabled?.enabled).toBeFalsy();

    const refused = await accept(triggerAs(f), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_DISABLED");
    expect(generation).toHaveLength(0);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
      scheduleOwner: null,
      ownerEpoch: disabled?.ownerEpoch,
    });
    // A tick after the refusal still admits nothing.
    await accept(tick(f), [200]);
    expect(generation).toHaveLength(0);
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);
  });

  it("refuses when the live membership generation no longer matches", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    const before = await readNativeSchedule(f);
    // A remove and rejoin issues a new immutable Clerk membership id.
    await store.set(
      seedOrgMembership$,
      {
        userId: f.userId,
        orgId: f.orgId,
        role: "admin",
        membershipId: `orgmem_${randomUUID()}`,
      },
      context.signal,
    );

    const refused = await accept(triggerAs(f), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_MEMBERSHIP_CHANGED");
    expect(generation).toHaveLength(0);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: before?.nextRunAt,
      ownerEpoch: before?.ownerEpoch,
    });
  });

  it("refuses a member the organization no longer lists at all", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    const before = await readNativeSchedule(f);
    await store.set(
      deleteOrgMembership$,
      { orgId: f.orgId, userId: f.userId },
      context.signal,
    );

    const refused = await accept(triggerAs(f), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_MEMBERSHIP_CHANGED");
    expect(generation).toHaveLength(0);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: before?.nextRunAt,
      ownerEpoch: before?.ownerEpoch,
    });
  });

  it("refuses while an admitted occurrence still owes its settlement", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    // The claim, generation and Chat receipt commit and the settlement is then
    // interrupted. That is exactly the window a second press must not write
    // into: the obligation is held by an execution that still owes settlement.
    const interrupt = await interruptNativeSettlementAfterGeneration(
      f,
      context.signal,
    );
    await accept(triggerAs(f), [200]);
    await accept(tick(f), [200]);
    await expect(readNativeOccurrences(f)).resolves.toMatchObject([
      {
        scheduledFor: afterDailyInstant(),
        settledAt: null,
        deliveryPending: true,
        generationAttemptId: expect.any(String),
      },
    ]);
    await interrupt();
    const held = await readNativeSchedule(f);
    expect(held?.nextRunAt).toBeNull();

    const refused = await accept(triggerAs(f), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_RUN_IN_FLIGHT");
    // The obligation the running execution owes is untouched, so its one
    // settlement still installs the successor rather than discarding it.
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: null,
      ownerEpoch: held?.ownerEpoch,
    });
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(1);
    expect(generation).toHaveLength(1);

    // The interrupted slot recovers through the ordinary tick and settles once.
    await accept(tick(f), [200]);
    const settled = await readNativeOccurrences(f);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.settledAt).not.toBeNull();
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: nextDailyInstant(),
      scheduleOwner: "native",
    });
  });

  it("refuses a second trigger before the minimum interval since the last claim", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    await accept(triggerAs(f), [200]);
    await accept(tick(f), [200]);
    expect(generation).toHaveLength(1);
    const afterFirst = await readNativeSchedule(f);

    mockNow(new Date(afterDailyInstant().getTime() + 60 * 1000));
    const refused = await accept(triggerAs(f), [429]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_TRIGGER_RATE_LIMITED");
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: afterFirst?.nextRunAt,
      ownerEpoch: afterFirst?.ownerEpoch,
    });
    await accept(tick(f), [200]);
    expect(generation).toHaveLength(1);
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(1);

    // Past the interval, the same owner is admitted again.
    mockNow(new Date(afterDailyInstant().getTime() + 16 * 60 * 1000));
    await accept(triggerAs(f), [200]);
    await accept(tick(f), [200]);
    expect(generation).toHaveLength(2);
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(2);
  });

  it("collapses a repeated press before the cron into a single claimed slot", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();

    await accept(triggerAs(f), [200]);
    const second = new Date(afterDailyInstant().getTime() + 2000);
    mockNow(second);
    await accept(triggerAs(f), [200]);
    // No occurrence exists yet, so the second press only re-moved the same
    // obligation. It cannot create a slot of its own.
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);

    await accept(tick(f), [200]);

    const occurrences = await readNativeOccurrences(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.scheduledFor.getTime()).toBe(second.getTime());
    expect(occurrences[0]?.settledAt).not.toBeNull();
    expect(generation).toHaveLength(1);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(1);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: nextDailyInstant(),
      scheduleOwner: "native",
    });
  });

  it("moves only the calling member's obligation", async () => {
    const owner = await nativeOwner();
    const other = await nativeOwner();
    const { generation } = scriptProviders();
    const ownerBefore = await readNativeSchedule(owner);

    // Nothing in the request can name another member: the obligation moved is
    // always the authenticated caller's.
    await accept(triggerAs(other), [200]);

    await expect(readNativeSchedule(other)).resolves.toMatchObject({
      nextRunAt: afterDailyInstant(),
    });
    await expect(readNativeSchedule(owner)).resolves.toMatchObject({
      nextRunAt: ownerBefore?.nextRunAt,
      ownerEpoch: ownerBefore?.ownerEpoch,
    });

    await accept(tick(owner), [200]);
    expect(generation).toHaveLength(0);
    await expect(readNativeOccurrences(owner)).resolves.toHaveLength(0);
  });

  it("takes the durable schedule row lock before it writes", async () => {
    const f = await nativeOwner();
    scriptProviders();
    const hold = await holdNativeScheduleRow(f, context.signal);
    const pending = triggerAs(f);
    // The writer is fenced by the same row every other Morning Brief writer
    // takes, rather than racing it with a bare UPDATE.
    await hold.waitForBlocked(1);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: nextDailyInstant(),
    });
    await hold.release();

    await accept(pending, [200]);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: afterDailyInstant(),
      scheduleOwner: "native",
    });
  });

  it("leaves a disabled owner owing nothing when the trigger commits first", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    const before = await readNativeSchedule(f);

    const raced = await raceOnScheduleRow(
      f,
      () => {
        return triggerAs(f);
      },
      () => {
        return preferenceClient().update({
          headers: { authorization: "Bearer clerk-session" },
          body: { enabled: false },
        });
      },
    );

    expect(raced.first.status).toBe(200);
    expect(raced.second.status).toBe(200);
    // The disable observed the moved obligation and revoked it in the same
    // transaction, so no unowned NULL and no orphaned obligation survive.
    const after = await readNativeSchedule(f);
    expect(after).toMatchObject({
      enabled: false,
      nextRunAt: null,
      scheduleOwner: null,
    });
    expect(after?.ownerEpoch).toBe((before?.ownerEpoch ?? 0) + 1);

    await accept(tick(f), [200]);
    expect(generation).toHaveLength(0);
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);
  });

  it("refuses the trigger when a concurrent Settings disable commits first", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    const before = await readNativeSchedule(f);
    mocks.clerk.session(f.userId, f.orgId);

    const raced = await raceOnScheduleRow(
      f,
      () => {
        return preferenceClient().update({
          headers: { authorization: "Bearer clerk-session" },
          body: { enabled: false },
        });
      },
      () => {
        return triggerAs(f);
      },
    );

    expect(raced.first.status).toBe(200);
    expect(raced.second.status).toBe(409);
    const refused = await accept(Promise.resolve(raced.second), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_DISABLED");
    const after = await readNativeSchedule(f);
    expect(after).toMatchObject({
      enabled: false,
      nextRunAt: null,
      scheduleOwner: null,
    });
    expect(after?.ownerEpoch).toBe((before?.ownerEpoch ?? 0) + 1);

    await accept(tick(f), [200]);
    expect(generation).toHaveLength(0);
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);
  });

  it("recomputes the moved obligation when a timezone-only edit commits after it", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    const before = await readNativeSchedule(f);

    const raced = await raceOnScheduleRow(
      f,
      () => {
        return triggerAs(f);
      },
      () => {
        return userPreferencesClient().update({
          headers: { authorization: "Bearer clerk-session" },
          body: { timezone: "America/New_York" },
        });
      },
    );

    expect(raced.first.status).toBe(200);
    expect(raced.second.status).toBe(200);
    // A timezone edit is deliberately not a revocation: the epoch is untouched
    // and the unconsumed slot is recomputed under the edited recurrence, so the
    // owner still owes exactly one native obligation.
    const after = await readNativeSchedule(f);
    expect(after?.enabled).toBeTruthy();
    expect(after?.timezone).toBe("America/New_York");
    expect(after?.ownerEpoch).toBe(before?.ownerEpoch);
    expect(after?.nextRunAt).not.toBeNull();
    expect(after?.scheduleOwner).toBe("native");

    await accept(tick(f), [200]);
    const occurrences = await readNativeOccurrences(f);
    expect(occurrences.length).toBeLessThanOrEqual(1);
    expect(generation).toHaveLength(occurrences.length);
    for (const occurrence of occurrences) {
      expect(occurrence.settledAt).not.toBeNull();
    }
  });

  it("moves the obligation under the edited timezone when the edit commits first", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    const before = await readNativeSchedule(f);
    mocks.clerk.session(f.userId, f.orgId);

    const raced = await raceOnScheduleRow(
      f,
      () => {
        return userPreferencesClient().update({
          headers: { authorization: "Bearer clerk-session" },
          body: { timezone: "America/New_York" },
        });
      },
      () => {
        return triggerAs(f);
      },
    );

    expect(raced.first.status).toBe(200);
    expect(raced.second.status).toBe(200);
    const after = await readNativeSchedule(f);
    expect(after).toMatchObject({
      enabled: true,
      timezone: "America/New_York",
      nextRunAt: afterDailyInstant(),
      scheduleOwner: "native",
    });
    expect(after?.ownerEpoch).toBe(before?.ownerEpoch);

    await accept(tick(f), [200]);
    const occurrences = await readNativeOccurrences(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.scheduledFor.getTime()).toBe(
      afterDailyInstant().getTime(),
    );
    expect(occurrences[0]?.settledAt).not.toBeNull();
    expect(generation).toHaveLength(1);
    // The successor is recomputed from the settlement clock under the edited
    // timezone, so the owner is left owing exactly one future obligation.
    const settled = await readNativeSchedule(f);
    expect(settled?.nextRunAt?.getTime()).toBeGreaterThan(now());
    expect(settled?.scheduleOwner).toBe("native");
  });

  it("refuses the trigger when a concurrent cron claim takes the slot first", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    await accept(triggerAs(f), [200]);

    const raced = await raceOnScheduleRow(
      f,
      () => {
        return tick(f);
      },
      () => {
        return triggerAs(f);
      },
    );

    expect(raced.first.status).toBe(200);
    expect(raced.second.status).toBe(409);
    const refused = await accept(Promise.resolve(raced.second), [409]);
    expect(refused.body.error.code).toBe("MORNING_BRIEF_RUN_IN_FLIGHT");

    // One claim, one settlement, one delivery, and the successor installed once.
    const occurrences = await readNativeOccurrences(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.scheduledFor.getTime()).toBe(
      afterDailyInstant().getTime(),
    );
    expect(occurrences[0]?.settledAt).not.toBeNull();
    expect(generation).toHaveLength(1);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(1);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: nextDailyInstant(),
      scheduleOwner: "native",
    });
  });

  it("admits exactly one claim when the trigger commits ahead of a cron tick", async () => {
    const f = await nativeOwner();
    const { generation } = scriptProviders();
    await accept(triggerAs(f), [200]);

    const raced = await raceOnScheduleRow(
      f,
      () => {
        return triggerAs(f);
      },
      () => {
        return tick(f);
      },
    );

    expect(raced.first.status).toBe(200);
    expect(raced.second.status).toBe(200);

    const occurrences = await readNativeOccurrences(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.scheduledFor.getTime()).toBe(
      afterDailyInstant().getTime(),
    );
    expect(occurrences[0]?.settledAt).not.toBeNull();
    expect(generation).toHaveLength(1);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(1);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      nextRunAt: nextDailyInstant(),
      scheduleOwner: "native",
    });
  });
});
