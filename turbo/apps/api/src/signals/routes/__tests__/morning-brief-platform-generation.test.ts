import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
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
  holdMorningBriefCollectionOccurrence,
  pauseMorningBriefAutomation,
  readMorningBriefCollectionOccurrences,
  restrictMorningBriefAgent,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-collection";
import {
  expireMorningBriefGenerationRetention,
  expireMorningBriefGenerationReservation,
  failMorningBriefGenerationUpdates,
  holdMorningBriefGenerationReservation,
  holdMorningBriefOwnerRow,
  interceptPlatformGenerationReceiptWrites,
  readMorningBriefGenerations,
  readOwnerBillingFootprint,
  readPlatformGenerationReceipts,
  rebindMorningBriefSlackAccount,
  removeMorningBriefMember,
  setMorningBriefMemberLocale,
} from "../../../test-fixtures/morning-brief-generation";
import { upsertOrgMetadataFixture } from "../../../test-fixtures/org-metadata";
import { waitForDeferredBlocker } from "../../../test-fixtures/pi-deferred-lock";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { modelProvidersRoutes } from "../model-providers";
import { morningBriefCollectionPreviewRoutes } from "../morning-brief-collection-preview";
import { morningBriefGenerationPreviewRoutes } from "../morning-brief-generation-preview";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

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

/**
 * Run the retention batch the maintenance tick runs, through its endpoint.
 *
 * It takes no owner: this is the global, bounded consumer, and the point of the
 * assertions around it is that an owner who never invokes the preview again
 * still loses their expired content.
 */
async function runRetentionMaintenance(): Promise<number> {
  const response = await accept(
    setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
      testWorkflowAutomationExecutionContract,
    ).retainMorningBriefGenerations({ body: {} }),
    [200],
  );
  return response.body.purged;
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
      recorded: "durable",
      provider: "openrouter",
      requestedModel: "google/gemini-3.8-flash",
      returnedModel: "google/gemini-3.8-flash",
      providerGenerationId: "gen-01H0PLATFORM",
      outcome: "response_received",
      cost: {
        state: "reported",
        // Reported in the exact decimal the receipt column holds, so the
        // answer and the stored row below carry one identical amount.
        value: "0.004210000000",
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
      value: "0.000000000000",
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

  it.each<
    readonly [
      string,
      {
        readonly title?: string;
        readonly heading?: string;
        readonly text?: string;
      },
    ]
  >([
    ["a title", { title: "\u0001" }],
    ["a heading", { heading: "\u0001" }],
    ["an item", { text: "\u0001" }],
  ])(
    "rejects a deliver whose %s is empty once escaped",
    async (_label, override) => {
      const f = await fixture();
      slackWithMessages();
      scriptProvider(() => {
        return completion({
          // U+0001 is not whitespace, so it survives trim and a min-length
          // check, and then escaping turns it into a space and trims it away.
          content: JSON.stringify({
            decision: "deliver",
            title: override.title ?? "Release readiness",
            sections: [
              {
                heading: override.heading ?? "Decisions",
                items: [
                  {
                    text: override.text ?? "The release ships today.",
                    sourceIds: ["m1"],
                  },
                ],
              },
            ],
          }),
          cost: 0.01,
        });
      });

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.state).toBe("output_rejected");
      expect(body.generation.result).toBeNull();
      // The charge still happened; a rejection never rewrites what was spent.
      expect(body.generation.receipt?.outcome).toBe("response_received");
    },
  );

  it("forces a coverage statement into the delivered markdown when input was reduced", async () => {
    const f = await fixture();
    const long = "l".repeat(3000);
    slackWithMessages(
      Array.from({ length: 50 }, (_unused, index) => {
        return `${String(index)} ${long}`;
      }),
    );
    scriptProvider(() => {
      return completion({ cost: 0.01 });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.inputReduced).toBeTruthy();
    const markdown =
      body.generation.result?.decision === "deliver"
        ? body.generation.result.markdown
        : "";
    // The reduction now reaches the reader, not only the prompt and metadata.
    expect(markdown).toContain("Coverage:");
    expect(markdown).toContain("did not fit this summary");
    // The count is the program's own, taken from the same plan the request used.
    const omitted = body.generation.inputItems - body.generation.includedItems;
    expect(markdown).toContain(omitted.toString());
  });

  it("writes the coverage statement in the language the brief was frozen to", async () => {
    const f = await fixture({ locale: "ja-JP" });
    const long = "l".repeat(3000);
    slackWithMessages(
      Array.from({ length: 50 }, (_unused, index) => {
        return `${String(index)} ${long}`;
      }),
    );
    scriptProvider(() => {
      return completion({ cost: 0.01 });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.language).toBe("ja-JP");
    const markdown =
      body.generation.result?.decision === "deliver"
        ? body.generation.result.markdown
        : "";
    expect(markdown).toContain("カバレッジ");
    expect(markdown).not.toContain("Coverage:");
  });

  it("adds no coverage statement to a complete brief", async () => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({ cost: 0.01 });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.inputReduced).toBeFalsy();
    const markdown =
      body.generation.result?.decision === "deliver"
        ? body.generation.result.markdown
        : "";
    // A complete read that dropped nothing has nothing to disclose, and a note
    // on every brief would train readers to ignore the ones that matter.
    expect(markdown).not.toContain("Coverage:");
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
      value: "0.001500000000",
      unit: "openrouter_credits",
      source: "generation_total_cost",
    });
    const [row] = await readMorningBriefGenerations(f);
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    // The reconciled amount the answer reported and the amount the column
    // holds are one value, not two representations of it.
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

/**
 * The receipt's durable domain.
 *
 * These cover the boundary between what the adapter accepts and what the
 * receipt columns actually hold. Each case runs through the real route and real
 * PostgreSQL, because the failures they protect against are storage failures:
 * an `integer out of range` that aborts the whole INSERT, and a `numeric(24,12)`
 * that silently rounds a real charge to a durable zero.
 */
