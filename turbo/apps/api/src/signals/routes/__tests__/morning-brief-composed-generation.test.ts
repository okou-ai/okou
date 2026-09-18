import { randomUUID } from "node:crypto";

import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { morningBriefDeliveryPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-delivery-preview";
import { morningBriefGenerationPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  readMorningBriefCollectionOccurrences,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-collection";
import {
  bindMorningBriefThreadFixture,
  markChatThreadReadFixture,
  replaceMorningBriefAutomationFixture,
  seedFinishedChatRunFixture$,
  seedOrdinaryChatThreadFixture$,
} from "../../../test-fixtures/morning-brief-chat-collection";
import {
  expireAndSweepMorningBriefGeneration,
  holdMorningBriefGenerationReservation,
  readMorningBriefGenerations,
  readOwnerBillingFootprint,
  readPlatformGenerationReceipts,
  seedPossiblyInvokedSlackGeneration,
} from "../../../test-fixtures/morning-brief-generation";
import { rejectEmailOutboxCompletion } from "../../../test-fixtures/email-outbox";
import {
  drainEmailOutbox,
  elapseEmailOutboxRecoveryLease,
  readMorningBriefDeliveryOutbox,
  seedMemberEmailAddress,
} from "../../../test-fixtures/morning-brief-delivery";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
import { morningBriefDeliveryPreviewRoutes } from "../morning-brief-delivery-preview";
import { morningBriefGenerationPreviewRoutes } from "../morning-brief-generation-preview";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";

/**
 * The real registered entry point for source-independent generation.
 *
 * Every case here goes through the deployed route, the deployed admission and a
 * real database. The provider boundary is a double, and the point of counting
 * its requests is that the cases below prove when a request is *not* made.
 */

const context = testContext();
const store = createStore();

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SLACK_USER_CONVERSATIONS_URL =
  "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";

const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();
const WINDOW_START_SECONDS = (ANCHOR_MS - 24 * 60 * 60 * 1000) / 1000;

/** A distinct in-window Slack timestamp per scripted message. */
function messageTs(index: number): string {
  return `${WINDOW_START_SECONDS + 120 + index}.000100`;
}

/** Script the Slack reads the composed collector performs. */
function slackWithMessages(texts: readonly string[]): void {
  const reply = (body: Record<string, unknown>) => {
    return () => {
      return HttpResponse.json(body);
    };
  };
  server.use(
    http.get(
      SLACK_USER_CONVERSATIONS_URL,
      reply({
        ok: true,
        channels: [{ id: "C100", name: "general", is_private: false }],
        response_metadata: { next_cursor: "" },
      }),
    ),
    http.get(
      "https://slack.com/api/conversations.replies",
      reply({ ok: true, messages: [] }),
    ),
    http.get(SLACK_HISTORY_URL, ({ request }) => {
      const channel = new URL(request.url).searchParams.get("channel");
      return HttpResponse.json(
        channel === "C100"
          ? {
              ok: true,
              messages: texts.map((text, index) => {
                return {
                  type: "message",
                  ts: messageTs(index),
                  user: `U${String(index)}`,
                  text,
                };
              }),
            }
          : { ok: true, messages: [] },
      );
    }),
  );
}

/** Script the single platform request and record exactly what was sent. */
function scriptProvider(
  content: string,
  onRequest?: () => void | Promise<void>,
): { readonly bodies: string[] } {
  const bodies: string[] = [];
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      bodies.push(await request.text());
      await onRequest?.();
      return HttpResponse.json({
        id: "gen_composed_1",
        model: "google/gemini-3.8-flash",
        choices: [{ finish_reason: "stop", message: { content } }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 200,
          total_tokens: 1400,
          cost: 0.000123,
        },
      });
    }),
  );
  return { bodies };
}

afterEach(() => {
  clearMockNow();
});

function client() {
  return setupApp({ context, routes: morningBriefCompositionPreviewRoutes })(
    morningBriefCompositionPreviewContract,
  );
}

function deliveryClient() {
  return setupApp({ context, routes: morningBriefDeliveryPreviewRoutes })(
    morningBriefDeliveryPreviewContract,
  );
}

function legacyGenerationClient() {
  return setupApp({ context, routes: morningBriefGenerationPreviewRoutes })(
    morningBriefGenerationPreviewContract,
  );
}

