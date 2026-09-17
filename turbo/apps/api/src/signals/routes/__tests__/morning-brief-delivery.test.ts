import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { morningBriefDeliveryPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-delivery-preview";
import { morningBriefGenerationPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { createStore } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { db } from "../../../lib/db";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  pauseMorningBriefAutomation,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-collection";
import { expireMorningBriefGenerationRetention } from "../../../test-fixtures/morning-brief-generation";
import { rejectEmailOutboxCompletion } from "../../../test-fixtures/email-outbox";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { deleteChatThread$ } from "../../services/chat-thread.service";
import { drainEmailOutboxItems$ } from "../../services/email-common.service";
import { revokeMorningBriefDeliveryOwnership } from "../../services/morning-brief-delivery.service";
import { morningBriefDeliveryPreviewRoutes } from "../morning-brief-delivery-preview";
import { morningBriefGenerationPreviewRoutes } from "../morning-brief-generation-preview";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";

/**
 * Delivery exercised end to end through the real application routes.
 *
 * Every test here produces its accepted result by running the actual S5
 * generation preview against a scripted provider boundary, then hands that
 * result's own reference to the real delivery route. Nothing seeds a
 * generation row directly, and no authorizer is mocked: the Slack, OpenRouter
 * and Resend HTTP boundaries are the only doubles, so the ownership,
 * membership, installation and email decisions under test are the production
 * ones.
 */

const context = testContext();
const store = createStore();

const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();
const WINDOW_START_SECONDS = (ANCHOR_MS - 24 * 60 * 60 * 1000) / 1000;

beforeEach(() => {
  // The shared sender calls the globally mocked Resend SDK, not HTTP, so this
  // is the boundary every email assertion here observes.
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
  readonly headers: { readonly authorization: string };
}

function deliveryClient() {
  return setupApp({ context, routes: morningBriefDeliveryPreviewRoutes })(
    morningBriefDeliveryPreviewContract,
  );
}

function generationClient() {
  return setupApp({ context, routes: morningBriefGenerationPreviewRoutes })(
    morningBriefGenerationPreviewContract,
  );
}

function agentToken(
  userId: string,
  orgId: string,
  capabilities: readonly Capability[] = ["slack:read", "agent:write"],
): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: randomUUID(),
      capabilities,
      iat: seconds,
      exp: seconds + 3600,
    })}`,
  };
}

async function fixture(
  options: {
    readonly feature?: boolean;
    readonly email?: string | null;
    readonly capabilities?: readonly Capability[];
  } = {},
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
  mockOptionalEnv("OPENROUTER_API_KEY", "platform-openrouter-key");
  mockEnv("RESEND_API_KEY", "platform-resend-key");
  mockEnv("RESEND_FROM_DOMAIN", "mail.okou.test");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  // The shared one-click unsubscribe link must be an https API URL; the native
  // template reuses the same policy the legacy one enforces.
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
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
    headers: agentToken(userId, orgId, options.capabilities),
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
      return HttpResponse.json(
        channel === "C100"
          ? {
              ok: true,
              messages: [
                {
                  type: "message",
                  ts: `${WINDOW_START_SECONDS + 120}.000100`,
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

/** Every argument list the shared sender handed the Resend SDK boundary. */
function emailSends(): readonly {
  readonly payload: Record<string, unknown>;
  readonly options: { readonly idempotencyKey?: string };
}[] {
  return context.mocks.resend.send.mock.calls.map((call) => {
    return {
      payload: call[0] as Record<string, unknown>,
      options: (call[1] ?? {}) as { readonly idempotencyKey?: string },
    };
  });
}

/**
 * Script both provider boundaries and count every request that crosses them.
 *
 * The generation count is what proves delivery never regenerates, and the
 * email count is what proves one logical intent reaches Resend once.
 */
function scriptProviders(options: { readonly deliverTitle?: string } = {}): {
  readonly calls: ProviderCalls;
} {
  const calls: ProviderCalls = { generation: [] };
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      calls.generation.push(await request.text());
      return HttpResponse.json({
        id: "gen-01H0DELIVERY",
        model: "google/gemini-3.8-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                decision: "deliver",
                title: options.deliverTitle ?? "Release readiness",
                sections: [
                  {
                    heading: "Decisions",
                    items: [
                      {
                        text: "The release ships today.",
                        sourceIds: ["m1"],
                      },
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

/** Produce one real accepted result and return its own reference. */
async function generateAcceptedResult(f: Fixture): Promise<string> {
  const response = await accept(
    generationClient().preview({
      headers: f.headers,
      body: { scheduledFor: ANCHOR },
    }),
    [200],
  );
  if (
    response.body.result !== "generated" ||
    response.body.generation === undefined
  ) {
    throw new Error(`Expected a generated result, got ${response.body.result}`);
  }
  return response.body.generation.attemptId;
}

function deliver(f: Fixture, resultAttemptId: string, signal?: AbortSignal) {
  return deliveryClient().preview({
    headers: f.headers,
    body: { resultAttemptId },
    ...(signal === undefined ? {} : { fetchOptions: { signal } }),
  });
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

async function readThreadEvents(threadId: string) {
  const rows = await db()
    .select({
      id: chatEvents.id,
      eventType: chatEvents.eventType,
      runId: chatEvents.runId,
      payload: chatEvents.payload,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(eq(chatEvents.chatThreadId, threadId))
    .orderBy(asc(chatEvents.seqId));
  return rows.map((row) => {
    const payload = row.payload as { content?: string } | null;
    return { ...row, content: payload?.content ?? null };
  });
}

async function readOutbox(f: Fixture) {
  const deliveries = await readDeliveries(f);
  const ids = deliveries.flatMap((row) => {
    return row.emailOutboxId === null ? [] : [row.emailOutboxId];
  });
  if (ids.length === 0) {
    return [];
  }
  return await db()
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.id, ids[0]!));
}

describe("Morning Brief native delivery", () => {
  it("delivers one accepted result to Chat and the shared outbox once", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    expect(calls.generation).toHaveLength(1);

    const response = await accept(deliver(f, attemptId), [200]);
    expect(response.body.result).toBe("delivered");
    expect(response.body.delivery.emailResolution).toBe("enqueued");

    // Delivery never regenerates: the provider saw exactly the one request the
    // generation step made.
    expect(calls.generation).toHaveLength(1);

    const [receipt, ...extraReceipts] = await readDeliveries(f);
    expect(extraReceipts).toHaveLength(0);
    expect(receipt?.chatEventId).toBe(response.body.delivery.chatEventId);
    expect(receipt?.executionPurpose).toBe("preview");
    expect(receipt?.workflowId).toBe(f.workflowId);
    expect(receipt?.automationId).toBe(f.automationId);

    const events = await readThreadEvents(response.body.delivery.chatThreadId);
    const delivered = events.filter((event) => {
      return event.id === response.body.delivery.chatEventId;
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.eventType).toBe("output.message");
    // No fabricated Run, and no Run lifecycle event anywhere in the thread.
    expect(delivered[0]?.runId).toBeNull();
    expect(
      events.filter((event) => {
        return event.eventType.startsWith("run.");
      }),
    ).toHaveLength(0);

    // The thread is the member's own Morning Brief thread, and it carries the
    // sticky exclusion so tomorrow's brief cannot summarise this one.
    const [thread] = await db()
      .select({
        userId: chatThreads.userId,
        agentId: chatThreads.agentId,
        provenance: chatThreads.provenance,
        lastMessageAt: chatThreads.lastMessageAt,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, response.body.delivery.chatThreadId));
    expect(thread?.userId).toBe(f.userId);
    expect(thread?.agentId).toBe(f.agentId);
    expect(thread?.provenance).toBe("morning_brief");
    expect(thread?.lastMessageAt?.getTime()).toBe(
      new Date(response.body.delivery.deliveredAt).getTime(),
    );

    // The same accepted body reaches the outbox, and the shared drain sends it
    // once through the provider boundary.
    const [queued] = await readOutbox(f);
    expect(queued?.status).toBe("pending");
    const template = queued?.template as {
      template: string;
      props: {
        title: string;
        resultMarkdown: string;
        threadUrl: string;
        manageUrl: string;
      };
    };
    expect(template.template).toBe("morning-brief-result");
    expect(template.props.resultMarkdown).toBe(delivered[0]?.content);

    // The shared drain renders and sends that same intent through the real
    // provider boundary, and records the delivered state.
    await store.set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: [queued!.id] },
      context.signal,
    );
    const sends = emailSends();
    expect(sends).toHaveLength(1);
    const sent = sends[0]!;
    expect(sent.payload["to"]).toStrictEqual(`${f.userId}@example.test`);
    expect(sent.payload["from"]).toContain("@mail.okou.test");
    expect(sent.payload["subject"]).toBe("Release readiness");
    // One accepted body, identical across Chat, plain text and HTML.
    expect(sent.payload["html"]).toContain("The release ships today.");
    expect(sent.payload["text"]).toContain("The release ships today.");
    const headers = sent.payload["headers"] as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toContain(
      "https://api.okou.test/api/email/unsubscribe",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // S2 owns the provider key; a replay must reuse exactly this one.
    expect(sent.options.idempotencyKey).toMatch(
      /^okou-email-outbox\/v1\/[0-9a-f-]{36}$/,
    );

    const [drained] = await db()
      .select({
        status: emailOutbox.status,
        resendId: emailOutbox.resendId,
        providerIdempotencyKey: emailOutbox.providerIdempotencyKey,
      })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    expect(drained?.status).toBe("sent");
    expect(drained?.resendId).toBeTruthy();
    expect(drained?.providerIdempotencyKey).toBe(sent.options.idempotencyKey);
  });

  it("returns the same delivery to a repeated request without a second message", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();
    const attemptId = await generateAcceptedResult(f);

    const first = await accept(deliver(f, attemptId), [200]);
    const second = await accept(deliver(f, attemptId), [200]);

    expect(first.body.result).toBe("delivered");
    expect(second.body.result).toBe("already-delivered");
    expect(second.body.delivery).toStrictEqual(first.body.delivery);
    expect(calls.generation).toHaveLength(1);
    expect(await readDeliveries(f)).toHaveLength(1);
    const events = await readThreadEvents(first.body.delivery.chatThreadId);
    expect(
      events.filter((event) => {
        return event.eventType === "output.message";
      }),
    ).toHaveLength(1);
    expect(await readOutbox(f)).toHaveLength(1);
  });

  it("recovers a committed delivery after its source result expires", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    const first = await accept(deliver(f, attemptId), [200]);

    // The generation's own bounded retention elapses. The delivery identity has
    // to outlive it, or a replay would look undelivered.
    await expireMorningBriefGenerationRetention(
      { orgId: f.orgId, userId: f.userId },
      new Date(now() - 1000),
    );

    const replay = await accept(deliver(f, attemptId), [200]);
    expect(replay.body.result).toBe("already-delivered");
    expect(replay.body.delivery).toStrictEqual(first.body.delivery);
    expect(await readDeliveries(f)).toHaveLength(1);
  });

  it("refuses an expired result that was never delivered", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await expireMorningBriefGenerationRetention(
      { orgId: f.orgId, userId: f.userId },
      new Date(now() - 1000),
    );

    const response = await accept(deliver(f, attemptId), [409]);
    expect(response.body.error.code).toBe("MORNING_BRIEF_RESULT_EXPIRED");
    expect(await readDeliveries(f)).toHaveLength(0);
  });

  it("refuses another member's result reference", async () => {
    const owner = await fixture();
    const stranger = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(owner);

    // The 404 response shares its shape with the production environment gate,
    // so a foreign reference is answered exactly like an absent endpoint.
    const response = await accept(deliver(stranger, attemptId), [404]);
    expect(response.body).not.toBe("Not found");
    expect(JSON.stringify(response.body)).toContain("NOT_FOUND");
    expect(await readDeliveries(owner)).toHaveLength(0);
    expect(await readDeliveries(stranger)).toHaveLength(0);
  });

  it("refuses to deliver after the brief is disabled", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await pauseMorningBriefAutomation(f.automationId);

    const response = await accept(deliver(f, attemptId), [409]);
    expect(response.body.error.code).toBe("MORNING_BRIEF_UNAVAILABLE");
    expect(await readDeliveries(f)).toHaveLength(0);
  });

  it("still delivers to Chat when the recipient has opted out", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await db()
      .insert(users)
      .values({ id: f.userId, emailUnsubscribed: true })
      .onConflictDoUpdate({
        target: users.id,
        set: { emailUnsubscribed: true },
      });

    const response = await accept(deliver(f, attemptId), [200]);
    expect(response.body.delivery.emailResolution).toBe("unsubscribed");
    const events = await readThreadEvents(response.body.delivery.chatThreadId);
    expect(
      events.filter((event) => {
        return event.id === response.body.delivery.chatEventId;
      }),
    ).toHaveLength(1);
    expect(await readOutbox(f)).toHaveLength(0);
    expect(emailSends()).toHaveLength(0);
  });

  it("records a suppressed recipient instead of queueing mail", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    await db()
      .insert(emailSuppressions)
      .values({
        emailAddress: `${f.userId}@example.test`,
        reason: "bounce",
      })
      .onConflictDoNothing();
    const attemptId = await generateAcceptedResult(f);

    const response = await accept(deliver(f, attemptId), [200]);
    expect(response.body.delivery.emailResolution).toBe("suppressed");
    expect(await readOutbox(f)).toHaveLength(0);
  });

  it("records no_email rather than refilling an erased user cache", async () => {
    const f = await fixture({ email: null });
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);

    const response = await accept(deliver(f, attemptId), [200]);
    expect(response.body.delivery.emailResolution).toBe("no_email");
    const cached = await db()
      .select({ userId: userCache.userId })
      .from(userCache)
      .where(eq(userCache.userId, f.userId));
    expect(cached).toHaveLength(0);
  });

  it("removes the unsent intent and its delivery when the owner is deleted", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    const delivered = await accept(deliver(f, attemptId), [200]);
    const [queued] = await readOutbox(f);
    expect(queued).toBeDefined();

    const untouched = await db()
      .insert(emailOutbox)
      .values({
        fromAddress: "Okou <okou@mail.okou.test>",
        toAddresses: "other@example.test",
        subject: "unrelated",
        template: {
          template: "data-export-ready",
          props: {
            downloadUrl: "https://x.test",
            expiresAt: "",
            artifactCount: 0,
          },
        },
        status: "pending",
        attempts: 0,
      })
      .returning({ id: emailOutbox.id });

    await db().transaction(async (tx) => {
      await revokeMorningBriefDeliveryOwnership(tx, {
        kind: "membership",
        orgId: f.orgId,
        userId: f.userId,
      });
    });

    expect(await readDeliveries(f)).toHaveLength(0);
    const remaining = await db()
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    expect(remaining).toHaveLength(0);
    // Another producer's queued mail is untouched.
    const other = await db()
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, untouched[0]!.id));
    expect(other).toHaveLength(1);
    // The Chat message the owner already received is not rewritten by cleanup.
    const events = await readThreadEvents(delivered.body.delivery.chatThreadId);
    expect(
      events.filter((event) => {
        return event.id === delivered.body.delivery.chatEventId;
      }),
    ).toHaveLength(1);
  });

  it("fails a native intent closed once its delivery provenance is gone", async () => {
    const f = await fixture();
    scriptSlack();
    const { calls } = scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await accept(deliver(f, attemptId), [200]);
    const [queued] = await readOutbox(f);

    // The provenance disappears without the mail being cleaned up — the case
    // the drain must never turn into a generic send.
    await db()
      .delete(morningBriefDeliveries)
      .where(eq(morningBriefDeliveries.orgId, f.orgId));

    await store.set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: [queued!.id] },
      context.signal,
    );
    expect(emailSends()).toHaveLength(0);
    const [resolved] = await db()
      .select({ status: emailOutbox.status, lastError: emailOutbox.lastError })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    expect(resolved?.status).toBe("failed");
    expect(resolved?.lastError).toContain("native delivery provenance");
  });

  it("refuses delivery while the implementation switch is off", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await updateFeatureSwitchesForUser(
      context,
      { orgId: f.orgId, userId: f.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );

    const response = await accept(deliver(f, attemptId), [409]);
    expect(response.body.error.code).toBe(
      "MORNING_BRIEF_IMPLEMENTATION_DISABLED",
    );
    expect(await readDeliveries(f)).toHaveLength(0);
  });

  it("answers 404 in production before doing any authentication work", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    mockEnv("ENV", "production");

    // The switch stays on for this caller: the environment gate, not the
    // feature, is what makes the endpoint absent.
    const denied = await accept(deliver(f, attemptId), [404]);
    expect(denied.body).toBe("Not found");
    expect(await readDeliveries(f)).toHaveLength(0);

    // The same request without any credential is equally absent, so production
    // discloses nothing by answering before authentication.
    const anonymous = await accept(
      deliveryClient().preview({
        headers: { authorization: "" },
        body: { resultAttemptId: attemptId },
      }),
      [404],
    );
    expect(anonymous.body).toBe("Not found");
  });

  it("keeps a generic sibling and expiry cleanup moving when the owner lookup fails", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await accept(deliver(f, attemptId), [200]);
    const [queued] = await readOutbox(f);

    // A generic producer's item, unrelated to Morning Brief.
    const [sibling] = await db()
      .insert(emailOutbox)
      .values({
        fromAddress: "Okou <okou@mail.okou.test>",
        toAddresses: "sibling@example.test",
        subject: "unrelated",
        template: {
          template: "data-export-ready",
          props: {
            downloadUrl: "https://x.test",
            expiresAt: "",
            artifactCount: 0,
          },
        },
        status: "pending",
        attempts: 0,
      })
      .returning({ id: emailOutbox.id });

    // The remote membership lookup fails for the native owner only.
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new Error("clerk unavailable"),
    );

    await store.set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: [queued!.id, sibling!.id] },
      context.signal,
    );

    // The native intent is neither sent nor failed: it keeps its state and its
    // attempt count for a later pass.
    const [held] = await db()
      .select({ status: emailOutbox.status, attempts: emailOutbox.attempts })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    expect(held?.status).toBe("pending");
    expect(held?.attempts).toBe(0);

    // The unrelated producer still went out.
    const [drainedSibling] = await db()
      .select({ status: emailOutbox.status })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, sibling!.id));
    expect(drainedSibling?.status).toBe("sent");
    const sends = emailSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload["to"]).toStrictEqual("sibling@example.test");
  });

  it("refuses a native send after the recipient rejoins under a new membership", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await accept(deliver(f, attemptId), [200]);
    const [queued] = await readOutbox(f);

    // Remote removal and rejoin issues a new membership generation while the
    // local rows still look exactly the same.
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            id: `orgmem_${randomUUID()}`,
            organization: { id: f.orgId },
            publicUserData: { userId: f.userId },
          },
        ],
        totalCount: 1,
      } as never,
    );

    await store.set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: [queued!.id] },
      context.signal,
    );

    expect(emailSends()).toHaveLength(0);
    const [resolved] = await db()
      .select({ status: emailOutbox.status, lastError: emailOutbox.lastError })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    expect(resolved?.status).toBe("failed");
    expect(resolved?.lastError).toContain("new membership generation");
  });

  it("removes the unsent native intent when its destination thread is deleted", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    const delivered = await accept(deliver(f, attemptId), [200]);
    const [queued] = await readOutbox(f);
    expect(queued).toBeDefined();

    await store.set(
      deleteChatThread$,
      {
        threadId: delivered.body.delivery.chatThreadId,
        userId: f.userId,
        orgId: f.orgId,
      },
      context.signal,
    );

    // The cascade removed the delivery; the deletion transaction removed the
    // content-bearing mail with it rather than leaving it to expire.
    expect(await readDeliveries(f)).toHaveLength(0);
    const remaining = await db()
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    expect(remaining).toHaveLength(0);
  });

  it("converges concurrent deliveries of one result on a single message", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);

    const [first, second] = await Promise.all([
      accept(deliver(f, attemptId), [200]),
      accept(deliver(f, attemptId), [200]),
    ]);

    const results = [first.body.result, second.body.result].sort();
    expect(results).toStrictEqual(["already-delivered", "delivered"]);
    expect(first.body.delivery.chatEventId).toBe(
      second.body.delivery.chatEventId,
    );
    expect(await readDeliveries(f)).toHaveLength(1);
    const events = await readThreadEvents(first.body.delivery.chatThreadId);
    expect(
      events.filter((event) => {
        return event.eventType === "output.message";
      }),
    ).toHaveLength(1);
    expect(await readOutbox(f)).toHaveLength(1);
  });

  it("replays one native send under the same key after a lost completion", async () => {
    const f = await fixture();
    scriptSlack();
    scriptProviders();
    const attemptId = await generateAcceptedResult(f);
    await accept(deliver(f, attemptId), [200]);
    const [queued] = await readOutbox(f);

    // The provider accepts, then the completion write fails — the exact
    // ambiguity S2's committed request and key exist for.
    const restore = await rejectEmailOutboxCompletion(
      queued!.id,
      context.signal,
    );
    await expect(
      store.set(
        drainEmailOutboxItems$,
        { currentTimeMs: now(), itemIds: [queued!.id] },
        context.signal,
      ),
    ).rejects.toThrow();
    await restore();

    const firstSends = emailSends();
    expect(firstSends).toHaveLength(1);
    const [afterLoss] = await db()
      .select({
        status: emailOutbox.status,
        providerIdempotencyKey: emailOutbox.providerIdempotencyKey,
        providerRequest: emailOutbox.providerRequest,
      })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    // The row is still `sending` with its committed payload and key intact.
    expect(afterLoss?.status).toBe("sending");
    expect(afterLoss?.providerIdempotencyKey).toBe(
      firstSends[0]?.options.idempotencyKey,
    );

    // Its recovery lease elapses and another drain replays the same request.
    await db()
      .update(emailOutbox)
      .set({ nextRetryAt: new Date(now() - 1000) })
      .where(eq(emailOutbox.id, queued!.id));
    await store.set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: [queued!.id] },
      context.signal,
    );

    const sends = emailSends();
    expect(sends).toHaveLength(2);
    // Same payload, same key: the provider owns one logical delivery.
    expect(sends[1]?.payload).toStrictEqual(sends[0]?.payload);
    expect(sends[1]?.options.idempotencyKey).toBe(
      sends[0]?.options.idempotencyKey,
    );
    const [settled] = await db()
      .select({ status: emailOutbox.status })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, queued!.id));
    expect(settled?.status).toBe("sent");
    // No second Chat message and no second generation followed the replay.
    expect(await readDeliveries(f)).toHaveLength(1);
  });
});