describe("Morning Brief platform receipt data domain", () => {
  it("keeps an out-of-domain token count from discarding the charge", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      return completion({
        cost: 0.000125,
        // One above the receipt column's `integer` ceiling. PostgreSQL rejects
        // the value, so accepting it here used to fail the whole receipt.
        usage: { prompt_tokens: 2_147_483_648 },
      });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    // The unusable count is the only thing lost.
    expect(body.generation.receipt?.tokens).toStrictEqual({
      prompt: null,
      completion: 240,
      reasoning: 90,
      cached: 64,
      total: 1440,
    });
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "reported",
      value: "0.000125000000",
      unit: "openrouter_credits",
      source: "chat_completion_usage_cost",
    });
    expect(body.generation.receipt?.recorded).toBe("durable");
    expect(traffic.bodies).toHaveLength(1);

    const [row, ...extraRows] = await readMorningBriefGenerations(f);
    expect(extraRows).toStrictEqual([]);
    // The slot resolves instead of staying reserved for a request that is over.
    expect(row?.state).toBe("succeeded");
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.costValue).toBe("0.000125000000");
    expect(receipts[0]?.promptTokens).toBeNull();
    expect(receipts[0]?.totalTokens).toBe(1440);
  });

  it.each([
    ["the column ceiling", 2_147_483_647, 2_147_483_647],
    ["one above the column ceiling", 2_147_483_648, null],
    ["a safe integer past the column", Number.MAX_SAFE_INTEGER, null],
  ])("records %s as %s", async (_label, reported, stored) => {
    const f = await fixture();
    slackWithMessages();
    scriptProvider(() => {
      return completion({ cost: 0.001, usage: { prompt_tokens: reported } });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.receipt?.tokens.prompt).toBe(stored);
    const [row] = await readMorningBriefGenerations(f);
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts[0]?.promptTokens).toBe(stored);
  });

  it.each([
    ["a reported zero", 0, "0.000000000000"],
    ["an ordinary amount", 0.00125, "0.001250000000"],
    ["the smallest storable amount", 1e-12, "0.000000000001"],
    [
      "the largest storable amount",
      999_999_999_999.999,
      "999999999999.999000000000",
    ],
  ])(
    "preserves %s exactly through storage and reread",
    async (_l, cost, value) => {
      const f = await fixture();
      slackWithMessages();
      scriptProvider(() => {
        return completion({ cost });
      });

      const response = await accept(generate(f), [200]);
      const first = expectGenerated(response.body);
      expect(first.generation.receipt?.cost).toStrictEqual({
        state: "reported",
        value,
        unit: "openrouter_credits",
        source: "chat_completion_usage_cost",
      });
      const [row] = await readMorningBriefGenerations(f);
      const receipts = await readPlatformGenerationReceipts([
        row?.attemptId ?? "",
      ]);
      expect(receipts[0]?.costValue).toBe(value);

      // The reread an external caller can make reports the same amount, so the
      // initial answer and the durable record never disagree.
      const second = await accept(generate(f), [200]);
      if (second.body.result !== "already-generated") {
        throw new Error(
          `Expected already-generated, got ${second.body.result}`,
        );
      }
      expect(second.body.generation.receipt?.cost.value).toBe(value);
      expect(second.body.generation.receipt?.recorded).toBe("durable");
    },
  );

  it.each([
    ["an amount finer than the stored scale", 1e-13],
    ["an amount wider than the stored precision", 1e12],
  ])("reports %s as unavailable rather than rounding it", async (_l, cost) => {
    const f = await fixture();
    slackWithMessages();
    let lookups = 0;
    server.use(
      http.get(OPENROUTER_GENERATION_URL, () => {
        lookups += 1;
        return HttpResponse.json({ data: {} });
      }),
    );
    const traffic = scriptProvider(() => {
      return completion({ cost });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    // Explicitly not a known zero: the charge is real and its amount is not
    // representable, so it stays unknown with the generation id retained.
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "unavailable",
      value: null,
      unit: null,
      source: null,
    });
    expect(body.generation.receipt?.providerGenerationId).toBe(
      "gen-01H0PLATFORM",
    );
    const [row] = await readMorningBriefGenerations(f);
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.costValue).toBeNull();
    expect(receipts[0]?.costState).toBe("unavailable");
    // An unrepresentable inline amount is still reconciled once, and never by
    // a second completion.
    expect(lookups).toBe(1);
    expect(traffic.bodies).toHaveLength(1);
  });

  it.each([
    ["an amount the column holds", 1e-12, "0.000000000001", "reported"],
    ["an amount finer than its scale", 1e-13, null, "unavailable"],
  ])(
    "applies the same durable contract to %s from the lookup",
    async (_l, total, value, state) => {
      const f = await fixture();
      slackWithMessages();
      server.use(
        http.get(OPENROUTER_GENERATION_URL, ({ request }) => {
          return HttpResponse.json({
            data: {
              id: new URL(request.url).searchParams.get("id") ?? "",
              is_byok: false,
              total_cost: total,
            },
          });
        }),
      );
      scriptProvider(() => {
        return completion({});
      });

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.receipt?.cost.state).toBe(state);
      expect(body.generation.receipt?.cost.value).toBe(value);
      const [row] = await readMorningBriefGenerations(f);
      const receipts = await readPlatformGenerationReceipts([
        row?.attemptId ?? "",
      ]);
      expect(receipts[0]?.costValue).toBe(value);
    },
  );
});

/**
 * The receipt outlives what happens to the owner's request.
 *
 * The charge is incurred at the provider, so the record of it is owed before
 * cancellation or a failed authority resolution can end this request. These
 * suspend and fail the real INSERT rather than a stub, so "the retry finished"
 * is observed rather than assumed.
 */
describe("Morning Brief platform receipt durability", () => {
  it("records the charge when the caller cancels while the write waits", async () => {
    const f = await fixture();
    slackWithMessages();
    const cancellation = new Error(`cancelled ${randomUUID()}`);
    const controller = new AbortController();
    // The first write fails, and every write for this invocation blocks until
    // released — so cancellation lands while the INSERT is genuinely waiting.
    const { barrier } = await interceptPlatformGenerationReceiptWrites(
      { generationId: "gen-01H0PLATFORM", failures: 1, suspend: true },
      context.signal,
    );
    if (!barrier) {
      throw new Error("Expected a suspended receipt write");
    }
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.00042 });
    });

    const pending = setupApp({
      context,
      routes: morningBriefGenerationPreviewRoutes,
      signal: controller.signal,
      rethrowErrors: true,
    })(morningBriefGenerationPreviewContract).preview({
      headers: f.headers,
      body: { scheduledFor: ANCHOR },
    });
    await barrier.waitForArrival();
    controller.abort(cancellation);
    await barrier.release();

    // Cancellation still reaches the caller: recording a charge is not
    // permission to accept anything.
    await expect(pending).rejects.toThrow(cancellation.message);
    expect(traffic.bodies).toHaveLength(1);

    const [row, ...extraRows] = await readMorningBriefGenerations(f);
    expect(extraRows).toStrictEqual([]);
    // No owner content was accepted or released by the cancelled request.
    expect(row?.state).toBe("reserved");
    expect(row?.resultMarkdown).toBeNull();
    expect(row?.resultTitle).toBeNull();

    // The charge an external caller can actually see: settling the lapsed
    // reservation reports the exact amount the cancelled request observed.
    await expireMorningBriefGenerationReservation(f, new Date(now() - 1000));
    const settled = await accept(generate(f), [200]);
    if (settled.body.result !== "already-generated") {
      throw new Error(`Expected already-generated, got ${settled.body.result}`);
    }
    expect(settled.body.generation.state).toBe("invocation_outcome_unknown");
    expect(settled.body.generation.result).toBeNull();
    expect(settled.body.generation.receipt).toMatchObject({
      recorded: "durable",
      outcome: "response_received",
      cost: { state: "reported", value: "0.000420000000" },
    });
    // Still one POST, and the transient failure produced exactly one record.
    expect(traffic.bodies).toHaveLength(1);
    await expect(
      readPlatformGenerationReceipts([row?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);
  });

  it("records the charge when resolving the live authority fails afterwards", async () => {
    const f = await fixture();
    slackWithMessages();
    const authorityFailure = new Error(
      `membership unavailable ${randomUUID()}`,
    );
    await interceptPlatformGenerationReceiptWrites(
      { generationId: "gen-01H0PLATFORM", failures: 1 },
      context.signal,
    );
    const traffic = scriptProvider(() => {
      // The next membership read is the post-response authority check, and it
      // fails while the provider request is still open. Later reads recover,
      // so this is a transient dependency failure rather than a lapse.
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValueOnce(
        authorityFailure,
      );
      return completion({ cost: 0.00061 });
    });

    await expect(
      setupApp({
        context,
        routes: morningBriefGenerationPreviewRoutes,
        rethrowErrors: true,
      })(morningBriefGenerationPreviewContract).preview({
        headers: f.headers,
        body: { scheduledFor: ANCHOR },
      }),
    ).rejects.toThrow(authorityFailure.message);
    expect(traffic.bodies).toHaveLength(1);

    const [row] = await readMorningBriefGenerations(f);
    expect(row?.state).toBe("reserved");
    // The resolution failure left the request, but not the charge: the amount
    // is reported back through the endpoint once the reservation lapses.
    await expireMorningBriefGenerationReservation(f, new Date(now() - 1000));
    const settled = await accept(generate(f), [200]);
    if (settled.body.result !== "already-generated") {
      throw new Error(`Expected already-generated, got ${settled.body.result}`);
    }
    expect(settled.body.generation.state).toBe("invocation_outcome_unknown");
    expect(settled.body.generation.receipt).toMatchObject({
      recorded: "durable",
      cost: { state: "reported", value: "0.000610000000" },
    });
    expect(traffic.bodies).toHaveLength(1);
    await expect(
      readPlatformGenerationReceipts([row?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);
  });

  it("reports an unresolved charge when every write attempt fails", async () => {
    const f = await fixture();
    slackWithMessages();
    // Storage never recovers for this invocation: the bound below is well
    // above every attempt the executor is permitted to make.
    await interceptPlatformGenerationReceiptWrites(
      { generationId: "gen-01H0PLATFORM", failures: 99 },
      context.signal,
    );
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.00073 });
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    // Finite exhaustion is stated, not hidden behind a durable-looking receipt
    // and never behind a cost of zero.
    expect(body.generation.receipt?.recorded).toBe("unresolved");
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "reported",
      value: "0.000730000000",
      unit: "openrouter_credits",
      source: "chat_completion_usage_cost",
    });
    // The owner-scoped write does not wait on accounting.
    expect(body.generation.state).toBe("succeeded");

    // A reread reports no receipt at all, because none was stored. Nothing
    // invented a durable record, and no repeat POST tried to obtain one.
    const reread = await accept(generate(f), [200]);
    if (reread.body.result !== "already-generated") {
      throw new Error(`Expected already-generated, got ${reread.body.result}`);
    }
    expect(reread.body.generation.receipt).toBeNull();
    expect(reread.body.generation.state).toBe("succeeded");
    const [row] = await readMorningBriefGenerations(f);
    await expect(
      readPlatformGenerationReceipts([row?.attemptId ?? ""]),
    ).resolves.toStrictEqual([]);
    expect(traffic.bodies).toHaveLength(1);
  });

  it("keeps one receipt across repeated reads and invalid model output", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      return completion({ content: "not json at all", cost: 0.00019 });
    });

    const first = await accept(generate(f), [200]);
    const firstBody = expectGenerated(first.body);
    expect(firstBody.generation.state).toBe("output_rejected");
    // A refused answer was still paid for.
    expect(firstBody.generation.receipt?.cost.value).toBe("0.000190000000");
    expect(firstBody.generation.receipt?.recorded).toBe("durable");

    const second = await accept(generate(f), [200]);
    if (second.body.result !== "already-generated") {
      throw new Error(`Expected already-generated, got ${second.body.result}`);
    }
    expect(second.body.generation.receipt).toStrictEqual(
      firstBody.generation.receipt,
    );
    expect(traffic.bodies).toHaveLength(1);
    await expect(
      readPlatformGenerationReceipts([firstBody.generation.attemptId]),
    ).resolves.toHaveLength(1);
  });
});

