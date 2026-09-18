import { randomUUID } from "node:crypto";

import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  bindMorningBriefThreadFixture,
  seedOrdinaryChatThreadFixture$,
} from "../../../test-fixtures/morning-brief-chat-collection";
import { seedInstalledMorningBrief } from "../../../test-fixtures/morning-brief-collection";
import { expireMorningBriefGenerationRetention } from "../../../test-fixtures/morning-brief-generation";
import {
  drainEmailOutbox,
  readEmailOutboxRow,
} from "../../../test-fixtures/morning-brief-delivery";
import {
  abandonClaimedOccurrence,
  countEmailOutboxRows,
  countOrgUsageEvents,
  enqueueUnsentLegacyEmail,
  countOrgAgentRuns,
  deleteLegacyMorningBriefInstallation,
  interruptNativeSettlement,
  makeNativeOccurrenceDue,
  readLegacyAutomation,
  readNativeDeliveries,
  readNativeGenerations,
  readNativeOccurrences,
  readNativeSchedule,
  readThreadEventTypes,
  revokeNativeAuthorityForTest,
  resumableOccurrenceAnchors,
  seedRecipientAddress,
  setLegacyReconciliationState,
} from "../../../test-fixtures/morning-brief-native-schedule";
import { admitWorkflowAutomationEventFixture } from "../../../test-fixtures/workflow-queue";
import { createScopedMorningBriefCronRoutesForTest } from "../cron-execute-morning-briefs";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { mockClerkUsers } from "./helpers/clerk-users";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

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
const mocks = createRouteMocks(context);
const store = createStore();

const CRON_SECRET = "native-morning-brief-cron-secret";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

