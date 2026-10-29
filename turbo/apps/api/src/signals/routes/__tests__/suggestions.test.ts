import { randomUUID, createHash } from "node:crypto";
import { suggestionContextPart } from "@okouai/api-contracts/contracts/suggestion-context";
import { chatEventsRoutes } from "../chat-events";
import { describe, expect, it } from "vitest";
import {
  suggestionsContract,
  SUGGESTION_RETENTION_MS,
  type SuggestionCreate,
  type SuggestionOption,
} from "@okouai/api-contracts/contracts/suggestions";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { suggestionsRoutes } from "../suggestions";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadDeleteRoutes } from "../chat-threads-delete";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { cronCleanupSuggestionsContract } from "@okouai/api-contracts/contracts/cron";
import { cronCleanupSuggestionsRoutes } from "../cron-cleanup-suggestions";
import { mockNow } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";

const context = testContext();
const humanHeaders = { authorization: "Bearer clerk-session" } as const;
function client() {
  return setupApp({ context, routes: suggestionsRoutes })(suggestionsContract);
}
function cleanupClient() {
  return setupApp({ context, routes: cronCleanupSuggestionsRoutes })(
    cronCleanupSuggestionsContract,
  );
}
const cronSecret = "suggestion-retention-test-secret";
const cronHeaders = { authorization: `Bearer ${cronSecret}` } as const;
function input(priority = 0): SuggestionCreate {
  return {
    id: randomUUID(),
    title: "Review the project update",
    rationale: "A decision needs your input",
    priority,
    customOption: {
      id: "custom",
      threadId: null,
      draft: {
        draftUserMessage: {
          version: 1,
          parts: [
            {
              type: "feedback",
              quote:
                "Launch background: source launch-plan-v2. Budget and owner are not confirmed.",
              note: [],
            },
          ],
        },
        draftAttachments: null,
      },
    },
    options: [makeOption()],
  };
}
function makeOption(
  overrides: Partial<SuggestionOption> = {},
): SuggestionOption {
  return {
    id: "review",
    label: "Review update",
    description: "Review the project and prepare the next step",
    threadId: null,
    draft: {
      draftUserMessage: {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Review the project update and prepare the next steps.",
          },
        ],
      },
      draftAttachments: null,
    },
    ...overrides,
  };
}
async function primaryRun(enabled = true, secondary = false) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  const { defaultAgentId } = await bdd.readOnboardingStatus(actor);
  if (!actor.orgId || !defaultAgentId) {
    throw new Error("Expected a default Agent");
  }
  await bdd.completeOnboarding(actor);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.AgentSuggestion]: enabled,
      [FeatureSwitchKey.ProactiveAgent]: false,
    },
  );
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agentId = secondary
    ? (
        await bdd.createAgent(actor, {
          displayName: "Secondary",
          visibility: "private",
        })
      ).agentId
    : defaultAgentId;
  await runs.heartbeatRunner(runnerGroup);
  const run = await runs.createThreadRun(actor, {
    agentId,
    model: "claude-fable-5-1",
    prompt: "Curate useful suggestions",
  });
  const claim = await runs.claimRunnerJob(run.runId);
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId,
    headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
  };
}