/**
 * Okou pays, and only Okou's credential is used.
 *
 * The organization below is persisted with an explicit zero balance and the
 * member configures their own OpenRouter key, so a path that consulted either
 * one would either refuse the request or send it somewhere else.
 */
describe("Morning Brief platform-funded generation is platform-paid", () => {
  it("generates for a zero-credit org without using the member's own key", async () => {
    const f = await fixture();
    await upsertOrgMetadataFixture({
      orgId: f.orgId,
      tier: "free",
      credits: 0,
    });
    // A real, member-owned OpenRouter credential for the same organization.
    // The provider API is a Settings surface, so it is configured through a
    // session the way the member really would.
    createRouteMocks(context).clerk.session(f.userId, f.orgId);
    const configured = await accept(
      setupApp({ context, routes: modelProvidersRoutes })(
        modelProvidersMainContract,
      ).upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "openrouter-api-key", secret: "member-openrouter-key" },
      }),
      [200, 201],
    );
    expect(configured.body.provider.type).toBe("openrouter-api-key");
    slackWithMessages();
    const credentials: (string | null)[] = [];
    server.use(
      http.post(OPENROUTER_URL, ({ request }) => {
        credentials.push(request.headers.get("authorization"));
        return HttpResponse.json(completion({ cost: 0.00052 }));
      }),
    );

    const scope = {
      orgId: f.orgId,
      workflowId: f.workflowId,
      automationId: f.automationId,
    };
    const before = await readOwnerBillingFootprint(scope);
    expect(before).toStrictEqual({
      usageEvents: 0,
      allowanceWindows: 0,
      runs: 0,
      emails: 0,
      automationThreads: 0,
      // Established as an exact zero rather than accepted as whatever the
      // fixture happened to hold or left absent.
      credits: 0,
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    // The platform credential, never the member's, and exactly once.
    expect(credentials).toStrictEqual(["Bearer platform-openrouter-key"]);
    expect(body.generation.receipt?.cost.value).toBe("0.000520000000");
    expect(body.generation.receipt?.recorded).toBe("durable");

    // No debit, reservation, usage row, Run, Chat thread or email followed.
    await expect(readOwnerBillingFootprint(scope)).resolves.toStrictEqual(
      before,
    );
  });
});

/**
 * A client whose requests carry a signal this test can cancel.
 *
 * The route handler is given exactly this signal, so aborting it is the real
 * caller-went-away path rather than a stand-in for one.
 */
function cancellableGeneration(signal: AbortSignal) {
  return setupApp({
    context,
    routes: morningBriefGenerationPreviewRoutes,
    signal,
  })(morningBriefGenerationPreviewContract);
}

