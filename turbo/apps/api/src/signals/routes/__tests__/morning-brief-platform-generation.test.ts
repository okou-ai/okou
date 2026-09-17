import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import {
  morningBriefGenerationPreviewContract,
  type MorningBriefGenerationView,
} from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  deleteMorningBriefAgent,
  pauseMorningBriefAutomation,
  readMorningBriefCollectionOccurrences,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-collection";
import {
  expireMorningBriefGenerationRetention,
  expireMorningBriefGenerationReservation,
  failMorningBriefGenerationUpdates,
  holdMorningBriefGenerationReservation,
  holdMorningBriefOwnerRow,
  readMorningBriefGenerations,
  readOwnerBillingFootprint,
  readPlatformGenerationReceipts,
  rebindMorningBriefSlackAccount,
  removeMorningBriefMember,
  setMorningBriefMemberLocale,
} from "../../../test-fixtures/morning-brief-generation";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createDeferredPromise } from "../../utils";
import { morningBriefCollectionPreviewRoutes } from "../morning-brief-collection-preview";
import { morningBriefGenerationPreviewRoutes } from "../morning-brief-generation-preview";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();

const SLACK_USER_CONVERSATIONS_URL =
  "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation";

const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();
const WINDOW_START_SECONDS = (ANCHOR_MS - 24 * 60 * 60 * 1000) / 1000;
/** Distinct in-window Slack timestamps, one per scripted message. */
function messageTs(index: number): string {
  return `${WINDOW_START_SECONDS + 120 + index}.000100`;
}

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

function generationClient() {
  return setupApp({ context, routes: morningBriefGenerationPreviewRoutes })(
    morningBriefGenerationPreviewContract,
  );
}

function collectOnlyClient() {
  return setupApp({ context, routes: morningBriefCollectionPreviewRoutes })(
    morningBriefCollectionPreviewContract,
  );
}

function agentToken(
  userId: string,
  orgId: string,
  capabilities: readonly Capability[] = ["slack:read"],
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
    readonly enabled?: boolean;
    readonly locale?: string | null;
    readonly capabilities?: readonly Capability[];
    readonly llmConfigured?: boolean;
  } = {},
): Promise<Fixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { userId, orgId, role: "admin" },
    context.signal,
  );
  const brief = await seedInstalledMorningBrief({
    orgId,
    userId,
    enabled: options.enabled,
  });
  if (options.locale !== undefined && options.locale !== null) {
    await setMorningBriefMemberLocale({ orgId, userId }, options.locale);
  }
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
  mockOptionalEnv(
    "OPENROUTER_API_KEY",
    options.llmConfigured === false ? undefined : "platform-openrouter-key",
  );
  return {
    orgId,
    userId,
    agentId: brief.agentId,
    workflowId: brief.workflowId,
    automationId: brief.automationId,
    headers: agentToken(userId, orgId, options.capabilities),
  };
}

function generate(f: Pick<Fixture, "headers">, scheduledFor = ANCHOR) {
  return generationClient().preview({
    headers: f.headers,
    body: { scheduledFor },
  });
}

type SlackReply = (query: URLSearchParams) => unknown;

/** Script the Slack reads this collector performs. */
function scriptSlack(script: {
  readonly channels?: SlackReply;
  readonly history?: SlackReply;
}): void {
  const handle = (reply: SlackReply | undefined) => {
    return ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      return HttpResponse.json(
        reply?.(url.searchParams) ?? { ok: true, messages: [] },
      );
    };
  };
  server.use(
    http.get(SLACK_USER_CONVERSATIONS_URL, handle(script.channels)),
    http.get(
      "https://slack.com/api/conversations.replies",
      handle(() => {
        return { ok: true, messages: [] };
      }),
    ),
    http.get(SLACK_HISTORY_URL, handle(script.history)),
  );
}

/** One shared channel carrying two in-window messages. */
function slackWithMessages(texts: readonly string[] = ["ship the release"]) {
  scriptSlack({
    channels: () => {
      return {
        ok: true,
        channels: [
          { id: "C100", name: "general", is_private: false },
          { id: "C200", name: "release", is_private: false },
        ],
        response_metadata: { next_cursor: "" },
      };
    },
    history: (query) => {
      return query.get("channel") === "C100"
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
        : { ok: true, messages: [] };
    },
  });
}

