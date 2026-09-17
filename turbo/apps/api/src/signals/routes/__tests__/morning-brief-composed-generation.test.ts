import { randomUUID } from "node:crypto";

import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  readMorningBriefCollectionOccurrences,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-collection";
import {
  readMorningBriefGenerations,
  readOwnerBillingFootprint,
  readPlatformGenerationReceipts,
  seedPossiblyInvokedSlackGeneration,
} from "../../../test-fixtures/morning-brief-generation";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
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
function scriptProvider(content: string): { readonly bodies: string[] } {
  const bodies: string[] = [];
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      bodies.push(await request.text());
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
      capabilities: ["agent:read"],
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

    // The instructions state the precedence, in the one call.
    const system = sent.messages[0]?.content ?? "";
    expect(system).toContain("Pipeline constraints");
    expect(system).toContain("OUTPUT LANGUAGE ONLY");
    expect(system).toContain("language.fallbackLanguage");

    // Evidence travels under opaque ids only: no provider identity, no link.
    const document = JSON.parse(sent.messages[1]?.content ?? "{}") as {
      readonly items: readonly Record<string, unknown>[];
      readonly coverage: readonly Record<string, unknown>[];
    };
    expect(document.items.length).toBeGreaterThan(0);
    expect(document.items[0]?.id).toBe("c1");
    expect(document.items[0]).not.toHaveProperty("identity");
    expect(document.items[0]).not.toHaveProperty("links");
    expect(sent.messages[1]?.content).not.toContain("https://");
    expect(document.coverage.length).toBeGreaterThan(0);
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
});