describe("Morning Brief platform-funded generation commit admission", () => {
  it("commits no owner content when the caller cancels while persistence waits", async () => {
    const f = await fixture();
    slackWithMessages();
    const controller = new AbortController();
    // The branch that cancels runs while the request is still open, so it is
    // kept and joined rather than left floating.
    let cancelled: Promise<void> | undefined;
    const traffic = scriptProvider(async () => {
      // Hold the row every guarded write locks first. The caller goes away only
      // once persistence is really blocked on it, which is the exact window
      // where a post-write cancellation check would arrive too late.
      const held = await holdMorningBriefOwnerRow(f, context.signal);
      cancelled = (async () => {
        await held.waitForArrival();
        controller.abort();
        await held.release();
      })();
      return completion({ cost: 0.004 });
    });

    const outcome = await settleIncludingAbort(
      cancellableGeneration(controller.signal).preview({
        headers: f.headers,
        body: { scheduledFor: ANCHOR },
      }),
    );
    await cancelled;
    // A cancelled request reports nothing; what matters is what it left behind.
    expect(outcome.ok && outcome.value.status === 200).toBeFalsy();
    expect(traffic.bodies).toHaveLength(1);

    const [row, ...extraRows] = await readMorningBriefGenerations(f);
    expect(extraRows).toStrictEqual([]);
    expect(row?.state).toBe("reserved");
    expect(row?.decision).toBeNull();
    expect(row?.resultTitle).toBeNull();
    expect(row?.resultMarkdown).toBeNull();
    // The charge really happened before cancellation could reach the writer, so
    // it is recorded independently of the owner-scoped write that unwound.
    await expect(
      readPlatformGenerationReceipts([row?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);

    // The slot keeps its original identity and lifetime: a later invocation
    // settles the ambiguity it was left in, and sends nothing.
    await expireMorningBriefGenerationReservation(f, new Date(now() - 1000));
    const settled = await accept(generate(f), [200]);
    if (settled.body.result !== "already-generated") {
      throw new Error(`Expected already-generated, got ${settled.body.result}`);
    }
    expect(settled.body.generation.attemptId).toBe(row?.attemptId);
    expect(settled.body.generation.state).toBe("invocation_outcome_unknown");
    expect(settled.body.generation.result).toBeNull();
    expect(traffic.bodies).toHaveLength(1);
  });

  it.each([
    [
      "the brief is disabled",
      async (f: Fixture) => {
        await pauseMorningBriefAutomation(f.automationId);
      },
      "owner_revoked",
    ],
    [
      "the installation Agent stops being reachable",
      async (f: Fixture) => {
        await restrictMorningBriefAgent(f.agentId);
      },
      "owner_revoked",
    ],
    [
      "the connected Slack account is rebound",
      async (f: Fixture) => {
        await rebindMorningBriefSlackAccount(
          f.userId,
          `U${randomUUID().slice(0, 8)}`,
        );
      },
      "binding_changed",
    ],
  ])(
    "refuses stale content when %s commits while persistence waits",
    async (_label, mutate, expectedReason) => {
      const f = await fixture();
      const other = await fixture();
      slackWithMessages();
      let lapsed: Promise<void> | undefined;
      const traffic = scriptProvider(async () => {
        if (lapsed !== undefined) {
          return completion({ cost: 0.001 });
        }
        // The authority was already proved for this response; the change lands
        // afterwards, while the owner-scoped write waits for its lock.
        const held = await holdMorningBriefOwnerRow(f, context.signal);
        lapsed = (async () => {
          await held.waitForArrival();
          await mutate(f);
          await held.release();
        })();
        return completion({ cost: 0.007 });
      });

      const response = await accept(generate(f), [200]);
      await lapsed;
      const body = expectGenerated(response.body);
      expect(body.generation.state).toBe("result_discarded");
      expect(body.generation.failureReason).toBe(expectedReason);
      expect(body.generation.result).toBeNull();
      expect(traffic.bodies).toHaveLength(1);
      // The incurred charge survives the refusal.
      await expect(
        readPlatformGenerationReceipts([body.generation.attemptId]),
      ).resolves.toHaveLength(1);

      const [row] = await readMorningBriefGenerations(f);
      expect(row?.state).toBe("result_discarded");
      expect(row?.resultMarkdown).toBeNull();

      // Another owner's brief is untouched by this owner's lapsed authority.
      const unrelated = await accept(generate(other), [200]);
      expect(expectGenerated(unrelated.body).generation.state).toBe(
        "succeeded",
      );
      const [unrelatedRow] = await readMorningBriefGenerations(other);
      expect(unrelatedRow?.resultMarkdown).toContain("# Release readiness");
      expect(traffic.bodies).toHaveLength(2);
    },
  );

  it("admits one provider request when a second attempt overlaps the reservation commit", async () => {
    const f = await fixture();
    slackWithMessages();
    const releaseProvider = createDeferredPromise<void>(context.signal);
    const traffic = scriptProvider(async () => {
      await releaseProvider.promise;
      return completion({ cost: 0.006 });
    });
    // The first attempt is suspended between its reservation INSERT and its
    // COMMIT, so the second really overlaps it rather than following it.
    const barrier = await holdMorningBriefGenerationReservation(
      f,
      context.signal,
    );

    const [firstResponse] = await Promise.all([
      accept(generate(f), [200]),
      (async () => {
        const firstTransaction = await barrier.waitForArrival();
        const [secondResponse] = await Promise.all([
          accept(generate(f), [409]),
          (async () => {
            // The second request must wait on the first transaction, not on
            // the barrier that is already blocking the first request.
            await waitForDeferredBlocker(firstTransaction);
            expect(traffic.bodies).toHaveLength(0);
            await barrier.release();
          })(),
        ]);
        expect(secondResponse.body.error.code).toBe(
          "MORNING_BRIEF_GENERATION_IN_PROGRESS",
        );
        // Keep the reservation open until the second request observes it;
        // a completed generation would legitimately return 200 instead.
        releaseProvider.resolve();
      })(),
    ]);
    expect(expectGenerated(firstResponse.body).generation.state).toBe(
      "succeeded",
    );
    expect(traffic.bodies).toHaveLength(1);

    const [row, ...extraRows] = await readMorningBriefGenerations(f);
    expect(extraRows).toStrictEqual([]);
    expect(row?.state).toBe("succeeded");
    await expect(
      readPlatformGenerationReceipts([row?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);
  });

  it("admits one provider request when a second attempt overlaps the open response", async () => {
    const f = await fixture();
    slackWithMessages();
    const arrived = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const traffic = scriptProvider(async () => {
      arrived.resolve();
      await release.promise;
      return completion({ cost: 0.005 });
    });

    const first = accept(generate(f), [200]);
    await arrived.promise;
    // The reservation is committed and the provider response is still open.
    const conflict = await accept(generate(f), [409]);
    expect(conflict.body.error.code).toBe(
      "MORNING_BRIEF_GENERATION_IN_PROGRESS",
    );
    expect(traffic.bodies).toHaveLength(1);
    release.resolve();

    const response = await first;
    expect(expectGenerated(response.body).generation.state).toBe("succeeded");
    expect(traffic.bodies).toHaveLength(1);
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
  });
});

/**
 * The joined reservation rolls back with the completion that carries it.
 *
 * Every case here suspends the real collection finalization — or the
 * reservation it performs inside that same transaction — and then changes the
 * world. Only external HTTP is doubled: the occurrence, the slot, the locks and
 * the rollback are the production ones against a real database.
 */
describe("Morning Brief collection handoff admission", () => {
  /**
   * Script the Slack reads with the first discovery call parked.
   *
   * The attempt commits its claim before that call, so the occurrence row
   * really exists and a test can hold it before finalization tries to take it.
   * The later discovery calls — the pre-read proofs and the final release proof
   * — answer immediately, and history carries one in-window message so the
   * bundle really reserves a generation.
   */
  function slackHeldAtDiscovery(): {
    readonly arrived: Promise<void>;
    readonly release: () => void;
  } {
    const arrived = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    let suspended = false;
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, async () => {
        if (!suspended) {
          suspended = true;
          arrived.resolve();
          await released.promise;
        }
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C100", name: "general", is_private: false }],
          response_metadata: { next_cursor: "" },
        });
      }),
      http.get(SLACK_HISTORY_URL, () => {
        return HttpResponse.json({
          ok: true,
          messages: [
            {
              type: "message",
              ts: messageTs(0),
              user: "U0",
              text: "ship the release",
            },
          ],
        });
      }),
      http.get("https://slack.com/api/conversations.replies", () => {
        return HttpResponse.json({ ok: true, messages: [] });
      }),
    );
    return {
      arrived: arrived.promise,
      release: () => {
        if (!released.settled()) {
          released.resolve();
        }
      },
    };
  }

  /** Suspend one attempt where its completion waits for the occurrence row. */
  async function heldCompletion(
    f: Fixture,
    controller?: AbortController,
  ): Promise<{
    readonly pending: ReturnType<typeof generate>;
    readonly release: () => Promise<void>;
  }> {
    const suspended = slackHeldAtDiscovery();
    const pending = controller
      ? cancellableGeneration(controller.signal).preview({
          headers: f.headers,
          body: { scheduledFor: ANCHOR },
        })
      : generate(f);
    await suspended.arrived;
    const held = await holdMorningBriefCollectionOccurrence(
      { orgId: f.orgId, userId: f.userId },
      context.signal,
    );
    suspended.release();
    await held.waitForArrival();
    return { pending, release: held.release };
  }

  it("commits neither completion nor reservation when the caller cancels while the completion waits", async () => {
    const f = await fixture();
    const traffic = scriptProvider(() => {
      throw new Error("a cancelled completion must not reach the provider");
    });
    const controller = new AbortController();
    const held = await heldCompletion(f, controller);

    controller.abort();
    await held.release();
    const outcome = await settleIncludingAbort(held.pending);

    expect(outcome.ok && outcome.value.status === 200).toBeFalsy();
    expect(traffic.bodies).toStrictEqual([]);
    // Neither write survived: the reservation joins the completion's
    // transaction, so unwinding one unwinds both.
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
    const [row, ...extra] = await readMorningBriefCollectionOccurrences(f);
    expect(extra).toStrictEqual([]);
    expect(row).toMatchObject({ status: "running", attempt: 1 });
    expect(row?.outcome).toBeNull();
    expect(row?.finishedAt).toBeNull();
  });

  it("commits neither completion nor reservation when the caller cancels while the reservation waits", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      throw new Error("a cancelled reservation must not reach the provider");
    });
    const controller = new AbortController();
    const barrier = await holdMorningBriefGenerationReservation(
      { orgId: f.orgId, userId: f.userId },
      context.signal,
    );

    const pending = cancellableGeneration(controller.signal).preview({
      headers: f.headers,
      body: { scheduledFor: ANCHOR },
    });
    // The reservation is written and blocked before COMMIT, which is an await
    // interval of its own inside the joined handoff.
    await barrier.waitForArrival();
    controller.abort();
    await barrier.release();
    const outcome = await settleIncludingAbort(pending);

    expect(outcome.ok && outcome.value.status === 200).toBeFalsy();
    expect(traffic.bodies).toStrictEqual([]);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
    const [row] = await readMorningBriefCollectionOccurrences(f);
    expect(row).toMatchObject({ status: "running", attempt: 1 });
    expect(row?.outcome).toBeNull();
  });

  it.each([
    [
      "the brief is disabled",
      async (f: Fixture) => {
        await pauseMorningBriefAutomation(f.automationId);
      },
      "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
    ],
    [
      "the connected Slack account is rebound",
      async (f: Fixture) => {
        await rebindMorningBriefSlackAccount(
          f.userId,
          `U${randomUUID().slice(0, 8)}`,
        );
      },
      "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
    ],
  ])(
    "reserves nothing when %s while the completion waits",
    async (_label, mutate, expectedCode) => {
      const f = await fixture();
      const traffic = scriptProvider(() => {
        throw new Error("a lapsed authority must not reach the provider");
      });
      const held = await heldCompletion(f);

      await mutate(f);
      await held.release();

      const refused = await accept(held.pending, [409]);
      expect(refused.body.error.code).toBe(expectedCode);
      expect(traffic.bodies).toStrictEqual([]);
      await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
      const [row] = await readMorningBriefCollectionOccurrences(f);
      expect(row).toMatchObject({ status: "running", attempt: 1 });
      expect(row?.outcome).toBeNull();
    },
  );

  it("generates once when nothing changes while the completion waits", async () => {
    const f = await fixture();
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.003 });
    });
    const held = await heldCompletion(f);

    // The positive control: the same suspended wait, with nothing changing
    // underneath it, commits the completion and its reservation together.
    await held.release();
    const response = await accept(held.pending, [200]);

    expect(expectGenerated(response.body).generation.state).toBe("succeeded");
    expect(traffic.bodies).toHaveLength(1);
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
    const [row] = await readMorningBriefCollectionOccurrences(f);
    expect(row).toMatchObject({ status: "completed", attempt: 1 });
  });
});