interface ProviderTraffic {
  readonly bodies: string[];
}

type ProviderBody = Record<string, unknown>;
type ProviderResult = ProviderBody | HttpResponse<string>;
type ProviderReply = (body: string) => ProviderResult | Promise<ProviderResult>;

/** Script the single platform request and record exactly what was sent. */
function scriptProvider(reply: ProviderReply): ProviderTraffic {
  const traffic: ProviderTraffic = { bodies: [] };
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      const body = await request.text();
      traffic.bodies.push(body);
      const result = await reply(body);
      return result instanceof HttpResponse
        ? result
        : HttpResponse.json(result);
    }),
  );
  return traffic;
}

/** A provider response carrying content, usage and a generation id. */
function completion(options: {
  readonly content?: string;
  readonly finishReason?: string;
  readonly cost?: unknown;
  readonly usage?: Record<string, unknown> | null;
  readonly id?: string;
}): ProviderBody {
  const usage =
    options.usage === null
      ? {}
      : {
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 240,
            total_tokens: 1440,
            completion_tokens_details: { reasoning_tokens: 90 },
            prompt_tokens_details: { cached_tokens: 64 },
            ...(options.cost === undefined ? {} : { cost: options.cost }),
            ...options.usage,
          },
        };
  return {
    id: options.id ?? "gen-01H0PLATFORM",
    model: "google/gemini-3.8-flash",
    choices: [
      {
        finish_reason: options.finishReason ?? "stop",
        message: { content: options.content ?? deliverContent() },
      },
    ],
    ...usage,
  };
}

function deliverContent(sourceId = "m1"): string {
  return JSON.stringify({
    decision: "deliver",
    title: "Release readiness",
    sections: [
      {
        heading: "Decisions",
        items: [{ text: "The release ships today.", sourceIds: [sourceId] }],
      },
    ],
  });
}

/** Narrow a response to the generated case, keeping its generation view typed. */
function expectGenerated(body: {
  readonly result: string;
  readonly generation?: MorningBriefGenerationView;
}): { readonly generation: MorningBriefGenerationView } {
  if (body.result !== "generated" || body.generation === undefined) {
    throw new Error(`Expected a generated result, got ${body.result}`);
  }
  return { generation: body.generation };
}