function agentToken(
  userId: string,
  orgId: string,
): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: randomUUID(),
      capabilities: ["agent:read", "agent:write", "slack:read"],
      iat: seconds,
      exp: seconds + 3600,
    })}`,
  };
}

/** Count every provider request the route makes, including refused ones. */
function countProviderRequests(): { readonly total: () => number } {
  let total = 0;
  server.use(
    http.post(OPENROUTER_URL, () => {
      total += 1;
      return HttpResponse.json({ error: { message: "unexpected" } });
    }),
  );
  return {
    total: () => {
      return total;
    },
  };
}

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly headers: { readonly authorization: string };
}

/** The same owner, plus the organization's native Slack installation. */
async function withSlack(fixture: Fixture): Promise<void> {
  const installation = await store.set(
    seedSlackOrgInstallation$,
    { orgId: fixture.orgId, botToken: `xoxb-test-${randomUUID()}` },
    context.signal,
  );
  await store.set(
    seedSlackOrgConnection$,
    {
      slackWorkspaceId: installation.slackWorkspaceId,
      userId: fixture.userId,
    },
    context.signal,
  );
}

/**
 * An owner with the brief installed and **no connector at all**.
 *
 * No Slack installation is seeded on purpose: a composed brief must be
 * reachable for an owner who has none, and nothing may substitute a Slack
 * identity for them.
 */
async function seedOwnerWithoutConnectors(): Promise<Fixture> {
  // Building the app first is what wires the shared boundary doubles this
  // fixture then programs.
  client();
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "member" },
    context.signal,
  );
  const installed = await seedInstalledMorningBrief({ orgId, userId });
  await updateFeatureSwitchesForUser(
    context,
    { userId, orgId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  mockOptionalEnv("OPENROUTER_API_KEY", "sk-test-platform-key");
  return {
    orgId,
    userId,
    agentId: installed.agentId,
    workflowId: installed.workflowId,
    automationId: installed.automationId,
    headers: agentToken(userId, orgId),
  };
}

describe("composed Morning Brief generation", () => {
  it("reaches the composed engine for an owner with no connectors and sends nothing", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    const provider = countProviderRequests();

    const response = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );

    // Every configured source answered with nothing, so this settles as a
    // healthy empty morning: zero provider requests and zero platform spend.
    expect(response.body.result).toBe("generated");
    expect(provider.total()).toBe(0);

    // The occurrence is source-independent, and it carries no Slack identity.
    const occurrences = await readMorningBriefCollectionOccurrences({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.collectionKind).toBe("sources");
    expect(occurrences[0]?.slackWorkspaceId).toBeNull();
    expect(occurrences[0]?.slackUserId).toBeNull();

    const generations = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(generations).toHaveLength(1);
    expect(generations[0]?.state).toBe("skipped_empty");
    expect(generations[0]?.collectionKind).toBe("sources");
    // A skip consumed zero model calls, so it owes no platform receipt.
    await expect(
      readPlatformGenerationReceipts([generations[0]?.attemptId ?? ""]),
    ).resolves.toHaveLength(0);

    // Okou pays for this pipeline, so the owner's ledger must be untouched.
    const footprint = await readOwnerBillingFootprint({
      orgId: fixture.orgId,
      workflowId: fixture.workflowId,
      automationId: fixture.automationId,
    });
    expect(footprint.usageEvents).toBe(0);
    expect(footprint.allowanceWindows).toBe(0);
    expect(footprint.runs).toBe(0);
    expect(footprint.emails).toBe(0);
  });

  it("generates from useful unread Chat with zero connectors and no new Run or credits", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    const chatThreadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      {
        member: {
          orgId: fixture.orgId,
          userId: fixture.userId,
          agentId: fixture.agentId,
        },
        title: "Launch decision",
      },
      context.signal,
    );
    await store.set(
      seedFinishedChatRunFixture$,
      {
        chatThreadId,
        prompt: "Should we ship today?",
        reply: "Ship after the final approval.",
      },
      context.signal,
    );
    await markChatThreadReadFixture({
      chatThreadId,
      lastReadAt: new Date(0),
    });
    const before = await readOwnerBillingFootprint({
      orgId: fixture.orgId,
      workflowId: fixture.workflowId,
      automationId: fixture.automationId,
    });
    const provider = scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Ship after approval", citations: ["c1"] }],
          },
        ],
      }),
    );

    const chatAnchor = new Date(now() + 30_000).toISOString();
    const response = await accept(
      client().generate({
        headers: fixture.headers,
        // Unread Chat is standing state, but the terminal event must already
        // exist at the invocation anchor.
        body: { anchor: chatAnchor },
      }),
      [200],
    );
    expect(response.body.result).toBe("generated");
    expect(provider.bodies).toHaveLength(1);
    const request = JSON.parse(provider.bodies[0] ?? "{}") as {
      readonly messages?: readonly { readonly content?: string }[];
    };
    const document = JSON.parse(request.messages?.[0]?.content ?? "{}") as {
      readonly items?: readonly { readonly source?: string }[];
    };
    expect(
      document.items?.some((item) => {
        return item.source === "chat";
      }),
    ).toBeTruthy();

    const after = await readOwnerBillingFootprint({
      orgId: fixture.orgId,
      workflowId: fixture.workflowId,
      automationId: fixture.automationId,
    });
    expect(after.runs).toBe(before.runs);
    expect(after.usageEvents).toBe(before.usageEvents);
    expect(after.allowanceWindows).toBe(before.allowanceWindows);
    expect(after.credits).toBe(before.credits);
  });

  it("refuses a second invocation for a morning a Slack-kind attempt may already have sent", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    const provider = countProviderRequests();
    // A Slack-only generation that is merely `reserved` is already ambiguous:
    // the reservation commits before the request, so it may have reached the
    // provider. Widening the source set must never turn that into a resend.
    await seedPossiblyInvokedSlackGeneration({
      orgId: fixture.orgId,
      userId: fixture.userId,
      agentId: fixture.agentId,
      workflowId: fixture.workflowId,
      automationId: fixture.automationId,
      scheduledFor: new Date(ANCHOR_MS),
    });

    const response = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [409],
    );

    expect(response.body).toMatchObject({
      error: { code: "MORNING_BRIEF_GENERATION_CONFLICT" },
    });
    expect(provider.total()).toBe(0);

    // The historical Slack slot is untouched: it stays exactly as invocable —
    // or as non-invocable — as it was, and no second slot was created for it.
    const generations = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(generations).toHaveLength(1);
    expect(generations[0]?.collectionKind).toBe("slack");
    expect(generations[0]?.state).toBe("reserved");
  });

  it("keeps a purged Slack attempt as a cross-kind replay fence", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    const bodies: string[] = [];
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        bodies.push(await request.text());
        return HttpResponse.json({
          id: "gen_legacy_before_cutover",
          model: "google/gemini-3.8-flash",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  decision: "deliver",
                  title: "Legacy brief",
                  sections: [
                    {
                      heading: "Decisions",
                      items: [{ text: "Ship today", sourceIds: ["m1"] }],
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

    await accept(
      legacyGenerationClient().preview({
        headers: fixture.headers,
        body: { scheduledFor: ANCHOR },
      }),
      [200],
    );
    expect(bodies).toHaveLength(1);
    // Exactly seven days is still an admissible anchor (`>`, not `>=`, is
    // rejected), so the content-free cross-kind fence must survive this sweep.
    await expireAndSweepMorningBriefGeneration(
      { orgId: fixture.orgId, userId: fixture.userId },
      {
        expiresAt: new Date(now() - 1000),
        sweptAt: new Date(ANCHOR_MS + 7 * 24 * 60 * 60 * 1000),
      },
    );
    const [fence] = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(fence?.collectionKind).toBe("slack");
    expect(fence?.contentPurgedAt).not.toBeNull();
    expect(fence?.resultMarkdown).toBeNull();

    const widened = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [409],
    );
    expect(widened.body.error.code).toBe("MORNING_BRIEF_GENERATION_CONFLICT");
    expect(bodies).toHaveLength(1);
  });

  it("sends exactly one complete request the provider ceiling admits", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(['ship the "release" today', "block on review"]);
    const provider = scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "zh-Hans",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
    );

    const response = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    expect(response.body.result).toBe("generated");

    // Exactly one provider request, and it is the one the reservation admitted.
    expect(provider.bodies).toHaveLength(1);
    const raw = provider.bodies[0] ?? "";
    const sent = JSON.parse(raw) as {
      readonly model: string;
      readonly max_tokens: number;
      readonly stream: boolean;
      readonly messages: readonly { readonly content: string }[];
    };
    expect(sent.model).toBe("google/gemini-3.8-flash");
    expect(sent.max_tokens).toBe(8192);
    expect(sent.stream).toBeFalsy();
    // The ceiling is on the bytes that actually travelled, escaping included.
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(128 * 1024);

    // The complete policy, schema, language authority, source coverage and
    // evidence travel in the exact one serialized provider message.
    expect(sent.messages).toHaveLength(1);
    const content = sent.messages[0]?.content ?? "{}";
    const document = JSON.parse(content) as {
      readonly policy: string;
      readonly schema: Record<string, unknown>;
      readonly language: {
        readonly authority: string;
        readonly fallbackLanguage: string;
      };
      readonly items: readonly Record<string, unknown>[];
      readonly coverage: readonly { readonly source: string }[];
    };
    expect(document.policy).toContain("untrusted data");
    expect(document.policy).toContain("never invent facts");
    expect(document.policy).toContain("exact opaque `id` values");
    expect(document.policy).toContain(
      "Agent instructions may steer output language only",
    );
    expect(document.schema).toHaveProperty("deliver");
    expect(document.schema).toHaveProperty("skip");
    expect(document.language.authority).toBe("default");
    expect(document.language.fallbackLanguage).toBe("en-US");

    // Evidence travels under opaque ids only: no provider identity, no link.
    expect(document.items.length).toBeGreaterThan(0);
    expect(document.items[0]?.id).toBe("c1");
    expect(document.items[0]).not.toHaveProperty("identity");
    expect(document.items[0]).not.toHaveProperty("links");
    expect(content).not.toContain("https://");
    expect(
      document.coverage
        .map((entry) => {
          return entry.source;
        })
        .sort(),
    ).toStrictEqual(["calendar", "chat", "github", "gmail", "slack"]);
  });

  it("stores the accepted result with its provenance and no owner billing", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "zh-Hans",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
    );

    await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );

    const generations = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(generations).toHaveLength(1);
    const row = generations[0];
    expect(row?.state).toBe("succeeded");
    expect(row?.decision).toBe("deliver");
    expect(row?.collectionKind).toBe("sources");
    // Provenance, not proof: the tag the answer reported for itself.
    expect(row?.reportedLanguage).toBe("zh-Hans");
    // Retained proof exists and outlives the body it was collected for.
    expect(row?.retainedSources).not.toBeNull();
    expect(row?.installationId).toBe(fixture.workflowId);
    expect(row?.automationId).toBe(fixture.automationId);
    expect(row?.retainedUntil).not.toBeNull();
    expect(row?.retainedUntil?.getTime() ?? 0).toBeGreaterThanOrEqual(
      row?.expiresAt.getTime() ?? 0,
    );
    // Links are resolved by program code from the collected input.
    expect(row?.resultMarkdown ?? "").toContain("https://");

    // The platform paid, and the owner's ledger did not.
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.costState).toBe("reported");
    const footprint = await readOwnerBillingFootprint({
      orgId: fixture.orgId,
      workflowId: fixture.workflowId,
      automationId: fixture.automationId,
    });
    expect(footprint.usageEvents).toBe(0);
    expect(footprint.allowanceWindows).toBe(0);
    expect(footprint.runs).toBe(0);
  });

  it("rejects a citation the request never issued and keeps the charge", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    const provider = scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            // Never issued by the request builder.
            items: [{ text: "Invented", citations: ["c999"] }],
          },
        ],
      }),
    );

    await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );

    expect(provider.bodies).toHaveLength(1);
    const generations = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(generations[0]?.state).toBe("output_rejected");
    expect(generations[0]?.failureReason).toBe("unknown_source_reference");
    expect(generations[0]?.resultMarkdown).toBeNull();
    // The request was billed whether or not its answer was usable.
    await expect(
      readPlatformGenerationReceipts([generations[0]?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);
  });

  it("withholds stored readback and new Chat delivery after source revocation", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    const provider = scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
    );
    const generated = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    if (generated.body.result !== "generated") {
      throw new Error("expected a generated brief");
    }

    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const readback = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    expect(readback.body.result).toBe("authority-changed");
    expect(provider.bodies).toHaveLength(1);

    const delivery = await accept(
      deliveryClient().preview({
        headers: fixture.headers,
        body: { resultAttemptId: generated.body.generation.attemptId },
      }),
      [409],
    );
    expect(delivery.body.error.code).toBe("MORNING_BRIEF_OWNER_REVOKED");
  });

  it("withholds persisted content after the canonical automation is replaced", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    const provider = scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
    );
    const generated = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    if (generated.body.result !== "generated") {
      throw new Error("expected a generated brief");
    }

    await replaceMorningBriefAutomationFixture({
      orgId: fixture.orgId,
      userId: fixture.userId,
      workflowId: fixture.workflowId,
      automationId: fixture.automationId,
    });

    const readback = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [409],
    );
    expect(readback.body.error.code).toBe("MORNING_BRIEF_GENERATION_CONFLICT");
    expect(provider.bodies).toHaveLength(1);

    const delivery = await accept(
      deliveryClient().preview({
        headers: fixture.headers,
        body: { resultAttemptId: generated.body.generation.attemptId },
      }),
      [409],
    );
    expect(delivery.body.error.code).toBe("MORNING_BRIEF_OWNER_REVOKED");
  });

  it("refuses the first email send when retained source authority is revoked", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    await seedMemberEmailAddress(fixture.userId, "owner@example.test");
    mockEnv("RESEND_API_KEY", "platform-resend-key");
    mockEnv("RESEND_FROM_DOMAIN", "mail.okou.test");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
    mockEnv("APP_URL", "https://app.okou.test");
    context.mocks.resend.send.mockReset();
    slackWithMessages(["ship the release"]);
    scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
    );

    const generated = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    if (generated.body.result !== "generated") {
      throw new Error("expected a generated brief");
    }
    await accept(
      deliveryClient().preview({
        headers: fixture.headers,
        body: { resultAttemptId: generated.body.generation.attemptId },
      }),
      [200],
    );
    const [queued] = await readMorningBriefDeliveryOutbox({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(queued?.status).toBe("pending");

    // The retained request included C100 even though the answer only cites an
    // opaque id. Losing access before the first shared-outbox drain withholds
    // the whole accepted body; no send is attempted.
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    await drainEmailOutbox([queued?.id ?? "missing"], context.signal);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
    const [failed] = await readMorningBriefDeliveryOutbox({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toContain("retained source");
  });

  it("makes no POST when source authority moves after reservation", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    const provider = countProviderRequests();
    const barrier = await holdMorningBriefGenerationReservation(
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const pending = client().generate({
      headers: fixture.headers,
      body: { anchor: ANCHOR },
    });
    await barrier.waitForArrival();
    // The INSERT exists only in the held reservation transaction. No provider
    // contact can precede its COMMIT.
    expect(provider.total()).toBe(0);
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    await barrier.release();
    await accept(pending, [200]);

    expect(provider.total()).toBe(0);
    const [uninvoked] = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(uninvoked?.state).toBe("not_invoked");
    expect(uninvoked?.failureReason).toBe("binding_changed");
    await expect(
      readPlatformGenerationReceipts([uninvoked?.attemptId ?? ""]),
    ).resolves.toHaveLength(0);
  });

  it("keeps retained proof through content purge and a committed-request email replay", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    await seedMemberEmailAddress(fixture.userId, "owner@example.test");
    mockEnv("RESEND_API_KEY", "platform-resend-key");
    mockEnv("RESEND_FROM_DOMAIN", "mail.okou.test");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
    mockEnv("APP_URL", "https://app.okou.test");
    context.mocks.resend.send.mockReset();
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-source-replay" },
      error: null,
    });
    slackWithMessages(["ship the release"]);
    scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
    );
    const generated = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    if (generated.body.result !== "generated") {
      throw new Error("expected a generated brief");
    }
    await accept(
      deliveryClient().preview({
        headers: fixture.headers,
        body: { resultAttemptId: generated.body.generation.attemptId },
      }),
      [200],
    );
    const [queued] = await readMorningBriefDeliveryOutbox({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    if (!queued) {
      throw new Error("expected a queued email");
    }

    await expireAndSweepMorningBriefGeneration(
      { orgId: fixture.orgId, userId: fixture.userId },
      { expiresAt: new Date(now() - 1000), sweptAt: new Date(now()) },
    );
    const [purged] = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(purged?.resultMarkdown).toBeNull();
    expect(purged?.retainedSources).not.toBeNull();
    expect(purged?.retainedUntil?.getTime() ?? 0).toBeGreaterThan(now());

    const restore = await rejectEmailOutboxCompletion(
      queued.id,
      context.signal,
    );
    const completionFailure = await drainEmailOutbox(
      [queued.id],
      context.signal,
    ).then(
      () => {
        return null;
      },
      (error: unknown) => {
        return error;
      },
    );
    await restore();
    expect(completionFailure).not.toBeNull();
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    const first = context.mocks.resend.send.mock.calls[0];

    await elapseEmailOutboxRecoveryLease(queued.id);
    await drainEmailOutbox([queued.id], context.signal);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    const second = context.mocks.resend.send.mock.calls[1];
    const firstOptions = first?.[1] as
      | { readonly idempotencyKey?: string }
      | undefined;
    const secondOptions = second?.[1] as
      | { readonly idempotencyKey?: string }
      | undefined;
    expect(second?.[0]).toStrictEqual(first?.[0]);
    expect(secondOptions?.idempotencyKey).toBe(firstOptions?.idempotencyKey);
    const [sent] = await readMorningBriefDeliveryOutbox({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(sent?.status).toBe("sent");
  });

  it("discards a response when supplied source authority moves after POST", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    const provider = scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
      () => {
        // The response is already on its way — this barrier proves the only
        // platform POST happened before the shared post-response fence.
        server.use(
          http.get(SLACK_USER_CONVERSATIONS_URL, () => {
            return HttpResponse.json({
              ok: true,
              channels: [],
              response_metadata: { next_cursor: "" },
            });
          }),
        );
      },
    );

    await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    expect(provider.bodies).toHaveLength(1);
    const [discarded] = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(discarded?.state).toBe("result_discarded");
    expect(discarded?.failureReason).toBe("binding_changed");
    expect(discarded?.resultMarkdown).toBeNull();
    await expect(
      readPlatformGenerationReceipts([discarded?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);

    // The durable reservation/receipt remains the invocation fact. A retry may
    // report it but may never contact the provider again.
    await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    expect(provider.bodies).toHaveLength(1);
  });

  it("hands a composed result to the real delivery consumer", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    await withSlack(fixture);
    slackWithMessages(["ship the release"]);
    const provider = scriptProvider(
      JSON.stringify({
        decision: "deliver",
        language: "en-US",
        title: "Today",
        sections: [
          {
            heading: "Decisions",
            items: [{ text: "Release is going out", citations: ["c1"] }],
          },
        ],
      }),
    );

    const generated = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    if (generated.body.result !== "generated") {
      throw new Error(
        `expected a generated brief, got ${generated.body.result}`,
      );
    }
    // The occurrence this reference belongs to is source-independent, so this
    // also proves the delivery path resolves an anchor it never read Slack for.
    expect(generated.body.occurrence.collectionKind).toBe("sources");

    // The one reference a delivery consumer resolves content by. Nothing else
    // about the brief can be supplied to it.
    const delivered = await accept(
      deliveryClient().preview({
        headers: fixture.headers,
        body: { resultAttemptId: generated.body.generation.attemptId },
      }),
      [200],
    );
    expect(delivered.body.result).toBe("delivered");
    expect(delivered.body.delivery.chatEventId).toBeTruthy();

    // A repeat request returns the delivery this occurrence already has rather
    // than appending a second message or creating a second email intent.
    const repeated = await accept(
      deliveryClient().preview({
        headers: fixture.headers,
        body: { resultAttemptId: generated.body.generation.attemptId },
      }),
      [200],
    );
    expect(repeated.body.result).toBe("already-delivered");
    expect(repeated.body.delivery.chatEventId).toBe(
      delivered.body.delivery.chatEventId,
    );

    // S6's receipt is the only valid null → destination transition. Rebinding
    // the same installation and automation to another real thread withholds
    // the persisted source content without making another provider request.
    const replacementThreadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      {
        member: {
          orgId: fixture.orgId,
          userId: fixture.userId,
          agentId: fixture.agentId,
        },
        title: "Replacement destination",
      },
      context.signal,
    );
    await bindMorningBriefThreadFixture({
      orgId: fixture.orgId,
      userId: fixture.userId,
      workflowId: fixture.workflowId,
      chatThreadId: replacementThreadId,
    });
    const rebound = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );
    expect(rebound.body.result).toBe("authority-changed");
    expect(provider.bodies).toHaveLength(1);
  });
});