/**
 * Suspend one Clerk membership resolution, counted from the request's first.
 *
 * A read-back resolves the canonical authority twice: once to claim the
 * completed occurrence, and once to decide whether its stored result may be
 * released. Suspending the second is what lets a test take the owner row *after*
 * the claim released it, so the final release fence — and only it — is the
 * thing that actually waits. The count is asserted by the caller, so a path that
 * stops resolving twice fails loudly instead of silently holding elsewhere.
 */
function holdMembershipResolution(nth: number): {
  readonly arrived: Promise<void>;
  readonly release: () => void;
  readonly calls: () => number;
} {
  const arrived = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const memberships =
    context.mocks.clerk.organizations.getOrganizationMembershipList;
  const resolveMemberships = memberships.getMockImplementation();
  let seen = 0;
  memberships.mockImplementation(async (...callArgs: unknown[]) => {
    seen += 1;
    if (seen === nth) {
      arrived.resolve();
      await released.promise;
    }
    return await resolveMemberships?.(...callArgs);
  });
  return {
    arrived: arrived.promise,
    release: released.resolve,
    calls: () => {
      return seen;
    },
  };
}

describe("Morning Brief platform-funded generation release fence", () => {
  /**
   * Read a stored result back with the final release fence really blocked.
   *
   * The membership hold only provides a foothold *after* the claim; the wait the
   * mutation lands during is the release fence's own owner lock, observed with
   * `pg_blocking_pids` rather than a sleep. Everything the fence has to survive
   * — the authority resolution and the receipt read — has already happened by
   * then, so a fence that ran any earlier would serve the cached content.
   */
  function readBackWhileFenced(f: Fixture, mutate: () => Promise<void>) {
    const membership = holdMembershipResolution(2);
    const pending = generate(f);
    const fenced = (async () => {
      await membership.arrived;
      const held = await holdMorningBriefOwnerRow(f, context.signal);
      membership.release();
      await held.waitForArrival();
      await mutate();
      await held.release();
    })();
    return { pending, fenced, membership };
  }

  /** One accepted result, then a provider no read-back may ever contact. */
  async function storedResult(f: Fixture): Promise<string> {
    slackWithMessages();
    scriptProvider(() => {
      return completion({ cost: 0.002 });
    });
    const response = await accept(generate(f), [200]);
    const { generation } = expectGenerated(response.body);
    expect(generation.state).toBe("succeeded");
    scriptProvider(() => {
      throw new Error("a read-back must never reach the provider");
    });
    return generation.attemptId;
  }

  it("does not release content the maintenance purge removed during the final read", async () => {
    const f = await fixture();
    const attemptId = await storedResult(f);

    const { pending, fenced, membership } = readBackWhileFenced(f, async () => {
      mockNow(now() + 25 * 60 * 60 * 1000);
      await expect(runRetentionMaintenance()).resolves.toBeGreaterThan(0);
    });
    const response = await accept(pending, [200]);
    await fenced;

    expect(membership.calls()).toBe(2);
    expect(response.body.result).toBe(
      "collection-completed-without-generation",
    );
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
    // The anonymous receipt outlives the content it paid for.
    await expect(
      readPlatformGenerationReceipts([attemptId]),
    ).resolves.toHaveLength(1);
  });

  it("does not release content that reached its retention deadline exactly", async () => {
    const f = await fixture();
    await storedResult(f);

    const { pending, fenced } = readBackWhileFenced(f, async () => {
      // Equality with the deadline is already expired, and the content is
      // unreadable there whether or not maintenance has purged it yet.
      const deadline = new Date(now());
      mockNow(deadline);
      await expireMorningBriefGenerationRetention(f, deadline);
    });
    const response = await accept(pending, [200]);
    await fenced;

    expect(response.body.result).toBe(
      "collection-completed-without-generation",
    );
    // Still physically present: the deadline made it unreadable, not absent.
    const [row] = await readMorningBriefGenerations(f);
    expect(row?.state).toBe("succeeded");
  });

  it("does not release a stored result the owner disabled during the final read", async () => {
    const f = await fixture();
    await storedResult(f);

    const { pending, fenced } = readBackWhileFenced(f, async () => {
      await pauseMorningBriefAutomation(f.automationId);
    });
    const response = await accept(pending, [200]);
    await fenced;

    if (response.body.result !== "not-executed") {
      throw new Error(`Expected not-executed, got ${response.body.result}`);
    }
    expect(response.body.reason).toBe("brief-paused");
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
  });

  it("does not release a stored result rebound to another Slack identity", async () => {
    const f = await fixture();
    await storedResult(f);

    const { pending, fenced } = readBackWhileFenced(f, async () => {
      await rebindMorningBriefSlackAccount(
        f.userId,
        `U${randomUUID().slice(0, 8)}`,
      );
    });
    const conflict = await accept(pending, [409]);
    await fenced;

    expect(conflict.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
    );
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
  });

  it("releases an unchanged result with no recollection and no second request", async () => {
    const f = await fixture();
    const attemptId = await storedResult(f);
    const traffic = scriptProvider(() => {
      throw new Error("a healthy read-back must never reach the provider");
    });
    let slackCalls = 0;
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        slackCalls += 1;
        return HttpResponse.json({ ok: true, channels: [] });
      }),
    );

    const response = await accept(generate(f), [200]);
    if (response.body.result !== "already-generated") {
      throw new Error(
        `Expected already-generated, got ${response.body.result}`,
      );
    }
    expect(response.body.generation.attemptId).toBe(attemptId);
    expect(response.body.generation.state).toBe("succeeded");
    expect(
      response.body.generation.result?.decision === "deliver" &&
        response.body.generation.result.markdown,
    ).toContain("# Release readiness");
    expect(traffic.bodies).toStrictEqual([]);
    expect(slackCalls).toBe(0);
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
  });
});