describe("Morning Brief platform-funded generation", () => {
  it("collects, reserves, generates once and persists the result and its cost", async () => {
    const f = await fixture({ locale: "ja-JP" });
    slackWithMessages(["ship the release", "blocker cleared"]);
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.00421 });
    });

    const response = await accept(generate(f), [200]);
    if (response.body.result !== "generated") {
      throw new Error(`Expected generated, got ${response.body.result}`);
    }
    const { generation } = response.body;

    expect(traffic.bodies).toHaveLength(1);
    const request = JSON.parse(traffic.bodies[0] ?? "") as {
      model: string;
      max_tokens: number;
      reasoning: { effort: string };
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    expect(request.model).toBe("google/gemini-3.8-flash");
    expect(request.max_tokens).toBe(8192);
    expect(request.reasoning).toStrictEqual({ effort: "low" });
    expect(request.stream).toBeFalsy();
    expect(request).not.toHaveProperty("tools");
    expect(
      Buffer.byteLength(traffic.bodies[0] ?? "", "utf8"),
    ).toBeLessThanOrEqual(128 * 1024);
    // The member's persisted locale is frozen into the request itself.
    expect(request.messages[0]?.content).toContain("ja-JP");

    expect(generation.state).toBe("succeeded");
    expect(generation.purpose).toBe("preview");
    expect(generation.language).toBe("ja-JP");
    expect(generation.languageSource).toBe("member-locale");
    expect(generation.model).toBe("google/gemini-3.8-flash");
    expect(generation.inputItems).toBe(2);
    expect(generation.includedItems).toBe(2);
    expect(generation.inputReduced).toBeFalsy();
    expect(generation.result).toStrictEqual({
      decision: "deliver",
      title: "Release readiness",
      markdown: expect.stringContaining("# Release readiness"),
      bytes: expect.any(Number),
    });
    // Links are resolved by program code from the collected source map.
    expect(
      generation.result?.decision === "deliver" && generation.result.markdown,
    ).toContain("[#general](");
    expect(generation.receipt).toMatchObject({
      provider: "openrouter",
      requestedModel: "google/gemini-3.8-flash",
      returnedModel: "google/gemini-3.8-flash",
      providerGenerationId: "gen-01H0PLATFORM",
      outcome: "response_received",
      cost: {
        state: "reported",
        value: "0.00421",
        unit: "openrouter_credits",
        source: "chat_completion_usage_cost",
      },
      tokens: {
        prompt: 1200,
        completion: 240,
        reasoning: 90,
        cached: 64,
        total: 1440,
      },
    });

    const [row, ...extraRows] = await readMorningBriefGenerations(f);
    expect(extraRows).toStrictEqual([]);
    expect(row?.state).toBe("succeeded");
    expect(row?.executionPurpose).toBe("preview");
    expect(row?.decision).toBe("deliver");
    expect(row?.promptVersion).toBe(1);
    expect(row?.resultSchemaVersion).toBe(1);
    expect(row?.inputDigest).toHaveLength(64);
    // No prompt or source body is persisted anywhere in the owner row.
    expect(row?.resultMarkdown).not.toContain("blocker cleared");

    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.costValue).toBe("0.004210000000");
    expect(receipts[0]?.operation).toBe("morning_brief_generation");
    expect(Object.keys(receipts[0] ?? {})).not.toContain("orgId");
  });

  it("charges no user credits and creates no Run, Chat, email or usage row", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({ cost: 0.001 });
    });

    const scope = {
      orgId: f.orgId,
      workflowId: f.workflowId,
      automationId: f.automationId,
    };
    const before = await readOwnerBillingFootprint(scope);

    const response = await accept(generate(f), [200]);
    expect(expectGenerated(response.body).generation.state).toBe("succeeded");

    // Nothing the platform pays for may move a user ledger, a Run, a Chat
    // thread binding or an email.
    await expect(readOwnerBillingFootprint(scope)).resolves.toStrictEqual(
      before,
    );
    expect(before).toStrictEqual({
      usageEvents: 0,
      allowanceWindows: 0,
      runs: 0,
      emails: 0,
      automationThreads: 0,
      credits: before.credits,
    });
  });

  it("makes zero model calls for a healthy empty read", async () => {
    const f = await fixture();
    scriptSlack({
      channels: () => {
        return {
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        };
      },
    });
    const traffic = scriptProvider(() => {
      throw new Error("the provider must not be called for an empty read");
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("skipped_empty");
    expect(body.generation.result).toBeNull();
    expect(body.generation.receipt).toBeNull();
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readPlatformGenerationReceipts([])).resolves.toStrictEqual([]);
  });

  it("keeps a bounded read with no candidates distinct from an empty day", async () => {
    const f = await fixture();
    scriptSlack({
      channels: () => {
        return {
          ok: true,
          channels: [{ id: "C1", name: "general", is_private: false }],
          // A continuation the collector cannot follow bounds the read.
          response_metadata: { next_cursor: "" },
        };
      },
      history: () => {
        return {
          ok: true,
          messages: [],
          has_more: true,
          response_metadata: { next_cursor: "" },
        };
      },
    });
    const traffic = scriptProvider(() => {
      throw new Error("the provider must not be called for a bounded read");
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("skipped_incomplete");
    expect(traffic.bodies).toStrictEqual([]);
  });

  it("accepts a validated model skip without delivering anything", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({
        content: JSON.stringify({
          decision: "skip",
          reason: "nothing_actionable",
        }),
        cost: 0,
      });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    expect(body.generation.result).toStrictEqual({
      decision: "skip",
      reason: "nothing_actionable",
    });
    // An explicitly reported zero is a known zero, never an unknown cost.
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "reported",
      value: "0",
      unit: "openrouter_credits",
      source: "chat_completion_usage_cost",
    });
  });

  it.each([
    ["malformed JSON", { content: "not json at all" }, "invalid_json"],
    [
      "a citation this request never supplied",
      { content: deliverContent("m99") },
      "unknown_source_reference",
    ],
    [
      "a truncated completion",
      { finishReason: "length", content: '{"decision":"deliver"' },
      "output_truncated",
    ],
    [
      "an unexpected tool call",
      { finishReason: "tool_calls", content: "" },
      "unexpected_tool_calls",
    ],
    [
      "a model-invented link",
      {
        content: JSON.stringify({
          decision: "deliver",
          title: "Release",
          sections: [
            {
              heading: "Links",
              items: [
                { text: "See https://evil.example/x", sourceIds: ["m1"] },
              ],
            },
          ],
        }),
      },
      "invalid_shape",
    ],
  ])(
    "rejects %s while still recording the observed cost",
    async (_label, options, expectedReason) => {
      const f = await fixture();
      slackWithMessages();
      const traffic = scriptProvider(() => {
        return completion({ ...options, cost: 0.002 });
      });

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.state).toBe("output_rejected");
      expect(body.generation.failureReason).toBe(expectedReason);
      expect(body.generation.result).toBeNull();
      expect(body.generation.receipt?.cost.state).toBe("reported");
      expect(traffic.bodies).toHaveLength(1);

      const [row] = await readMorningBriefGenerations(f);
      expect(row?.state).toBe("output_rejected");
      expect(row?.resultMarkdown).toBeNull();
      const receipts = await readPlatformGenerationReceipts([
        row?.attemptId ?? "",
      ]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.costValue).toBe("0.002000000000");
    },
  );

  it.each([
    ["an absent cost field", {}, "unavailable"],
    ["a malformed cost field", { cost: "0.5" }, "unavailable"],
    ["a negative cost field", { cost: -1 }, "unavailable"],
  ])(
    "records %s as unknown rather than zero",
    async (_label, options, expectedState) => {
      const f = await fixture();
      slackWithMessages();
      scriptProvider(() => {
        return completion(options);
      });

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.state).toBe("succeeded");
      expect(body.generation.receipt?.cost).toStrictEqual({
        state: expectedState,
        value: null,
        unit: null,
        source: null,
      });
      // The generation id is retained so the charge stays reconcilable later.
      expect(body.generation.receipt?.providerGenerationId).toBe(
        "gen-01H0PLATFORM",
      );
      expect(body.generation.receipt?.tokens.prompt).toBe(1200);
    },
  );

  it("records a provider error as a failure with an unknown cost", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return new HttpResponse(JSON.stringify({ error: { code: 503 } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("provider_failed");
    expect(body.generation.failureReason).toBe("provider_error");
    expect(body.generation.receipt?.outcome).toBe("provider_error");
    expect(body.generation.receipt?.cost.state).toBe("invocation_unknown");
  });

  it("bounds an oversized success response instead of reading it", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return new HttpResponse("x".repeat(300 * 1024), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("provider_failed");
    expect(body.generation.failureReason).toBe("response_unreadable");
    expect(body.generation.receipt?.outcome).toBe("response_unreadable");
  });

  it("reduces oversized input deterministically and says so", async () => {
    const f = await fixture();
    // Just inside the collector's own projected-text budget, and past the
    // request ceiling once the instructions and JSON envelope are added.
    const long = "l".repeat(3000);
    slackWithMessages(
      Array.from({ length: 50 }, (_unused, index) => {
        return `${String(index)} ${long}`;
      }),
    );
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.01 });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.inputReduced).toBeTruthy();
    expect(body.generation.includedItems).toBeLessThan(
      body.generation.inputItems,
    );
    expect(
      Buffer.byteLength(traffic.bodies[0] ?? "", "utf8"),
    ).toBeLessThanOrEqual(128 * 1024);
    // The model is told exactly how many candidates did not fit.
    expect(traffic.bodies[0]).toContain("messagesOmittedForSize");
  });

  it("reads an accepted result back without collecting or generating again", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.003 });
    });

    const first = await accept(generate(f), [200]);
    const firstBody = expectGenerated(first.body);
    let slackCalls = 0;
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        slackCalls += 1;
        return HttpResponse.json({ ok: true, channels: [] });
      }),
    );

    const second = await accept(generate(f), [200]);
    if (second.body.result !== "already-generated") {
      throw new Error(`Expected already-generated, got ${second.body.result}`);
    }
    expect(second.body.generation.attemptId).toBe(
      firstBody.generation.attemptId,
    );
    expect(second.body.generation.state).toBe("succeeded");
    expect(second.body.generation.result).toStrictEqual(
      firstBody.generation.result,
    );
    expect(traffic.bodies).toHaveLength(1);
    expect(slackCalls).toBe(0);
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
  });

  it("contacts no provider before the reservation is durable", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.004 });
    });
    const barrier = await holdMorningBriefGenerationReservation(
      { orgId: f.orgId, userId: f.userId },
      context.signal,
    );

    const pending = accept(generate(f), [200]);
    await barrier.waitForArrival();
    // The attempt has written its reservation and is blocked before COMMIT.
    expect(traffic.bodies).toStrictEqual([]);

    await barrier.release();
    const response = await pending;
    expect(expectGenerated(response.body).generation.state).toBe("succeeded");
    expect(traffic.bodies).toHaveLength(1);
  });

  it("resolves a lapsed reservation as unknown and never sends again", async () => {
    const f = await fixture();
    slackWithMessages();
    const restore = await failMorningBriefGenerationUpdates(
      { orgId: f.orgId, userId: f.userId },
      context.signal,
    );
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.006 });
    });

    // A real database fault after the provider succeeded.
    const first = await accept(generate(f), [200]);
    const firstBody = expectGenerated(first.body);
    expect(firstBody.generation.state).toBe("reserved");
    expect(firstBody.generation.failureReason).toBe("persistence_failed");
    expect(traffic.bodies).toHaveLength(1);
    const [reserved] = await readMorningBriefGenerations(f);
    expect(reserved?.state).toBe("reserved");
    const receipts = await readPlatformGenerationReceipts([
      reserved?.attemptId ?? "",
    ]);
    expect(receipts).toHaveLength(1);

    await restore();
    await expireMorningBriefGenerationReservation(f, new Date(now() - 1000));

    const second = await accept(generate(f), [200]);
    if (second.body.result !== "already-generated") {
      throw new Error(`Expected already-generated, got ${second.body.result}`);
    }
    expect(second.body.generation.state).toBe("invocation_outcome_unknown");
    expect(second.body.generation.result).toBeNull();
    // No second POST, and still exactly one cost record.
    expect(traffic.bodies).toHaveLength(1);
    await expect(
      readPlatformGenerationReceipts([reserved?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);
  });

  it("refuses a concurrent attempt while a reservation is live", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.005 });
    });
    const restore = await failMorningBriefGenerationUpdates(
      { orgId: f.orgId, userId: f.userId },
      context.signal,
    );
    await accept(generate(f), [200]);
    await restore();

    const conflict = await accept(generate(f), [409]);
    expect(conflict.body.error.code).toBe(
      "MORNING_BRIEF_GENERATION_IN_PROGRESS",
    );
    expect(traffic.bodies).toHaveLength(1);
  });

  it("reports a collect-only occurrence rather than inventing a result", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      throw new Error("a completed collect-only occurrence must not generate");
    });

    const collected = await accept(
      collectOnlyClient().collect({
        headers: f.headers,
        body: { scheduledFor: ANCHOR },
      }),
      [200],
    );
    expect(collected.body.result).toBe("collected");

    const response = await accept(generate(f), [200]);
    expect(response.body.result).toBe(
      "collection-completed-without-generation",
    );
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
  });

  it("drops an expired preview result and leaves other owners alone", async () => {
    const f = await fixture();
    const other = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({ cost: 0.002 });
    });
    await accept(generate(f), [200]);
    await accept(generate(other), [200]);
    await expireMorningBriefGenerationRetention(f, new Date(now() - 1000));

    const response = await accept(generate(f), [200]);
    expect(response.body.result).toBe(
      "collection-completed-without-generation",
    );
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
    await expect(readMorningBriefGenerations(other)).resolves.toHaveLength(1);
  });

  it("keeps no accepted content when the member is removed mid-flight", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(async () => {
      // The owner loses the membership while the provider request is open.
      await removeMorningBriefMember(f);
      return completion({ cost: 0.008 });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.failureReason).toBe("owner_revoked");
    expect(body.generation.result).toBeNull();
    expect(traffic.bodies).toHaveLength(1);
    // The owner rows cascaded away; the anonymous receipt survived.
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
    await expect(
      readPlatformGenerationReceipts([body.generation.attemptId]),
    ).resolves.toHaveLength(1);
  });

  it("uses the documented default language when the member has no locale", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.001 });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.language).toBe("en-US");
    expect(body.generation.languageSource).toBe("default");
    expect(traffic.bodies[0]).toContain("en-US");
  });
});

