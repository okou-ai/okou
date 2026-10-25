import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  suggestionsContract,
  type SuggestionCreate,
} from "@okouai/api-contracts/contracts/suggestions";
import {
  chatThreadsContract,
  chatThreadByIdContract,
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

const context = testContext();
const humanHeaders = { authorization: "Bearer clerk-session" } as const;
function client() {
  return setupApp({ context, routes: suggestionsRoutes })(suggestionsContract);
}
function input(priority = 0): SuggestionCreate {
  return {
    id: randomUUID(),
    title: "Review the project update",
    rationale: "A decision needs your input",
    threadId: null,
    priority,
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
    { [FeatureSwitchKey.ProactiveAgent]: enabled },
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
        body: {},
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
        body: {},
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
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [{ type: "text", text: "  " }],
            },
            draftAttachments: null,
          },
        },
      }),
      [400],
    );
    await accept(
      client().create({
        headers: fixture.headers,
        body: {
          ...empty,
          draft: { draftUserMessage: null, draftAttachments: null },
        },
      }),
      [400],
    );
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
  });
  it("requires an enabled primary Agent capability and denies human publication", async () => {
    const fixture = await primaryRun(false);
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
            body: {},
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
      draft: selected.draft,
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
      [FeatureSwitchKey.ProactiveAgent]: false,
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
        body: {},
      }),
      [403],
    );
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
        body: { ...suggestion, threadId: thread.body.id },
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
        body: {},
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
        body: { ...input(), threadId: thread.body.id },
      }),
      [404],
    );
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
    const suggestion = { ...input(), threadId: thread.body.id };
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
        body: {},
      }),
      [200],
    );
    expect(consumed.body).toMatchObject({
      status: "consumed",
      threadId: thread.body.id,
      draft: suggestion.draft,
    });
    const pool = await accept(client().list({ headers: humanHeaders }), [200]);
    expect(pool.body.suggestions).toStrictEqual([]);
  });
});