describe("Morning Brief platform-funded generation retention", () => {
  it("purges an idle owner's expired content without that owner invoking again", async () => {
    const f = await fixture();
    const other = await fixture();
    slackWithMessages();
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.002 });
    });
    const expiring = expectGenerated(
      (await accept(generate(f), [200])).body,
    ).generation;
    const live = expectGenerated(
      (await accept(generate(other), [200])).body,
    ).generation;
    await expireMorningBriefGenerationRetention(f, new Date(now() - 1000));

    // The owner never comes back: the bounded maintenance consumer is what
    // removes the content, on an existing tick rather than a new scheduler.
    await expect(runRetentionMaintenance()).resolves.toBeGreaterThan(0);

    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
    const [survivor] = await readMorningBriefGenerations(other);
    expect(survivor?.state).toBe("succeeded");
    expect(survivor?.resultMarkdown).toContain("# Release readiness");
    // Incurred platform cost is never erased by content retention.
    await expect(
      readPlatformGenerationReceipts([expiring.attemptId, live.attemptId]),
    ).resolves.toHaveLength(2);

    // A purged slot is a completed collection that holds no generation, so the
    // occurrence still refuses a second invocation for the same anchor.
    const after = await accept(generate(f), [200]);
    expect(after.body.result).toBe("collection-completed-without-generation");
    expect(traffic.bodies).toHaveLength(2);
    await expect(readMorningBriefGenerations(f)).resolves.toStrictEqual([]);
  });
});

/**
 * The exact number the provider wrote, not the double it parses into.
 *
 * `HttpResponse.json` serializes a JavaScript number, so a fixture built from
 * one has already rewritten the digits this contract is about before the route
 * reads a byte: `0.10000000000000001` is `0.1` by the time it leaves the double
 * it was written as. These bodies are text, so what the route reads is exactly
 * what is written here, which is the only way a wire-level exactness claim can
 * be tested at all.
 */
function rawCompletionBody(
  usage: Readonly<Record<string, string>>,
  options: { readonly content?: string; readonly id?: string } = {},
): string {
  const fields = Object.entries(usage)
    .map(([field, token]) => {
      return `${JSON.stringify(field)}:${token}`;
    })
    .join(",");
  const content = JSON.stringify(options.content ?? deliverContent());
  return (
    `{"id":${JSON.stringify(options.id ?? "gen-01H0PLATFORM")},` +
    `"model":"google/gemini-3.8-flash",` +
    `"choices":[{"finish_reason":"stop","message":{"content":${content}}}],` +
    `"usage":{${fields}}}`
  );
}