/**
 * A held provider request, with a chance to change the world while it is open.
 *
 * The response is produced only after `duringRequest` has finished, so every
 * mutation it performs is already committed when the answer comes back — the
 * exact interleaving where a stale authority could still be accepted.
 */
function scriptHeldProvider(
  duringRequest: () => Promise<void>,
  options: { readonly cost?: unknown } = {},
): ProviderTraffic {
  return scriptProvider(async () => {
    await duringRequest();
    return completion({ cost: options.cost ?? 0.007 });
  });
}

describe("Morning Brief platform-funded generation authority", () => {
  it.each([
    [
      "the brief is disabled",
      async (f: Fixture) => {
        await pauseMorningBriefAutomation(f.automationId);
      },
    ],
    [
      "the installation Agent is deleted",
      async (f: Fixture) => {
        await deleteMorningBriefAgent(f.agentId);
      },
    ],
    [
      "the member leaves and rejoins",
      async (f: Fixture) => {
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
      },
    ],
    [
      "the connected Slack account is rebound",
      async (f: Fixture) => {
        await rebindMorningBriefSlackAccount(
          f.userId,
          `U${randomUUID().slice(0, 8)}`,
        );
      },
    ],
  ])(
    "accepts no content when %s while the request is open",
    async (_label, mutate) => {
      const f = await fixture();
      slackWithMessages();
      const traffic = scriptHeldProvider(async () => {
        await mutate(f);
      });

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.state).not.toBe("succeeded");
      expect(body.generation.result).toBeNull();
      expect(traffic.bodies).toHaveLength(1);
      // The charge really happened, so it is kept even though the answer is not.
      expect(body.generation.receipt?.cost.state).toBe("reported");
      await expect(
        readPlatformGenerationReceipts([body.generation.attemptId]),
      ).resolves.toHaveLength(1);

      const [row] = await readMorningBriefGenerations(f);
      // A deleted Agent cascades the occurrence away; everything else leaves a
      // terminal slot that carries no owner content.
      if (row) {
        expect(row.state).not.toBe("succeeded");
        expect(row.resultMarkdown).toBeNull();
      }
    },
  );

  it("makes no provider request when authority lapses before the call", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      throw new Error("a lapsed authority must not reach the provider");
    });
    // Suspended after the reservation INSERT and before its COMMIT, which is
    // the only window between owning the slot and using it.
    const barrier = await holdMorningBriefGenerationReservation(
      f,
      context.signal,
    );

    const pending = accept(generate(f), [200]);
    await barrier.waitForArrival();
    await pauseMorningBriefAutomation(f.automationId);
    await barrier.release();

    const response = await pending;
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("not_invoked");
    expect(body.generation.failureReason).toBe("owner_revoked");
    expect(body.generation.receipt).toBeNull();
    expect(traffic.bodies).toStrictEqual([]);
  });

  it("makes no provider request when the preflight consumes the reservation", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      throw new Error("an exhausted reservation must not reach the provider");
    });

    // Hold the real pre-contact authority preflight. It is identified by the
    // state it runs in rather than by a call index: the reservation row exists
    // only after the collection transaction committed, which is exactly the
    // window between owning the slot and using it.
    const arrived = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const memberships =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    const resolveMemberships = memberships.getMockImplementation();
    let held = false;
    memberships.mockImplementation(async (...callArgs: unknown[]) => {
      if (!held && (await readMorningBriefGenerations(f)).length > 0) {
        held = true;
        arrived.resolve();
        await release.promise;
      }
      return await resolveMemberships?.(...callArgs);
    });

    const pending = accept(generate(f), [200]);
    await arrived.promise;
    // The reservation lapses while the preflight is still blocked.
    mockNow(now() + 2 * 60 * 1000);
    release.resolve();

    const response = await pending;
    const body = expectGenerated(response.body);
    // Proven before contact, so it is a known outcome and not an unknown one.
    expect(body.generation.state).toBe("not_invoked");
    expect(body.generation.failureReason).toBe("reservation_expired");
    expect(body.generation.result).toBeNull();
    expect(body.generation.receipt).toBeNull();
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readPlatformGenerationReceipts([])).resolves.toStrictEqual([]);
  });

  it("does not release a stored result after the brief is disabled", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({ cost: 0.002 });
    });
    const first = await accept(generate(f), [200]);
    expect(expectGenerated(first.body).generation.state).toBe("succeeded");

    await pauseMorningBriefAutomation(f.automationId);
    const second = await accept(generate(f), [200]);
    if (second.body.result !== "not-executed") {
      throw new Error(`Expected not-executed, got ${second.body.result}`);
    }
    expect(second.body.reason).toBe("brief-paused");
    // The result still exists; it is simply not this authority's to read.
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
  });

  it("does not release a stored result under a different Slack binding", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({ cost: 0.002 });
    });
    await accept(generate(f), [200]);

    await rebindMorningBriefSlackAccount(
      f.userId,
      `U${randomUUID().slice(0, 8)}`,
    );

    const conflict = await accept(generate(f), [409]);
    expect(conflict.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
    );
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
  });

  it("refuses content whose reservation expired while persistence waited", async () => {
    const f = await fixture();
    slackWithMessages();
    // The branch that lets the reservation lapse runs while the request is
    // still open, so it is kept and joined rather than left floating.
    let lapsed: Promise<void> | undefined;
    const traffic = scriptProvider(async () => {
      // Hold the row every guarded write locks first, then let real time pass
      // beyond the reservation only after persistence is already blocked on it.
      const held = await holdMorningBriefOwnerRow(f, context.signal);
      lapsed = (async () => {
        await held.waitForArrival();
        mockNow(now() + 2 * 60 * 1000);
        await held.release();
      })();
      return completion({ cost: 0.009 });
    });

    const response = await accept(generate(f), [200]);
    await lapsed;
    const body = expectGenerated(response.body);
    // The answer arrived before the deadline and was still refused, because the
    // admission clock is sampled where the write is actually admitted.
    expect(body.generation.state).toBe("result_discarded");
    expect(body.generation.failureReason).toBe("reservation_expired");
    expect(body.generation.result).toBeNull();
    expect(traffic.bodies).toHaveLength(1);
    await expect(
      readPlatformGenerationReceipts([body.generation.attemptId]),
    ).resolves.toHaveLength(1);
  });
});