describe("Agent suggestions", () => {
  it("renews a card for 24 hours after an update", async () => {
    const start = Date.parse("2026-10-27T00:00:00.000Z");
    mockNow(start);
    const fixture = await primaryRun();
    const suggestion = input();
    const created = await accept(
      client().create({ headers: fixture.headers, body: suggestion }),
      [200],
    );
    expect(created.body.expiresAt).toBe("2026-10-28T00:00:00.000Z");

    mockNow(start + 60_000);
    const updated = await accept(
      client().update({
        headers: fixture.headers,
        params: { id: suggestion.id },
        body: { title: "Review the latest project update", priority: 50 },
      }),
      [200],
    );
    expect(updated.body.expiresAt).toBe("2026-10-28T00:01:00.000Z");
    expect(updated.body.createdAt).toBe(created.body.createdAt);
    mockNow(start + SUGGESTION_RETENTION_MS);
    const current = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(current.body.suggestions).toHaveLength(1);

    mockNow(start + SUGGESTION_RETENTION_MS + 60_000);
    const expired = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(expired.body.suggestions).toStrictEqual([]);
  });

  it("honors an earlier deadline and caps a later deadline at 24 hours", async () => {
    const start = Date.parse("2026-10-27T00:00:00.000Z");
    mockNow(start);
    const fixture = await primaryRun();
    const early = { ...input(), expiresAt: "2026-10-27T00:01:00.000Z" };
    await accept(
      client().create({ headers: fixture.headers, body: early }),
      [200],
    );
    const capped = await accept(
      client().create({
        headers: fixture.headers,
        body: { ...input(), expiresAt: "2026-10-29T00:00:00.000Z" },
      }),
      [200],
    );
    expect(capped.body.expiresAt).toBe("2026-10-28T00:00:00.000Z");
    await accept(
      client().update({
        headers: fixture.headers,
        params: { id: capped.body.id },
        body: { expiresAt: "2026-10-27T00:02:00.000Z" },
      }),
      [200],
    );
    await accept(
      client().create({
        headers: fixture.headers,
        body: { ...input(), expiresAt: "2026-10-26T23:59:59.000Z" },
      }),
      [400],
    );

    mockNow(start + 60_000);
    const listed = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(
      listed.body.suggestions.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([capped.body.id]);
    await accept(
      client().update({
        headers: fixture.headers,
        params: { id: early.id },
        body: { priority: 100 },
      }),
      [409],
    );
    const consumed = await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: early.id },
        body: { optionId: "review" },
      }),
      [200],
    );
    expect(consumed.body).toMatchObject({
      id: early.id,
      status: "consumed",
      selectedOptionId: "review",
      options: early.options,
    });
    mockNow(start + 120_000);
    const expired = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(expired.body.suggestions).toStrictEqual([]);
  });

  it.each(["review", null])(
    "records a cached choice once after physical cleanup (option %s)",
    async (optionId) => {
      await setupApp({
        context,
        routes: cronCleanupSuggestionsRoutes,
        isolatePg: true,
      });
      const start = Date.parse("2026-10-27T00:00:00.000Z");
      mockNow(start);
      mockEnv("CRON_SECRET", cronSecret);
      const fixture = await primaryRun();
      const cached = await accept(
        client().create({ headers: fixture.headers, body: input() }),
        [200],
      );
      mockNow(start + SUGGESTION_RETENTION_MS);
      const cleaned = await accept(
        cleanupClient().cleanup({ headers: cronHeaders }),
        [200],
      );
      expect(cleaned.body.deleted).toBe(1);
      const choices = await Promise.all(
        [0, 1].map(() => {
          return accept(
            client().consume({
              headers: humanHeaders,
              params: { id: cached.body.id },
              body: { optionId, snapshot: cached.body },
            }),
            [200, 409],
          );
        }),
      );
      expect(
        choices
          .map((choice) => {
            return choice.status;
          })
          .sort(),
      ).toStrictEqual([200, 409]);
      const accepted = choices.find((choice) => {
        return choice.status === 200;
      });
      expect(accepted?.body).toMatchObject({
        id: cached.body.id,
        status: "consumed",
        selectedOptionId: optionId,
        options: cached.body.options,
      });
      const listed = await accept(
        client().list({ headers: humanHeaders }),
        [200],
      );
      expect(listed.body.receipts).toContainEqual(
        expect.objectContaining({
          id: cached.body.id,
          status: "consumed",
          selectedOptionId: optionId,
        }),
      );
    },
  );

  it("preserves a cached choice when the same action is concurrently republished", async () => {
    const start = Date.parse("2026-10-27T00:00:00.000Z");
    mockNow(start);
    const fixture = await primaryRun();
    const suggestion = input();
    const cached = await accept(
      client().create({
        headers: fixture.headers,
        body: { ...suggestion, expiresAt: "2026-10-27T00:01:00.000Z" },
      }),
      [200],
    );
    mockNow(start + 60_000);
    const fresh = input();
    await accept(
      client().create({ headers: fixture.headers, body: fresh }),
      [200],
    );
    const [chosen] = await Promise.all([
      accept(
        client().consume({
          headers: humanHeaders,
          params: { id: suggestion.id },
          body: { optionId: "review", snapshot: cached.body },
        }),
        [200],
      ),
      accept(
        client().create({ headers: fixture.headers, body: suggestion }),
        [200, 409],
      ),
    ]);
    expect(chosen.body).toMatchObject({
      id: suggestion.id,
      status: "consumed",
      selectedOptionId: "review",
    });
    const listed = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(
      listed.body.suggestions.map((suggestion) => {
        return suggestion.id;
      }),
    ).toStrictEqual([fresh.id]);
    expect(listed.body.receipts).toContainEqual(
      expect.objectContaining({
        id: suggestion.id,
        status: "consumed",
        selectedOptionId: "review",
      }),
    );
  });

  it("requires the original owner's unmodified snapshot after publication prunes the expired card", async () => {
    const start = Date.parse("2026-10-27T00:00:00.000Z");
    mockNow(start);
    const fixture = await primaryRun();
    const cached = await accept(
      client().create({ headers: fixture.headers, body: input() }),
      [200],
    );
    mockNow(start + SUGGESTION_RETENTION_MS);
    await accept(
      client().create({ headers: fixture.headers, body: input() }),
      [200],
    );
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: cached.body.id },
        body: {
          optionId: "review",
          snapshot: { ...cached.body, rationale: "Changed after publication" },
        },
      }),
      [409],
    );
    await primaryRun();
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: cached.body.id },
        body: { optionId: "review", snapshot: cached.body },
      }),
      [409],
    );
    const listed = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(listed.body.receipts).toStrictEqual([]);
  });

  it("reclaims expired capacity when publication overlaps scheduled cleanup", async () => {
    await setupApp({
      context,
      routes: cronCleanupSuggestionsRoutes,
      isolatePg: true,
    });
    const start = Date.parse("2026-10-27T00:00:00.000Z");
    mockNow(start);
    mockEnv("CRON_SECRET", cronSecret);
    const fixture = await primaryRun();
    for (let index = 0; index < 10; index += 1) {
      await accept(
        client().create({
          headers: fixture.headers,
          body: { ...input(index), expiresAt: "2026-10-27T00:01:00.000Z" },
        }),
        [200],
      );
    }
    mockNow(start + 60_000);
    const fresh = input();
    await Promise.all([
      accept(client().create({ headers: fixture.headers, body: fresh }), [200]),
      accept(cleanupClient().cleanup({ headers: cronHeaders }), [200]),
    ]);
    const listed = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(
      listed.body.suggestions.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([fresh.id]);
  });

  it("retains selected, dismissed and withdrawn feedback for 24 hours after processing", async () => {
    await setupApp({
      context,
      routes: cronCleanupSuggestionsRoutes,
      isolatePg: true,
    });
    const start = Date.parse("2026-10-27T00:00:00.000Z");
    mockNow(start);
    mockEnv("CRON_SECRET", cronSecret);
    const fixture = await primaryRun();
    const selected = input();
    const dismissed = input();
    const withdrawn = input();
    for (const suggestion of [selected, dismissed, withdrawn]) {
      await accept(
        client().create({ headers: fixture.headers, body: suggestion }),
        [200],
      );
    }
    const processedAt = start + 60_000;
    mockNow(processedAt);
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: selected.id },
        body: { optionId: "review" },
      }),
      [200],
    );
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: dismissed.id },
        body: { optionId: null },
      }),
      [200],
    );
    await accept(
      client().remove({
        headers: fixture.headers,
        params: { id: withdrawn.id },
      }),
      [204],
    );
    await accept(
      client().create({ headers: fixture.headers, body: selected }),
      [409],
    );

    mockNow(processedAt + SUGGESTION_RETENTION_MS - 1);
    await accept(cleanupClient().cleanup({ headers: cronHeaders }), [200]);
    const retained = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(retained.body.receipts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: selected.id,
          status: "consumed",
          selectedOptionId: "review",
        }),
        expect.objectContaining({
          id: dismissed.id,
          status: "consumed",
          selectedOptionId: null,
        }),
        expect.objectContaining({ id: withdrawn.id, status: "removed" }),
      ]),
    );
    mockNow(processedAt + SUGGESTION_RETENTION_MS);
    const pruned = await accept(
      cleanupClient().cleanup({ headers: cronHeaders }),
      [200],
    );
    expect(pruned.body).toStrictEqual({ cleaned: 1, deleted: 1 });
    const listed = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(listed.body.receipts).toStrictEqual([]);
    const repeated = await accept(
      cleanupClient().cleanup({ headers: cronHeaders }),
      [200],
    );
    expect(repeated.body).toStrictEqual({ cleaned: 0, deleted: 0 });
  });

  it("preserves a newly consumed receipt while cleaning an expired card", async () => {
    await setupApp({
      context,
      routes: cronCleanupSuggestionsRoutes,
      isolatePg: true,
    });
    const start = Date.parse("2026-10-27T00:00:00.000Z");
    mockNow(start);
    mockEnv("CRON_SECRET", cronSecret);
    const fixture = await primaryRun();
    await accept(
      client().create({
        headers: fixture.headers,
        body: { ...input(), expiresAt: "2026-10-27T00:01:00.000Z" },
      }),
      [200],
    );
    mockNow(start + 30_000);
    const current = input();
    await accept(
      client().create({ headers: fixture.headers, body: current }),
      [200],
    );
    mockNow(start + 60_000);
    await Promise.all([
      accept(cleanupClient().cleanup({ headers: cronHeaders }), [200]),
      accept(
        client().consume({
          headers: humanHeaders,
          params: { id: current.id },
          body: { optionId: null },
        }),
        [200],
      ),
    ]);
    const listed = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(listed.body.receipts).toContainEqual(
      expect.objectContaining({
        id: current.id,
        status: "consumed",
        selectedOptionId: null,
      }),
    );
  });

  it("requires operator authentication for scheduled cleanup", async () => {
    mockEnv("CRON_SECRET", cronSecret);
    const response = await accept(
      cleanupClient().cleanup({ headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("treats uppercase UUID aliases as the same one-time suggestion identity", async () => {
    const fixture = await primaryRun();
    const suggestion = input();
    const created = await accept(
      client().create({ headers: fixture.headers, body: suggestion }),
      [200],
    );
    const consumed = await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: suggestion.id },
        body: { optionId: "review" },
      }),
      [200],
    );
    expect(consumed.body.id).toBe(created.body.id);
    await accept(
      client().create({
        headers: fixture.headers,
        body: { ...suggestion, id: suggestion.id.toUpperCase() },
      }),
      [409],
    );
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
  });
  it("consumes a canonical suggestion through an uppercase UUID path", async () => {
    const fixture = await primaryRun();
    const suggestion = input();
    await accept(
      client().create({ headers: fixture.headers, body: suggestion }),
      [200],
    );
    const consumed = await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: suggestion.id.toUpperCase() },
        body: { optionId: "review" },
      }),
      [200],
    );
    expect(consumed.body.id).toBe(suggestion.id);
  });
  it("rejects empty or whitespace-only suggestion drafts", async () => {
    const fixture = await primaryRun();
    const empty = input();
    await accept(
      client().create({
        headers: fixture.headers,
        body: {
          ...empty,
          options: [
            makeOption({
              draft: {
                draftUserMessage: {
                  version: 1,
                  parts: [{ type: "text", text: "  " }],
                },
                draftAttachments: null,
              },
            }),
          ],
        },
      }),
      [400],
    );
    await accept(
      client().create({
        headers: fixture.headers,
        body: {
          ...empty,
          options: [
            makeOption({
              draft: { draftUserMessage: null, draftAttachments: null },
            }),
          ],
        },
      }),
      [400],
    );
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
  });
  it("requires an enabled primary Agent capability and denies human publication", async () => {
    const fixture = await primaryRun(false);
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.ProactiveAgent]: true,
    });
    await accept(
      client().create({ headers: fixture.headers, body: input() }),
      [403],
    );
    await accept(
      client().create({ headers: humanHeaders, body: input() }),
      [403],
    );
    const result = await accept(
      client().list({ headers: humanHeaders }),
      [403],
    );
    expect(result.body.error.code).toBe("FORBIDDEN");
  });
  it("does not grant suggestion publication to a secondary Agent", async () => {
    const fixture = await primaryRun(true, true);
    await accept(
      client().create({ headers: fixture.headers, body: input() }),
      [403],
    );
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
  });
  it("enforces capacity under concurrent creation and consumes once without replay resurrection", async () => {
    const fixture = await primaryRun();
    const inputs = Array.from({ length: 16 }, (_, priority) => {
      return input(priority);
    });
    const created = await Promise.all(
      inputs.map((body) => {
        return accept(
          client().create({ headers: fixture.headers, body }),
          [200, 409],
        );
      }),
    );
    expect(
      created.filter((response) => {
        return response.status === 200;
      }),
    ).toHaveLength(10);
    expect(
      created.filter((response) => {
        return response.status === 409;
      }),
    ).toHaveLength(6);
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toHaveLength(10);
    expect(
      pool.body.suggestions.map((item) => {
        return item.priority;
      }),
    ).toStrictEqual(
      pool.body.suggestions
        .map((item) => {
          return item.priority;
        })
        .sort((a, b) => {
          return b - a;
        }),
    );
    const selected = pool.body.suggestions[0];
    if (!selected) {
      throw new Error("Expected a suggestion");
    }
    const retry = inputs.find((item) => {
      return item.id === selected.id;
    });
    if (!retry) {
      throw new Error("Expected the creation identity");
    }
    await accept(
      client().create({ headers: fixture.headers, body: retry }),
      [200],
    );
    const clicks = await Promise.all(
      [1, 2].map(() => {
        return accept(
          client().consume({
            headers: humanHeaders,
            params: { id: selected.id },
            body: { optionId: "review" },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      clicks
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const consumed = clicks.find((result) => {
      return result.status === 200;
    });
    expect(consumed?.body).toMatchObject({
      status: "consumed",
      selectedOptionId: "review",
      options: selected.options,
    });
    await accept(
      client().create({ headers: fixture.headers, body: retry }),
      [409],
    );
    await accept(
      client().update({
        headers: fixture.headers,
        params: { id: selected.id },
        body: { priority: 99 },
      }),
      [409],
    );
    await accept(
      client().create({ headers: fixture.headers, body: input(100) }),
      [200],
    );
    const after = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(after.body.suggestions).toHaveLength(10);
    expect(
      after.body.suggestions.some((item) => {
        return item.id === selected.id;
      }),
    ).toBeFalsy();
    expect(after.body.receipts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: selected.id, status: "consumed" }),
      ]),
    );
  });
  it("updates one priority and revalidates feature disablement for an existing token", async () => {
    const fixture = await primaryRun();
    const first = input(0);
    const second = input(20);
    await accept(
      client().create({ headers: fixture.headers, body: first }),
      [200],
    );
    await accept(
      client().create({ headers: fixture.headers, body: second }),
      [200],
    );
    await accept(
      client().update({
        headers: fixture.headers,
        params: { id: first.id },
        body: { priority: 30 },
      }),
      [200],
    );
    const ordered = await accept(
      client().list({ headers: fixture.headers }),
      [200],
    );
    expect(
      ordered.body.suggestions.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([first.id, second.id]);
    await accept(
      client().remove({ headers: fixture.headers, params: { id: first.id } }),
      [204],
    );
    await accept(
      client().create({ headers: fixture.headers, body: first }),
      [409],
    );
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.AgentSuggestion]: false,
      [FeatureSwitchKey.ProactiveAgent]: true,
    });
    await accept(
      client().update({
        headers: fixture.headers,
        params: { id: second.id },
        body: { priority: 99 },
      }),
      [403],
    );
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: second.id },
        body: { optionId: "review" },
      }),
      [403],
    );
  });
  it("selects one of several options once and retains the choice in compacted receipts", async () => {
    const fixture = await primaryRun();
    const suggestion = {
      ...input(),
      options: [
        makeOption(),
        makeOption({ id: "prepare", label: "Prepare a draft" }),
      ],
    };
    await accept(
      client().create({ headers: fixture.headers, body: suggestion }),
      [200],
    );
    const clicks = await Promise.all(
      suggestion.options.map((option) => {
        return accept(
          client().consume({
            headers: humanHeaders,
            params: { id: suggestion.id },
            body: { optionId: option.id },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      clicks
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const chosen =
      suggestion.options[
        clicks.findIndex((result) => {
          return result.status === 200;
        })
      ];
    if (!chosen) {
      throw new Error("Expected exactly one selected option");
    }
    const accepted = clicks.find((result) => {
      return result.status === 200;
    });
    expect(accepted?.body).toMatchObject({
      status: "consumed",
      selectedOptionId: chosen.id,
      options: suggestion.options,
    });
    await accept(
      client().create({ headers: fixture.headers, body: input() }),
      [200],
    );
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.receipts).toContainEqual({
      id: suggestion.id,
      status: "consumed",
      selectedOptionId: chosen.id,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
  it("rejects a removed option without consuming the card, then accepts dismissal with no selected option", async () => {
    const fixture = await primaryRun();
    const suggestion = input();
    await accept(
      client().create({ headers: fixture.headers, body: suggestion }),
      [200],
    );
    await accept(
      client().update({
        headers: fixture.headers,
        params: { id: suggestion.id },
        body: {
          options: [makeOption({ id: "prepare", label: "Prepare a draft" })],
        },
      }),
      [200],
    );
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: suggestion.id },
        body: { optionId: "review" },
      }),
      [409],
    );
    const active = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(active.body.suggestions).toHaveLength(1);
    expect(active.body.suggestions[0]?.selectedOptionId).toBeNull();
    const dismissed = await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: suggestion.id },
        body: { optionId: null },
      }),
      [200],
    );
    expect(dismissed.body).toMatchObject({
      status: "consumed",
      selectedOptionId: null,
    });
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
    expect(pool.body.receipts).toContainEqual({
      id: suggestion.id,
      status: "consumed",
      selectedOptionId: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
  it("returns the current draft for the chosen second option after a refresh", async () => {
    const fixture = await primaryRun();
    const suggestion = {
      ...input(),
      options: [
        makeOption(),
        makeOption({ id: "prepare", label: "Prepare a draft" }),
      ],
    };
    await accept(
      client().create({ headers: fixture.headers, body: suggestion }),
      [200],
    );
    const options = [
      makeOption(),
      makeOption({
        id: "prepare",
        label: "Prepare the updated draft",
        draft: {
          draftUserMessage: {
            version: 1 as const,
            parts: [
              {
                type: "text" as const,
                text: "Prepare a draft using the updated context.",
              },
            ],
          },
          draftAttachments: null,
        },
      }),
    ];
    await accept(
      client().update({
        headers: fixture.headers,
        params: { id: suggestion.id },
        body: { options },
      }),
      [200],
    );
    const consumed = await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: suggestion.id },
        body: { optionId: "prepare" },
      }),
      [200],
    );
    expect(consumed.body).toMatchObject({
      status: "consumed",
      selectedOptionId: "prepare",
      options,
    });
  });
  it("requires one to three options with unique identities and a bounded payload", async () => {
    const fixture = await primaryRun();
    for (const options of [
      [],
      [makeOption(), makeOption()],
      Array.from({ length: 4 }, (_, index) => {
        return makeOption({ id: `option-${index}` });
      }),
      [
        makeOption({
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [{ type: "text", text: "x".repeat(65_536) }],
            },
            draftAttachments: null,
          },
        }),
      ],
    ]) {
      await accept(
        client().create({
          headers: fixture.headers,
          body: { ...input(), options },
        }),
        [400],
      );
    }
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
  });
  it("isolates owners and refuses a suggestion targeting another user's thread", async () => {
    const owner = await primaryRun();
    const threads = setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    );
    const thread = await accept(
      threads.create({
        headers: humanHeaders,
        body: { agentId: owner.agentId },
      }),
      [201],
    );
    const suggestion = input();
    await accept(
      client().create({
        headers: owner.headers,
        body: {
          ...suggestion,
          options: [
            makeOption({
              threadId: thread.body.id,
            }),
          ],
        },
      }),
      [200],
    );
    const other = await primaryRun();
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: suggestion.id },
        body: { optionId: "review" },
      }),
      [409],
    );
    await accept(
      client().update({
        headers: other.headers,
        params: { id: suggestion.id },
        body: { priority: 99 },
      }),
      [409],
    );
    await accept(
      client().create({
        headers: other.headers,
        body: {
          ...input(),
          options: [
            makeOption(),
            makeOption({
              id: "continue",
              threadId: thread.body.id,
            }),
          ],
        },
      }),
      [404],
    );
    const own = input();
    await accept(client().create({ headers: other.headers, body: own }), [200]);
    await accept(
      client().update({
        headers: other.headers,
        params: { id: own.id },
        body: {
          options: [
            makeOption(),
            makeOption({ id: "continue", threadId: thread.body.id }),
          ],
        },
      }),
      [404],
    );
    const unchanged = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(unchanged.body.suggestions[0]?.options).toStrictEqual(own.options);
    await createBddApi(context).readMe(owner.actor);
    const retained = await accept(
      client().list({ headers: humanHeaders }),
      [200],
    );
    expect(retained.body.suggestions).toHaveLength(1);
    expect(retained.body.suggestions[0]?.id).toBe(suggestion.id);
  });
  it("returns the original target and canonical draft when its thread was deleted after publication", async () => {
    const fixture = await primaryRun();
    const secondary = await createBddApi(context).createAgent(fixture.actor, {
      displayName: "Target Agent",
      visibility: "private",
    });
    const threads = setupApp({
      context,
      routes: [...chatThreadCreateRoutes, ...chatThreadDeleteRoutes],
    })(chatThreadsContract);
    const thread = await accept(
      threads.create({
        headers: humanHeaders,
        body: { agentId: secondary.agentId },
      }),
      [201],
    );
    const suggestion = {
      ...input(),
      options: [
        makeOption({
          threadId: thread.body.id,
        }),
      ],
    };
    await accept(
      client().create({ headers: fixture.headers, body: suggestion }),
      [200],
    );
    const deletions = setupApp({ context, routes: chatThreadDeleteRoutes })(
      chatThreadByIdContract,
    );
    await accept(
      deletions.delete({
        headers: humanHeaders,
        params: { id: thread.body.id },
      }),
      [204],
    );
    const consumed = await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: suggestion.id },
        body: { optionId: "review" },
      }),
      [200],
    );
    expect(consumed.body).toMatchObject({
      status: "consumed",
      selectedOptionId: "review",
      options: suggestion.options,
    });
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
  });
});