beforeEach(() => {
  // The shared sender calls the globally mocked Resend SDK rather than HTTP, so
  // this is the boundary every email assertion below observes.
  context.mocks.resend.send.mockReset();
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-${randomUUID()}` },
    error: null,
  });
});

afterEach(() => {
  clearMockNow();
});

/** Every argument list the shared sender handed the Resend SDK boundary. */
function emailSends(): readonly Record<string, unknown>[] {
  return context.mocks.resend.send.mock.calls.map((call) => {
    return call[0] as Record<string, unknown>;
  });
}

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

function tick(owner: Fixture, secret: string = CRON_SECRET) {
  return cronClient(owner).execute({
    headers: { authorization: `Bearer ${secret}` },
  });
}

function preferenceClient() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
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
  // The shared one-click unsubscribe link must be an https API URL, which the
  // real drain validates before it hands anything to the provider.
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
  if (options.email !== null) {
    // The shared drain resolves the recipient's live profile through Clerk
    // before it hands anything to the provider.
    mockClerkUsers(context, [
      {
        id: userId,
        primaryEmailAddressId: "idn_primary",
        emailAddresses: [
          {
            id: "idn_primary",
            emailAddress: options.email ?? `${userId}@example.test`,
          },
        ],
      },
    ]);
    await seedRecipientAddress(
      userId,
      options.email ?? `${userId}@example.test`,
    );
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
}

/** Script both provider boundaries and count every crossing request. */
function scriptProviders(outcome: "deliver" | "provider-failure" = "deliver"): {
  readonly calls: ProviderCalls;
} {
  const calls: ProviderCalls = { generation: [] };
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      calls.generation.push(await request.text());
      if (outcome === "provider-failure") {
        return HttpResponse.json(
          { error: { message: "upstream unavailable" } },
          { status: 503 },
        );
      }
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
  );
  return { calls };
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

describe("native Morning Brief cron", () => {
  it("performs zero work without a valid cron secret", async () => {
    const f = await fixture();
    const { calls } = scriptProviders();

    await accept(tick(f, "wrong-secret"), [401]);

    expect(calls.generation).toHaveLength(0);
    await expect(readNativeSchedule(f)).resolves.toBeUndefined();
  });

  it("materializes an installed brief as a legacy-phase row and cuts over", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();

    // The first tick may only bootstrap and start the cutover; it must never
    // take a member straight from "installed" to "native work admitted".
    const first = await accept(tick(f), [200]);
    expect(first.body.materialized).toBe(1);

    const bootstrapped = await readNativeSchedule(f);
    // Bootstrap itself only writes a `legacy` row; the same tick's separate
    // transition pass may already have closed legacy admission. Neither step
    // admits native work, which is the invariant that matters here.
    expect(["legacy", "draining"]).toContain(bootstrapped?.phase);
    expect(bootstrapped?.enabled).toBeTruthy();
    expect(bootstrapped?.timezone).toBe("Asia/Shanghai");
    expect(bootstrapped?.legacyAutomationId).toBe(f.automationId);
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);

    // Later ticks converge on the switch's current intent. The legacy poller's
    // own admission instant is cleared in the same transaction that enters
    // `draining`, and no native occurrence exists until the transfer commits.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const schedule = await readNativeSchedule(f);
      if (schedule?.phase === "native") {
        break;
      }
      await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);
      await accept(tick(f), [200]);
    }

    const cutover = await readNativeSchedule(f);
    expect(cutover?.phase).toBe("native");
    expect(cutover?.scheduleOwner).toBe("native");
    expect(cutover?.nextRunAt).not.toBeNull();
    // The transfer bumped the epoch exactly once; nothing manufactured extras.
    expect(cutover?.ownerEpoch).toBe(2);
    // Legacy can no longer admit a claim for this member.
    expect((await readLegacyAutomation(f.automationId))?.nextRunAt).toBeNull();
    // The user's own choice is untouched by the cutover.
    expect((await readLegacyAutomation(f.automationId))?.enabled).toBeTruthy();
    expect(cutover?.enabled).toBeTruthy();
  });

  it("holds cutover for an unjournaled legacy queue event instead of guessing its anchor", async () => {
    const f = await fixture();
    const chatThreadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      { member: f, title: "Legacy Morning Brief queue" },
      context.signal,
    );
    await bindMorningBriefThreadFixture({
      orgId: f.orgId,
      userId: f.userId,
      workflowId: f.workflowId,
      chatThreadId,
    });
    await admitWorkflowAutomationEventFixture({
      automationId: f.automationId,
      chatThreadId,
      triggerBrief: "unjournaled-legacy-queue-event",
    });

    // The first tick closes legacy admission; the next bounded transition pass
    // resolves the actual queue relationship and records why ownership stays.
    await accept(tick(f), [200]);
    await accept(tick(f), [200]);

    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      phase: "draining",
      scheduleOwner: "legacy",
      drainUnresolvedReason: "legacy-queue-event-pending",
    });
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);
    expect((await readLegacyAutomation(f.automationId))?.nextRunAt).toBeNull();
  });

  it("runs collection, one platform generation, Chat and shared email with the legacy scheduler disabled", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await tickUntilNative(f);

    // The legacy scheduler is now closed for this member. Remove its live
    // Workflow entirely: native collection and delivery retain lineage only
    // and must continue from their durable choice, destination and epoch.
    expect((await readLegacyAutomation(f.automationId))?.nextRunAt).toBeNull();
    expect((await readNativeSchedule(f))?.phase).toBe("native");
    await deleteLegacyMorningBriefInstallation(f.workflowId);
    await expect(readLegacyAutomation(f.automationId)).resolves.toBeUndefined();
    const due = await makeNativeOccurrenceDue(f);

    const executed = await accept(tick(f), [200]);
    expect(executed.body.claimed).toBe(1);
    expect(executed.body.settled).toBe(1);

    // Exactly one platform request, for the production purpose.
    expect(calls.generation).toHaveLength(1);
    const generations = await readNativeGenerations(f);
    expect(generations).toHaveLength(1);
    expect(generations[0]?.executionPurpose).toBe("production");
    expect(generations[0]?.state).toBe("succeeded");
    expect(generations[0]?.model).toBe("google/gemini-3.8-flash");

    // One canonical Chat delivery, recorded under the production purpose.
    const deliveries = await readNativeDeliveries(f);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.executionPurpose).toBe("production");
    const threadId = deliveries[0]?.chatThreadId;
    expect(threadId).toBeDefined();
    await expect(readThreadEventTypes(threadId ?? "")).resolves.toStrictEqual([
      "output.message",
    ]);

    // One shared-outbox email intent for the same accepted body.
    await expect(
      countEmailOutboxRows(deliveries[0]?.emailOutboxId ?? randomUUID()),
    ).resolves.toBe(1);

    // The slot settled exactly once, keeping its frozen anchor, and the next
    // occurrence is strictly in the future.
    const occurrences = await readNativeOccurrences(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.outcome).toBe("delivered");
    expect(occurrences[0]?.scheduledFor.getTime()).toBe(due.getTime());
    expect(occurrences[0]?.settledAt).not.toBeNull();
    const after = await readNativeSchedule(f);
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(now());

    // Zero Run and zero user-credit footprint.
    await expect(countOrgAgentRuns(f.orgId)).resolves.toBe(0);
  });

  // The crash this covers is the one the durable receipt exists for: Chat and
  // its receipt COMMIT, then the process dies before the native settlement.
  // The row is put back into exactly that state — attempt bound, delivery
  // pending, settlement absent — rather than seeding any synthetic result.
  it("recovers a delivered brief whose settlement crashed after the chat receipt", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await tickUntilNative(f);
    const due = await makeNativeOccurrenceDue(f);
    await accept(tick(f), [200]);
    expect(calls.generation).toHaveLength(1);
    const beforeCrash = await readNativeOccurrences(f);
    expect(beforeCrash[0]?.generationAttemptId).not.toBeNull();

    // Unwind only the settlement. Everything the delivery committed stays, and
    // the claimant's lease is still held, which is exactly what a process that
    // died between the Chat COMMIT and its own settlement leaves behind.
    // And the accepted result is past its retention, so recovery cannot lean
    // on it: only the durable receipt can prove the brief was delivered.
    await expireMorningBriefGenerationRetention(
      { orgId: f.orgId, userId: f.userId },
      new Date(now() - 1000),
    );
    await interruptNativeSettlement(f, {
      scheduledFor: due,
      leaseToken: randomUUID(),
    });

    const recovery = await accept(tick(f), [200]);
    expect(recovery.body.deliveriesRecovered).toBe(1);

    // Recovered from the durable receipt: no second model request, no second
    // Chat event, no second delivery, and the slot settles exactly once.
    expect(calls.generation).toHaveLength(1);
    const deliveries = await readNativeDeliveries(f);
    expect(deliveries).toHaveLength(1);
    await expect(
      readThreadEventTypes(deliveries[0]?.chatThreadId ?? ""),
    ).resolves.toHaveLength(1);
    const settled = await readNativeOccurrences(f);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome).toBe("delivered");
    expect(settled[0]?.settledAt).not.toBeNull();
    expect(settled[0]?.deliveryPending).toBeFalsy();
    // The member owes a future occurrence again, from the settlement clock.
    const after = await readNativeSchedule(f);
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(now());
  });

  // The counterexample the receipt pass cannot answer on its own: a bound,
  // unsettled slot whose receipt recovery has not resolved yet — in production
  // because it fell beyond the bounded recovery batch. Resuming such a slot
  // would call S5 first, and after the real result sweep a completed collection
  // with no generation reads as a healthy empty day, bypassing a Chat receipt
  // that has already committed. It must therefore never be resumable.
  it("settles a known provider failure once without another POST", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders("provider-failure");
    await tickUntilNative(f);
    await makeNativeOccurrenceDue(f);

    await accept(tick(f), [200]);
    await accept(tick(f), [200]);

    expect(calls.generation).toHaveLength(1);
    await expect(readNativeOccurrences(f)).resolves.toMatchObject([
      {
        state: "settled",
        outcome: "generation-failed",
        settledAt: expect.any(Date),
        deliveryPending: false,
      },
    ]);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(0);
  });

  it("never resumes a bound unsettled slot into generation", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await tickUntilNative(f);
    const due = await makeNativeOccurrenceDue(f);
    await accept(tick(f), [200]);
    expect(calls.generation).toHaveLength(1);

    // Put the slot back into the bound-but-unsettled state, with its lease
    // expired so the resume scan would otherwise pick it up, and sweep the
    // result so a resumed slot would misclassify it.
    await expireMorningBriefGenerationRetention(
      { orgId: f.orgId, userId: f.userId },
      new Date(now() - 1000),
    );
    await interruptNativeSettlement(f, {
      scheduledFor: due,
      leaseToken: randomUUID(),
    });

    // The occurrence is not reachable by resume at all, whether or not the
    // receipt pass handled it this tick.
    await expect(resumableOccurrenceAnchors(f)).resolves.toStrictEqual([]);

    await accept(tick(f), [200]);

    // Whatever the recovery pass decided, no second generation was started and
    // the committed receipt was never re-read as an empty day.
    expect(calls.generation).toHaveLength(1);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(1);
    const rows = await readNativeOccurrences(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).not.toBe("empty-skip");
  });

  // The email half of the product contract, through the real shared worker: the
  // scheduler only enqueues an intent, and S2's drain is what actually sends.
  // Asserting the enqueue alone would never show a provider request.
  it("sends the subscribed brief through the real shared email drain with no user billing", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await expect(countOrgUsageEvents(f.orgId)).resolves.toBe(0);

    await tickUntilNative(f);
    await makeNativeOccurrenceDue(f);
    await accept(tick(f), [200]);

    const deliveries = await readNativeDeliveries(f);
    expect(deliveries).toHaveLength(1);
    const outboxId = deliveries[0]?.emailOutboxId;
    expect(outboxId).not.toBeNull();
    expect(emailSends()).toHaveLength(0);

    // Now the real drain, on the exact row the delivery admitted.
    await drainEmailOutbox([outboxId ?? ""], context.signal);

    // One request crossed the provider boundary, carrying the accepted brief.
    const sends = emailSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toBe(`${f.userId}@example.test`);
    expect(sends[0]?.subject).toBe("Release readiness");

    // Platform-funded throughout: one model request, no agent Run, and no
    // usage row that could debit this organization.
    expect(calls.generation).toHaveLength(1);
    await expect(countOrgAgentRuns(f.orgId)).resolves.toBe(0);
    await expect(countOrgUsageEvents(f.orgId)).resolves.toBe(0);
  });

  it("fences a queued native email after its owner epoch is revoked", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    await tickUntilNative(f);
    await makeNativeOccurrenceDue(f);
    await accept(tick(f), [200]);

    const [delivery] = await readNativeDeliveries(f);
    const outboxId = delivery?.emailOutboxId;
    if (!outboxId) {
      throw new Error("Expected the native delivery to queue an email");
    }
    await revokeNativeAuthorityForTest(f);
    await drainEmailOutbox([outboxId], context.signal);

    expect(emailSends()).toHaveLength(0);
    await expect(readEmailOutboxRow(outboxId)).resolves.toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("authority was revoked"),
    });
  });

  it("commits a native Settings pause with the retained rollback choice", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    await tickUntilNative(f);
    mocks.clerk.session(f.userId, f.orgId);

    const paused = await accept(
      preferenceClient().update({
        headers: { authorization: "Bearer clerk-session" },
        body: { enabled: false },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({
      enabled: false,
      status: "paused",
      nextRunAt: null,
    });
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
      scheduleOwner: null,
    });
    await expect(readLegacyAutomation(f.automationId)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
  });

  it("does not contact the provider twice for the same slot across ticks", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await tickUntilNative(f);
    await makeNativeOccurrenceDue(f);
    await accept(tick(f), [200]);
    expect(calls.generation).toHaveLength(1);

    // A later tick finds the slot settled and its successor in the future.
    const repeat = await accept(tick(f), [200]);
    expect(repeat.body.claimed).toBe(0);
    expect(calls.generation).toHaveLength(1);
    await expect(readNativeGenerations(f)).resolves.toHaveLength(1);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(1);
  });

  // The pre-POST fence. The revocation lands at an observed barrier — the first
  // Slack read, which happens during collection and before the reservation —
  // so the claim this slot was admitted under is already stale by the time S5
  // would reserve. Nothing here sleeps and nothing seeds a result.
  it("makes no platform request when the claim is revoked before the reservation", async () => {
    const f = await fixture();
    const { calls } = scriptProviders();
    let revoked = false;
    server.use(
      http.get(SLACK_CONVERSATIONS_URL, async () => {
        if (!revoked) {
          revoked = true;
          await revokeNativeAuthorityForTest(f);
        }
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C100", name: "general", is_private: false }],
          response_metadata: { next_cursor: "" },
        });
      }),
      http.get("https://slack.com/api/conversations.replies", () => {
        return HttpResponse.json({ ok: true, messages: [] });
      }),
      http.get(SLACK_HISTORY_URL, () => {
        const anchorSeconds = Math.floor(now() / 1000) - 3600;
        return HttpResponse.json({
          ok: true,
          messages: [
            {
              type: "message",
              ts: `${anchorSeconds}.000100`,
              user: "U1",
              text: "ship the release",
            },
          ],
        });
      }),
    );

    await tickUntilNative(f);
    await makeNativeOccurrenceDue(f);
    expect(revoked).toBeFalsy();

    await accept(tick(f), [200]);

    // Collection ran, the revocation landed inside it, and the reservation
    // refused: no request crossed the provider boundary and no generation row
    // was left behind for a later replay to reconcile.
    expect(revoked).toBeTruthy();
    expect(calls.generation).toHaveLength(0);
    await expect(readNativeGenerations(f)).resolves.toHaveLength(0);
    await expect(readNativeDeliveries(f)).resolves.toHaveLength(0);
  });

  // Switching off must stop new admission without stranding work the scheduler
  // already recorded. An abandoned claim is exactly what the rollback drain
  // waits on, so if the switch also excluded it from recovery the member could
  // never return to legacy.
  it("reconciles abandoned native work and completes the rollback after switch-off", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    await tickUntilNative(f);
    const due = await makeNativeOccurrenceDue(f);
    await accept(tick(f), [200]);
    expect(calls.generation).toHaveLength(1);

    // A worker that died before contacting the provider: claimed, unsettled,
    // nothing bound, lease long gone.
    await abandonClaimedOccurrence(f, due);
    await updateFeatureSwitchesForUser(
      context,
      { orgId: f.orgId, userId: f.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await accept(tick(f), [200]);
      if ((await readNativeSchedule(f))?.phase === "legacy") {
        break;
      }
    }

    const rolled = await readNativeSchedule(f);
    expect(rolled?.phase).toBe("legacy");
    // Every recorded obligation was settled rather than abandoned, and the
    // member owes a future occurrence again under the restored owner.
    const occurrences = await readNativeOccurrences(f);
    expect(
      occurrences.every((row) => {
        return row.settledAt !== null;
      }),
    ).toBeTruthy();
    expect(rolled?.scheduleOwner).toBe("legacy");
    expect(rolled?.nextRunAt?.getTime()).toBeGreaterThan(now());
    // Reconciliation is not admission: no second brief was generated.
    expect(calls.generation).toHaveLength(1);
  });

  // Clearing the legacy poller's due instant stops new claims but cannot retract
  // mail the old path already queued. An unsent legacy intent is reachable work,
  // so the cutover has to hold rather than hand the schedule to native.
  it("holds rollback until the retained legacy target is reconciled", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    await tickUntilNative(f);

    // Official reconciliation can temporarily pause the retained legacy row
    // while native remains authoritative. Switch-off must not hand an enabled
    // choice to that unusable target or silently expose the pause as user intent.
    await setLegacyReconciliationState(f.automationId, "paused");
    await updateFeatureSwitchesForUser(
      context,
      { orgId: f.orgId, userId: f.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );
    await accept(tick(f), [200]);
    await accept(tick(f), [200]);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      enabled: true,
      phase: "rollback-draining",
      target: "legacy",
      scheduleOwner: "native",
      drainUnresolvedReason: "legacy-target-not-ready",
    });
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);

    await setLegacyReconciliationState(f.automationId, "current");
    await accept(tick(f), [200]);
    const rolledBack = await readNativeSchedule(f);
    const legacy = await readLegacyAutomation(f.automationId);
    expect(rolledBack).toMatchObject({
      enabled: true,
      phase: "legacy",
      target: "legacy",
      scheduleOwner: "legacy",
      nextRunAt: expect.any(Date),
    });
    expect(legacy).toMatchObject({
      enabled: true,
      officialIntendedEnabled: true,
      cronExpression: rolledBack?.cronExpression,
      timezone: rolledBack?.timezone,
      nextRunAt: rolledBack?.nextRunAt,
    });
  });

  it("holds the cutover while a legacy email intent is still unsent", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();

    const outboxId = await enqueueUnsentLegacyEmail(
      f.automationId,
      `${f.userId}@example.test`,
      f.userId,
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await accept(tick(f), [200]);
    }

    const held = await readNativeSchedule(f);
    expect(held?.phase).toBe("draining");
    expect(held?.drainUnresolvedReason).toBe("legacy-outbox-unsent");
    // Nothing native was admitted while that mail was outstanding.
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);
    expect(calls.generation).toHaveLength(0);

    // Once the shared drain actually sends it, the same ticks converge.
    await drainEmailOutbox([outboxId], context.signal);
    await tickUntilNative(f);
    await expect(readNativeSchedule(f)).resolves.toMatchObject({
      phase: "native",
    });
  });

  it("admits no native occurrence while the implementation switch is off", async () => {
    const f = await fixture({ feature: false });
    scriptSlack();
    const { calls } = scriptProviders();

    await accept(tick(f), [200]);
    await accept(tick(f), [200]);

    const schedule = await readNativeSchedule(f);
    expect(schedule?.phase).toBe("legacy");
    await expect(readNativeOccurrences(f)).resolves.toHaveLength(0);
    expect(calls.generation).toHaveLength(0);
    // The member's own legacy admission was never closed.
    expect(
      (await readLegacyAutomation(f.automationId))?.nextRunAt,
    ).not.toBeNull();
  });
});