describe("Morning Brief platform-funded generation cost reconciliation", () => {
  it("reconciles a missing cost from the read-only generation record", async () => {
    const f = await fixture();
    slackWithMessages();
    const lookups: string[] = [];
    server.use(
      http.get(OPENROUTER_GENERATION_URL, ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        lookups.push(id);
        return HttpResponse.json({
          data: {
            id,
            is_byok: false,
            total_cost: 0.0015,
            upstream_inference_cost: 0.0012,
          },
        });
      }),
    );
    scriptProvider(() => {
      return completion({});
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(lookups).toStrictEqual(["gen-01H0PLATFORM"]);
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "reported",
      value: "0.0015",
      unit: "openrouter_credits",
      source: "generation_total_cost",
    });
    const [row] = await readMorningBriefGenerations(f);
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts[0]?.costValue).toBe("0.001500000000");
  });

  it.each([
    [
      "a 404",
      () => {
        return new HttpResponse("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    ],
    [
      "a record for another generation",
      () => {
        return HttpResponse.json({
          data: { id: "gen-other", is_byok: false, total_cost: 9.99 },
        });
      },
    ],
    [
      "a BYOK record",
      () => {
        return HttpResponse.json({
          data: { id: "gen-01H0PLATFORM", is_byok: true, total_cost: 0.5 },
        });
      },
    ],
    [
      "a malformed amount",
      () => {
        return HttpResponse.json({
          data: { id: "gen-01H0PLATFORM", is_byok: false, total_cost: "0.5" },
        });
      },
    ],
  ])("leaves the cost unknown for %s", async (_label, reply) => {
    const f = await fixture();
    slackWithMessages();
    server.use(http.get(OPENROUTER_GENERATION_URL, reply));
    const traffic = scriptProvider(() => {
      return completion({});
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "unavailable",
      value: null,
      unit: null,
      source: null,
    });
    // Reconciliation never sends the completion again.
    expect(traffic.bodies).toHaveLength(1);
  });

  it("does not look up a cost the completion already reported", async () => {
    const f = await fixture();
    slackWithMessages();
    let lookups = 0;
    server.use(
      http.get(OPENROUTER_GENERATION_URL, () => {
        lookups += 1;
        return HttpResponse.json({ data: {} });
      }),
    );
    scriptProvider(() => {
      return completion({ cost: 0 });
    });

    const response = await accept(generate(f), [200]);
    expect(expectGenerated(response.body).generation.receipt?.cost.state).toBe(
      "reported",
    );
    expect(lookups).toBe(0);
  });
});

describe("Morning Brief platform-funded generation output validation", () => {
  it("rejects tool calls the provider labelled as a normal stop", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return {
        id: "gen-01H0PLATFORM",
        model: "google/gemini-3.8-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: deliverContent(),
              tool_calls: [{ id: "call_1", type: "function" }],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
      };
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("output_rejected");
    expect(body.generation.failureReason).toBe("unexpected_tool_calls");
    expect(body.generation.result).toBeNull();
    expect(body.generation.receipt?.cost.state).toBe("reported");
  });

  it("rejects a result carrying fields the contract never declared", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({
        cost: 0.001,
        content: JSON.stringify({
          decision: "deliver",
          title: "Release readiness",
          sections: [
            {
              heading: "Decisions",
              items: [
                {
                  text: "The release ships today.",
                  sourceIds: ["m1"],
                  priority: "high",
                },
              ],
            },
          ],
        }),
      });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("output_rejected");
    expect(body.generation.failureReason).toBe("invalid_shape");
  });

  it("records fractional token counts as unavailable rather than rounding", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({
        cost: 0.001,
        usage: { prompt_tokens: 12.5, completion_tokens: -3 },
      });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.receipt?.tokens.prompt).toBeNull();
    expect(body.generation.receipt?.tokens.completion).toBeNull();
    // A usable count beside a malformed one is still recorded.
    expect(body.generation.receipt?.tokens.total).toBe(1440);
  });
});