/** Answer the single platform request with exactly these bytes. */
function scriptRawProvider(body: string): ProviderTraffic {
  return scriptProvider(() => {
    return new HttpResponse(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** The full usage payload, with one field replaced by a wire token. */
function rawUsage(
  field: string,
  token: string,
): Readonly<Record<string, string>> {
  return {
    prompt_tokens: "1200",
    completion_tokens: "240",
    total_tokens: "1440",
    [field]: token,
  };
}

/** Answer the read-only reconciliation with exactly these bytes. */
function scriptRawLookup(body: (id: string) => string): string[] {
  const lookups: string[] = [];
  server.use(
    http.get(OPENROUTER_GENERATION_URL, ({ request }) => {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      lookups.push(id);
      return new HttpResponse(body(id), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return lookups;
}

/** Read one stored generation back through the endpoint a caller has. */
async function rereadGeneration(
  f: Fixture,
): Promise<MorningBriefGenerationView> {
  const response = await accept(generate(f), [200]);
  if (response.body.result !== "already-generated") {
    throw new Error(`Expected already-generated, got ${response.body.result}`);
  }
  return response.body.generation;
}

/**
 * Exactness at the wire, not at the double.
 *
 * Every case below writes the provider's number as literal response bytes and
 * asserts what the route reports, what PostgreSQL stores and what a later
 * reread returns. An amount the receipt cannot hold exactly must stay
 * *unavailable*: a real charge that becomes a durable reported zero, or a
 * durable amount nobody reported, is worse than an honest unknown.
 */
describe("Morning Brief platform receipt wire amounts", () => {
  it.each([
    ["an ordinary amount", "0.012345678901", "0.012345678901"],
    ["a reported zero", "0", "0.000000000000"],
    ["a negative zero", "-0", "0.000000000000"],
    ["the smallest storable amount", "1e-12", "0.000000000001"],
    ["an exponent form", "1.25e-3", "0.001250000000"],
    ["an integral exponent form", "2.5E2", "250.000000000000"],
    [
      "the widest exactly storable amount",
      "999999999999.999999999999",
      "999999999999.999999999999",
    ],
    ["a seventeenth significant digit", "0.10000000000000001", null],
    ["digits past the stored scale", "0.123456789012000001", null],
    ["an amount finer than the stored scale", "1e-13", null],
    ["a subnormal amount", "1e-400", null],
    ["a negative subnormal amount", "-1e-400", null],
    ["a negative amount", "-0.001", null],
    ["an amount wider than the stored precision", "1e12", null],
    ["an exponent no allocation could hold", "1e999999999", null],
  ])(
    "reports %s from the completion exactly or not at all",
    async (_label, token, value) => {
      const f = await fixture();
      slackWithMessages();
      // An amount this receipt cannot hold is reconciled once, and the record
      // it reads is deliberately empty: nothing may invent a second amount.
      const lookups = scriptRawLookup(() => {
        return `{"data":{}}`;
      });
      const traffic = scriptRawProvider(
        rawCompletionBody(rawUsage("cost", token)),
      );

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.state).toBe("succeeded");
      expect(body.generation.receipt?.cost).toStrictEqual(
        value === null
          ? { state: "unavailable", value: null, unit: null, source: null }
          : {
              state: "reported",
              value,
              unit: "openrouter_credits",
              source: "chat_completion_usage_cost",
            },
      );
      // A refused amount never takes the counts, the content or the id with it.
      expect(body.generation.receipt?.tokens.prompt).toBe(1200);
      expect(body.generation.receipt?.providerGenerationId).toBe(
        "gen-01H0PLATFORM",
      );
      expect(body.generation.result?.decision).toBe("deliver");

      const [row, ...extraRows] = await readMorningBriefGenerations(f);
      expect(extraRows).toStrictEqual([]);
      const receipts = await readPlatformGenerationReceipts([
        row?.attemptId ?? "",
      ]);
      expect(receipts).toHaveLength(1);
      // What PostgreSQL holds, and what a later caller is told, are the same
      // value the first answer carried — or the same honest unknown.
      expect(receipts[0]?.costValue).toBe(value);
      const reread = await rereadGeneration(f);
      expect(reread.receipt?.cost.value).toBe(value);
      expect(reread.receipt?.recorded).toBe("durable");
      expect(lookups).toHaveLength(value === null ? 1 : 0);
      expect(traffic.bodies).toHaveLength(1);
    },
  );

  it.each([
    ["an ordinary amount", "0.0015", "0.001500000000"],
    ["a seventeenth significant digit", "0.10000000000000001", null],
    ["a subnormal amount", "1e-400", null],
    ["a negative subnormal amount", "-1e-400", null],
  ])(
    "reports %s from the delayed reconciliation exactly or not at all",
    async (_label, token, value) => {
      const f = await fixture();
      slackWithMessages();
      const lookups = scriptRawLookup((id) => {
        return `{"data":{"id":${JSON.stringify(id)},"is_byok":false,"total_cost":${token}}}`;
      });
      // No inline amount, so the one bounded read-only lookup is what answers.
      const traffic = scriptRawProvider(
        rawCompletionBody({ prompt_tokens: "1200" }),
      );

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.receipt?.cost).toStrictEqual(
        value === null
          ? { state: "unavailable", value: null, unit: null, source: null }
          : {
              state: "reported",
              value,
              unit: "openrouter_credits",
              source: "generation_total_cost",
            },
      );
      const [row] = await readMorningBriefGenerations(f);
      const receipts = await readPlatformGenerationReceipts([
        row?.attemptId ?? "",
      ]);
      expect(receipts[0]?.costValue).toBe(value);
      await expect(rereadGeneration(f)).resolves.toMatchObject({
        receipt: { cost: { value } },
      });
      // Reconciliation is read-only and happens once; it never re-sends.
      expect(lookups).toStrictEqual(["gen-01H0PLATFORM"]);
      expect(traffic.bodies).toHaveLength(1);
    },
  );

  it("refuses a numeric string the provider sent as text", async () => {
    const f = await fixture();
    slackWithMessages();
    const lookups = scriptRawLookup(() => {
      return `{"data":{}}`;
    });
    const traffic = scriptRawProvider(
      rawCompletionBody({
        prompt_tokens: `"1200"`,
        cost: `"0.5"`,
      }),
    );

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    // A quoted amount is a different value in the provider's own contract, and
    // reading the wire text is not permission to start accepting it.
    expect(body.generation.receipt?.cost.state).toBe("unavailable");
    expect(body.generation.receipt?.tokens.prompt).toBeNull();
    expect(lookups).toHaveLength(1);
    expect(traffic.bodies).toHaveLength(1);
  });

  it.each([
    ["a fractional count at the column ceiling", "2147483647.0000001", null],
    ["the column ceiling itself", "2147483647", 2_147_483_647],
    ["an integral exponent form", "2.147483647e9", 2_147_483_647],
    ["one above the column ceiling", "2147483648", null],
    ["a fractional count", "12.5", null],
    ["a negative count", "-3", null],
    ["a zero count", "0", 0],
  ])(
    "records %s as the count the receipt column holds",
    async (_label, token, stored) => {
      const f = await fixture();
      slackWithMessages();
      const traffic = scriptRawProvider(
        rawCompletionBody({
          ...rawUsage("prompt_tokens", token),
          cost: "0.000125",
        }),
      );

      const response = await accept(generate(f), [200]);
      const body = expectGenerated(response.body);
      expect(body.generation.receipt?.tokens.prompt).toBe(stored);
      // Every independently valid sibling and the amount survive a refused one.
      expect(body.generation.receipt?.tokens.completion).toBe(240);
      expect(body.generation.receipt?.tokens.total).toBe(1440);
      expect(body.generation.receipt?.cost.value).toBe("0.000125000000");
      expect(body.generation.state).toBe("succeeded");

      const [row] = await readMorningBriefGenerations(f);
      const receipts = await readPlatformGenerationReceipts([
        row?.attemptId ?? "",
      ]);
      expect(receipts[0]?.promptTokens).toBe(stored);
      expect(receipts[0]?.costValue).toBe("0.000125000000");
      const reread = await rereadGeneration(f);
      expect(reread.receipt?.tokens.prompt).toBe(stored);
      expect(traffic.bodies).toHaveLength(1);
    },
  );

  it("keeps a malformed body a bounded unreadable outcome", async () => {
    const f = await fixture();
    slackWithMessages();
    // Valid JSON up to the point it stops, which is exactly the shape a
    // truncated transfer produces.
    const traffic = scriptRawProvider(`{"usage":{"cost":0.5`);

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("provider_failed");
    expect(body.generation.failureReason).toBe("response_unreadable");
    expect(body.generation.receipt?.outcome).toBe("response_unreadable");
    // Nothing was read, so nothing is claimed about what was charged.
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "invocation_unknown",
      value: null,
      unit: null,
      source: null,
    });
    expect(traffic.bodies).toHaveLength(1);
  });

  it("keeps a body with an invalid number unreadable", async () => {
    const f = await fixture();
    slackWithMessages();
    // `01` is not a JSON number. Preserving reported digits must not make a
    // document readable that the parser would have refused.
    const traffic = scriptRawProvider(
      rawCompletionBody({ prompt_tokens: "01", cost: "0.5" }),
    );

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("provider_failed");
    expect(body.generation.failureReason).toBe("response_unreadable");
    expect(body.generation.receipt?.cost.state).toBe("invocation_unknown");
    expect(traffic.bodies).toHaveLength(1);
  });

  it("leaves number-shaped provider text inside the result alone", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptRawProvider(
      rawCompletionBody(rawUsage("cost", "0.012345678901"), {
        content: JSON.stringify({
          decision: "deliver",
          title: "Release readiness",
          sections: [
            {
              heading: "Decisions",
              items: [
                {
                  // Numbers and a quote inside provider text, which the number
                  // reading must never reach into or rewrite.
                  text: 'Ship 1.5 at 0.10000000000000001 cost, "confirmed"',
                  sourceIds: ["m1"],
                },
              ],
            },
          ],
        }),
      }),
    );

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    const markdown =
      body.generation.result?.decision === "deliver"
        ? body.generation.result.markdown
        : "";
    expect(markdown).toContain("0.10000000000000001");
    expect(markdown).toContain("Ship 1.5");
    // The field that is a number is read exactly; the text that contains
    // numbers is delivered unchanged.
    expect(body.generation.receipt?.cost.value).toBe("0.012345678901");
    expect(traffic.bodies).toHaveLength(1);
  });

  it("keeps a bare number body an unreadable outcome", async () => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptRawProvider("12.5");

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    // A number is not a completion document, and preserving its digits does not
    // make it one.
    expect(body.generation.state).toBe("provider_failed");
    expect(body.generation.failureReason).toBe("response_unreadable");
    expect(traffic.bodies).toHaveLength(1);
  });
});

/**
 * A provider request this test holds open, with the arrival it really observed.
 *
 * The completion is produced only after `release` settles, so everything a
 * second caller does happens while the first request is genuinely in flight —
 * an overlap, not two sequential calls with a suggestive name.
 */
function scriptSuspendedProvider(options: { readonly cost?: unknown } = {}): {
  readonly traffic: ProviderTraffic;
  readonly arrived: Promise<void>;
  readonly release: () => void;
} {
  const arrived = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  let held = false;
  const traffic = scriptProvider(async () => {
    if (!held) {
      held = true;
      arrived.resolve();
      await released.promise;
    }
    return completion({ cost: options.cost ?? 0.0031 });
  });
  return { traffic, arrived: arrived.promise, release: released.resolve };
}

/**
 * Overlapping callers, with the first one really suspended mid-flight.
 *
 * Each case suspends the invocation at a different real boundary — the provider
 * request itself, and the receipt INSERT inside PostgreSQL — and then runs
 * further complete requests for the same owner and anchor while it is held.
 */
describe("Morning Brief platform-funded generation overlap", () => {
  it("converges overlapping callers on one reserved attempt and one POST", async () => {
    const f = await fixture();
    slackWithMessages();
    const suspended = scriptSuspendedProvider({ cost: 0.0031 });

    const pending = accept(generate(f), [200]);
    await suspended.arrived;

    // Two further callers arrive and finish while the first request is still
    // open at the provider.
    for (const _attempt of [1, 2]) {
      const conflict = await accept(generate(f), [409]);
      expect(conflict.body.error.code).toBe(
        "MORNING_BRIEF_GENERATION_IN_PROGRESS",
      );
    }
    // One slot, held by the first attempt, with no second reservation beside it.
    const [held, ...extraHeld] = await readMorningBriefGenerations(f);
    expect(extraHeld).toStrictEqual([]);
    expect(held?.state).toBe("reserved");
    expect(suspended.traffic.bodies).toHaveLength(1);

    suspended.release();
    const response = await pending;
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    expect(body.generation.attemptId).toBe(held?.attemptId);
    expect(body.generation.receipt?.recorded).toBe("durable");
    // Still one POST, one slot and one immutable receipt for the whole overlap.
    expect(suspended.traffic.bodies).toHaveLength(1);
    await expect(readMorningBriefGenerations(f)).resolves.toHaveLength(1);
    const receipts = await readPlatformGenerationReceipts([
      body.generation.attemptId,
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.costValue).toBe("0.003100000000");
  });

  it("keeps one immutable receipt when callers overlap a blocked write", async () => {
    const f = await fixture();
    slackWithMessages();
    // The receipt INSERT itself waits, inside PostgreSQL, on a lock this
    // fixture holds — the recovery window a second caller can actually hit.
    const { barrier } = await interceptPlatformGenerationReceiptWrites(
      { generationId: "gen-01H0PLATFORM", suspend: true },
      context.signal,
    );
    if (!barrier) {
      throw new Error("Expected a suspended receipt write");
    }
    const traffic = scriptProvider(() => {
      return completion({ cost: 0.00047 });
    });

    const pending = accept(generate(f), [200]);
    await barrier.waitForArrival();
    expect(traffic.bodies).toHaveLength(1);

    const conflict = await accept(generate(f), [409]);
    expect(conflict.body.error.code).toBe(
      "MORNING_BRIEF_GENERATION_IN_PROGRESS",
    );
    // The overlapping caller neither sent a second request nor wrote a receipt
    // of its own while the first write was still waiting.
    expect(traffic.bodies).toHaveLength(1);
    await expect(readPlatformGenerationReceipts([])).resolves.toStrictEqual([]);

    await barrier.release();
    const response = await pending;
    const body = expectGenerated(response.body);
    expect(body.generation.state).toBe("succeeded");
    expect(body.generation.receipt?.recorded).toBe("durable");

    const receipts = await readPlatformGenerationReceipts([
      body.generation.attemptId,
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.costValue).toBe("0.000470000000");
    // A later reread reports that same stored observation rather than a new one.
    const reread = await rereadGeneration(f);
    expect(reread.receipt).toStrictEqual(body.generation.receipt);
    expect(traffic.bodies).toHaveLength(1);
  });
});

/**
 * Record what was sent, then lose the answer at a real transport boundary.
 *
 * This registers the reply directly rather than through `scriptProvider`, whose
 * convenience wrapper would turn a network error into an ordinary JSON body and
 * quietly test the opposite of what is intended here.
 */
function scriptProviderLoss(reply: () => Response): ProviderTraffic {
  const traffic: ProviderTraffic = { bodies: [] };
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      traffic.bodies.push(await request.text());
      return reply();
    }),
  );
  return traffic;
}

/**
 * The answer is lost, the charge may not be.
 *
 * A request the provider actually received and whose answer never arrived is
 * *unknown*, which is a different fact from a request that was never sent. The
 * cases below lose the response and the body at real HTTP boundaries and assert
 * that difference survives into storage and into the reread.
 */
describe("Morning Brief platform-funded generation transport loss", () => {
  it.each([
    [
      "the response never arrives",
      (): Response => {
        return HttpResponse.error();
      },
    ],
    [
      "the body is lost mid-read",
      (): Response => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `{"id":"gen-01H0PLATFORM","usage":{"cost":0.5`,
              ),
            );
            controller.error(new Error("connection reset"));
          },
        });
        return new HttpResponse(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ],
  ])("records an invoked request as unknown when %s", async (_label, reply) => {
    const f = await fixture();
    slackWithMessages();
    const traffic = scriptProviderLoss(reply);

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    // The request really left, so this is unknown rather than a proven
    // failure-before-contact, and it is never a skip.
    expect(traffic.bodies).toHaveLength(1);
    expect(body.generation.state).toBe("invocation_outcome_unknown");
    expect(body.generation.state).not.toBe("not_invoked");
    expect(body.generation.failureReason).toBe("transport_failed");
    expect(body.generation.result).toBeNull();
    // Nothing is fabricated about the amount: not zero, and not "unavailable",
    // which would claim a usage payload was read and carried no amount.
    expect(body.generation.receipt).toMatchObject({
      recorded: "durable",
      outcome: "invocation_unknown",
      cost: {
        state: "invocation_unknown",
        value: null,
        unit: null,
        source: null,
      },
      tokens: {
        prompt: null,
        completion: null,
        reasoning: null,
        cached: null,
        total: null,
      },
    });

    const [row, ...extraRows] = await readMorningBriefGenerations(f);
    expect(extraRows).toStrictEqual([]);
    expect(row?.state).toBe("invocation_outcome_unknown");
    expect(row?.resultMarkdown).toBeNull();
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.costState).toBe("invocation_unknown");
    expect(receipts[0]?.costValue).toBeNull();

    // The reread reports the same unknown and sends nothing again: a lost
    // answer is never a reason to repeat an invocation that may have happened.
    const reread = await rereadGeneration(f);
    expect(reread.state).toBe("invocation_outcome_unknown");
    expect(reread.receipt?.cost.state).toBe("invocation_unknown");
    expect(traffic.bodies).toHaveLength(1);
    await expect(
      readPlatformGenerationReceipts([row?.attemptId ?? ""]),
    ).resolves.toHaveLength(1);
  });

  it("leaves the cost unknown when the reconciliation transport fails", async () => {
    const f = await fixture();
    slackWithMessages();
    const lookups: string[] = [];
    server.use(
      http.get(OPENROUTER_GENERATION_URL, ({ request }) => {
        lookups.push(new URL(request.url).searchParams.get("id") ?? "");
        return HttpResponse.error();
      }),
    );
    const traffic = scriptProvider(() => {
      return completion({});
    });

    const response = await accept(generate(f), [200]);
    const body = expectGenerated(response.body);
    // The completion itself was read, so the invocation is known; only the
    // amount is not, and it stays that way rather than becoming zero.
    expect(body.generation.state).toBe("succeeded");
    expect(body.generation.receipt?.outcome).toBe("response_received");
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "unavailable",
      value: null,
      unit: null,
      source: null,
    });
    expect(body.generation.receipt?.providerGenerationId).toBe(
      "gen-01H0PLATFORM",
    );
    expect(lookups).toStrictEqual(["gen-01H0PLATFORM"]);
    expect(traffic.bodies).toHaveLength(1);
    const [row] = await readMorningBriefGenerations(f);
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts[0]?.costState).toBe("unavailable");
    expect(receipts[0]?.costValue).toBeNull();
  });

  it("leaves the cost unknown when the reconciliation never answers", async () => {
    const f = await fixture();
    slackWithMessages();
    // The lookup is held past its own five-second deadline, which is the
    // production wait this asserts: shortening it would test a different
    // number, and observing the abort is what makes the outcome real.
    const released = createDeferredPromise<void>(context.signal);
    const lookups: string[] = [];
    server.use(
      http.get(OPENROUTER_GENERATION_URL, async ({ request }) => {
        lookups.push(new URL(request.url).searchParams.get("id") ?? "");
        await released.promise;
        return HttpResponse.json({
          data: { id: "gen-01H0PLATFORM", is_byok: false, total_cost: 0.5 },
        });
      }),
    );
    const traffic = scriptProvider(() => {
      return completion({});
    });

    const response = await accept(generate(f), [200]);
    released.resolve();
    const body = expectGenerated(response.body);
    expect(lookups).toStrictEqual(["gen-01H0PLATFORM"]);
    // An answer that arrives after the deadline is not this invocation's
    // amount, and the completion is never sent again to obtain one.
    expect(body.generation.state).toBe("succeeded");
    expect(body.generation.receipt?.cost).toStrictEqual({
      state: "unavailable",
      value: null,
      unit: null,
      source: null,
    });
    expect(traffic.bodies).toHaveLength(1);
    const [row] = await readMorningBriefGenerations(f);
    const receipts = await readPlatformGenerationReceipts([
      row?.attemptId ?? "",
    ]);
    expect(receipts[0]?.costState).toBe("unavailable");
    const reread = await rereadGeneration(f);
    expect(reread.receipt?.cost.state).toBe("unavailable");
    expect(traffic.bodies).toHaveLength(1);
  }, 15_000);
});