describe("Suggestion custom follow-ups", () => {
  it("rejects executable custom drafts and reserves the custom option identity", async () => {
    const fixture = await primaryRun();
    const value = input();
    for (const draft of [
      makeOption().draft,
      {
        draftUserMessage: {
          version: 1 as const,
          parts: [
            {
              type: "feedback" as const,
              quote: "Complete facts",
              note: [
                { type: "text" as const, text: "Execute the preset action" },
              ],
            },
          ],
        },
        draftAttachments: null,
      },
    ]) {
      await accept(
        client().create({
          headers: fixture.headers,
          body: { ...value, customOption: { ...value.customOption, draft } },
        }),
        [400],
      );
    }
    await accept(
      client().create({
        headers: fixture.headers,
        body: { ...value, options: [makeOption({ id: "custom" })] },
      }),
      [400],
    );
    expect(
      (await accept(client().list({ headers: humanHeaders }), [200])).body
        .suggestions,
    ).toStrictEqual([]);
  });

  it("keeps the card until a complete follow-up is accepted and repairs the receipt on replay", async () => {
    const fixture = await primaryRun();
    const value = input();
    await accept(
      client().create({ headers: fixture.headers, body: value }),
      [200],
    );
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: value.id },
        body: { optionId: "custom" },
      }),
      [409],
    );
    const threads = setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    );
    const thread = await accept(
      threads.create({
        headers: humanHeaders,
        body: { agentId: fixture.agentId },
      }),
      [201],
    );
    const events = setupApp({ context, routes: chatEventsRoutes })(
      chatEventsContract,
    );
    const contextPart = suggestionContextPart({
      suggestionId: value.id,
      draftId: randomUUID(),
      optionId: "custom",
      titleSnapshot: value.title,
      rationaleSnapshot: value.rationale,
      contextVersion: createHash("sha256")
        .update(JSON.stringify(value.customOption.draft))
        .digest("hex"),
      attachmentIds: [],
    });
    const background = value.customOption.draft.draftUserMessage?.parts[0];
    if (background?.type !== "feedback") {
      throw new Error("Expected complete background");
    }
    const document: UserMessageDocument = {
      version: 1,
      parts: [contextPart, background],
    };
    const body = {
      agentId: fixture.agentId,
      threadId: thread.body.id,
      clientEventId: randomUUID(),
      prompt: "Evaluate the unresolved budget",
      hasTextContent: true,
      model: "claude-fable-5-1",
      userMessage: document,
    };
    await accept(events.send({ headers: humanHeaders, body }), [400]);
    expect(
      (await accept(client().list({ headers: humanHeaders }), [200])).body
        .suggestions,
    ).toHaveLength(1);
    const complete = {
      ...body,
      userMessage: {
        ...document,
        parts: [
          contextPart,
          {
            ...background,
            note: [
              {
                type: "text" as const,
                text: "Assess the risks before choosing what to do",
              },
            ],
          },
        ],
      },
    };
    await accept(
      events.send({
        headers: humanHeaders,
        body: {
          ...complete,
          userMessage: {
            ...complete.userMessage,
            parts: [
              contextPart,
              {
                ...background,
                quote: "A truncated summary",
                note: [{ type: "text" as const, text: "Assess the risks" }],
              },
            ],
          },
        },
      }),
      [409],
    );
    await accept(events.send({ headers: humanHeaders, body: complete }), [201]);
    await accept(events.send({ headers: humanHeaders, body: complete }), [201]);
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
    expect(pool.body.receipts).toContainEqual(
      expect.objectContaining({
        id: value.id,
        selectedOptionId: "custom",
        status: "consumed",
      }),
    );
  });

  it("rejects stale custom context without consuming the updated suggestion", async () => {
    const fixture = await primaryRun();
    const value = input();
    await accept(
      client().create({ headers: fixture.headers, body: value }),
      [200],
    );
    const thread = await accept(
      setupApp({ context, routes: chatThreadCreateRoutes })(
        chatThreadsContract,
      ).create({ headers: humanHeaders, body: { agentId: fixture.agentId } }),
      [201],
    );
    const contextPart = suggestionContextPart({
      suggestionId: value.id,
      draftId: randomUUID(),
      optionId: "custom",
      titleSnapshot: value.title,
      rationaleSnapshot: value.rationale,
      contextVersion: "outdated-version",
      attachmentIds: [],
    });
    await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers: humanHeaders,
        body: {
          agentId: fixture.agentId,
          threadId: thread.body.id,
          clientEventId: randomUUID(),
          prompt: "My own direction",
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [
              contextPart,
              {
                type: "feedback",
                quote: "Previous background",
                note: [{ type: "text", text: "Assess this matter" }],
              },
            ],
          },
        },
      }),
      [409],
    );
    expect(
      (await accept(client().list({ headers: humanHeaders }), [200])).body
        .suggestions,
    ).toHaveLength(1);
  });
  it("can send a saved complete quote after its disposable card has been dismissed and compacted", async () => {
    const fixture = await primaryRun();
    const value = input();
    await accept(
      client().create({ headers: fixture.headers, body: value }),
      [200],
    );
    const contextPart = suggestionContextPart({
      suggestionId: value.id,
      draftId: randomUUID(),
      optionId: "custom",
      titleSnapshot: value.title,
      rationaleSnapshot: value.rationale,
      contextVersion: createHash("sha256")
        .update(JSON.stringify(value.customOption.draft))
        .digest("hex"),
      attachmentIds: [],
    });
    const quote = value.customOption.draft.draftUserMessage?.parts[0];
    if (quote?.type !== "feedback") {
      throw new Error("Expected background");
    }
    await accept(
      client().consume({
        headers: humanHeaders,
        params: { id: value.id },
        body: { optionId: null },
      }),
      [200],
    );
    await accept(
      client().create({ headers: fixture.headers, body: input() }),
      [200],
    );
    const thread = await accept(
      setupApp({ context, routes: chatThreadCreateRoutes })(
        chatThreadsContract,
      ).create({ headers: humanHeaders, body: { agentId: fixture.agentId } }),
      [201],
    );
    await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers: humanHeaders,
        body: {
          agentId: fixture.agentId,
          threadId: thread.body.id,
          clientEventId: randomUUID(),
          prompt: "What should I consider about this earlier decision?",
          hasTextContent: true,
          model: "claude-fable-5-1",
          userMessage: {
            version: 1,
            parts: [
              contextPart,
              {
                ...quote,
                note: [
                  {
                    type: "text",
                    text: "What should I consider about this earlier decision?",
                  },
                ],
              },
            ],
          },
        },
      }),
      [201],
    );
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.receipts).toContainEqual(
      expect.objectContaining({
        id: value.id,
        status: "consumed",
        selectedOptionId: null,
      }),
    );
  });
  it("keeps selection receipts restricted to an enabled member session", async () => {
    const fixture = await primaryRun();
    const value = input();
    await accept(
      client().create({ headers: fixture.headers, body: value }),
      [200],
    );
    const quote = value.customOption.draft.draftUserMessage?.parts[0];
    if (quote?.type !== "feedback") {
      throw new Error("Expected complete background");
    }
    const document: UserMessageDocument = {
      version: 1,
      parts: [
        suggestionContextPart({
          suggestionId: value.id,
          draftId: randomUUID(),
          optionId: "custom",
          titleSnapshot: value.title,
          rationaleSnapshot: value.rationale,
          contextVersion: createHash("sha256")
            .update(JSON.stringify(value.customOption.draft))
            .digest("hex"),
          attachmentIds: [],
        }),
        { ...quote, note: [{ type: "text", text: "Review the risks" }] },
      ],
    };
    const thread = await accept(
      setupApp({ context, routes: chatThreadCreateRoutes })(
        chatThreadsContract,
      ).create({ headers: humanHeaders, body: { agentId: fixture.agentId } }),
      [201],
    );
    const events = setupApp({ context, routes: chatEventsRoutes })(
      chatEventsContract,
    );
    const body = {
      agentId: fixture.agentId,
      threadId: thread.body.id,
      prompt: "Review the risks",
      userMessage: document,
      hasTextContent: true,
      model: "claude-fable-5-1",
    };
    await accept(
      events.send({
        headers: fixture.headers,
        body: { ...body, clientEventId: randomUUID() },
      }),
      [201],
    );
    expect(
      (await accept(client().list({ headers: humanHeaders }), [200])).body
        .suggestions,
    ).toHaveLength(1);
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.AgentSuggestion]: false,
    });
    await accept(
      events.send({
        headers: humanHeaders,
        body: { ...body, clientEventId: randomUUID() },
      }),
      [201],
    );
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.AgentSuggestion]: true,
    });
    expect(
      (await accept(client().list({ headers: humanHeaders }), [200])).body
        .suggestions,
    ).toHaveLength(1);
  });
});