describe("Morning Brief platform-funded generation admission", () => {
  it("is unavailable in production even with the implementation switch on", async () => {
    const f = await fixture();
    const traffic = scriptProvider(() => {
      throw new Error("production must never reach the provider");
    });
    mockEnv("ENV", "production");

    const denied = await accept(generate(f), [404]);
    expect(denied.body).toBe("Not found");
    expect(traffic.bodies).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
  });

  it("rejects an unauthenticated caller before any collection or request", async () => {
    const f = await fixture();
    const traffic = scriptProvider(() => {
      throw new Error("an unauthenticated caller must not reach the provider");
    });

    await accept(
      generationClient().preview({
        headers: { authorization: "" },
        body: { scheduledFor: ANCHOR },
      }),
      [401],
    );
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
  });

  it("rejects a caller without the Slack read capability", async () => {
    const f = await fixture({ capabilities: [] });
    const traffic = scriptProvider(() => {
      throw new Error("an unauthorized caller must not reach the provider");
    });

    await accept(generate(f), [403]);
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
  });

  it.each([
    [
      "the implementation switch is off",
      { feature: false },
      "feature-disabled",
    ],
    ["the brief is paused", { enabled: false }, "brief-paused"],
    [
      "the platform credential is missing",
      { llmConfigured: false },
      "generation-not-configured",
    ],
  ])("does not execute when %s", async (_label, options, reason) => {
    const f = await fixture(options);
    const traffic = scriptProvider(() => {
      throw new Error("a refused admission must not reach the provider");
    });

    const response = await accept(generate(f), [200]);
    if (response.body.result !== "not-executed") {
      throw new Error(`Expected not-executed, got ${response.body.result}`);
    }
    expect(response.body.reason).toBe(reason);
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
  });

  it("rejects an anchor outside the supported window before anything runs", async () => {
    const f = await fixture();
    const traffic = scriptProvider(() => {
      throw new Error("an invalid anchor must not reach the provider");
    });

    await accept(
      generate(f, new Date(now() + 10 * 60 * 1000).toISOString()),
      [400],
    );
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
  });
});
