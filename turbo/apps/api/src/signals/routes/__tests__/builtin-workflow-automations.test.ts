import { createProactiveCronApi } from "./helpers/proactive-cron";
import { cronProactiveRoutes } from "../cron-proactive";
import { randomUUID } from "node:crypto";
import { array, boolean, object, string } from "zod";
import {
  feedContract,
  type SuggestionContent,
} from "@okouai/api-contracts/contracts/feed";
import { feedRoutes } from "../feed";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { expect, test } from "vitest";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { joinAll } from "../../utils";
import { publicChatActor } from "./helpers/public-chat-actor";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRouteMocks } from "./helpers/route-test";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";

const context = testContext();
// The API test baseline's managed key for platform-paid Runs.
const PROACTIVE_MANAGED_KEY = "okou-fake-proactive-model-key-sentinel-8d2b6f41";

async function saveCompletedActionFeedback(
  content: SuggestionContent,
  agentToken: string,
  titles: readonly string[],
) {
  const api = setupApp({ context, routes: feedRoutes })(feedContract);
  async function save(title: string) {
    const created = await accept(
      api.create({
        headers: { authorization: `Bearer ${agentToken}` },
        body: {
          id: randomUUID(),
          type: "suggestion",
          priority: 0,
          content: { ...content, title },
        },
      }),
      [200],
    );
    await accept(
      api.feedback({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: created.body.id },
        body: {
          id: randomUUID(),
          kind: "already_done",
          targetId: null,
          note: "Completed through another channel",
        },
      }),
      [200],
    );
  }
  // Independent owner cards need creation before their feedback, but not before
  // another card. Bound concurrency and settle every request before teardown.
  for (let offset = 0; offset < titles.length; offset += 4) {
    await joinAll(titles.slice(offset, offset + 4).map(save));
  }
}

async function withFeedbackRun<T>(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  write: (agentToken: string) => Promise<T>,
) {
  const fixture = createChatEventsFixture(context);
  const orgId = owned.actor.orgId;
  if (!orgId) {
    throw new Error("Expected a feedback owner workspace");
  }
  await owned.run(() => {
    return createRunsApi(context).registerDirectRunner(owned.runnerGroup);
  });
  const ordinary = await owned.sendChatRun(owned.actor, {
    model: owned.model,
    prompt: "Review the owner's current suggestions",
  });
  const { execution, sandboxHeaders } = await owned.runExecution(
    ordinary.runId,
  );
  expect(execution.appendSystemPrompt).not.toContain(
    "# Suggestions feedback context",
  );
  return owned.run(async () => {
    createRouteMocks(context).clerk.session(
      owned.actor.userId,
      orgId,
      owned.actor.orgRole,
    );
    const result = await write(okouTokenFromExecution(execution));
    await fixture.failChatRun(ordinary.runId, sandboxHeaders, "Feedback saved");
    await flushWaitUntilForTest();
    return result;
  });
}

/** An ordinary chat is the manual Run that keeps platform schedules serving the owner. */
function startOwnerChat(owned: Awaited<ReturnType<typeof publicChatActor>>) {
  return withFeedbackRun(owned, () => {
    return Promise.resolve();
  });
}

async function saveFeedback(
  agentToken: string,
  title: string,
  reason: string,
  kind:
    | "less_like_this"
    | "option_selected"
    | "dismissed"
    | "not_planned"
    | "later" = "less_like_this",
  completedActionTitles: readonly string[] = [],
) {
  const api = setupApp({ context, routes: feedRoutes })(feedContract);
  const id = randomUUID();
  const feedbackId = randomUUID();
  const rationale = "Review the owner's pending decision";
  const headers = { authorization: "Bearer clerk-session" };
  const created = await accept(
    api.create({
      headers: {
        authorization: `Bearer ${agentToken}`,
      },
      body: {
        id,
        type: "suggestion",
        priority: 0,
        content: {
          title,
          rationale,
          options: [
            {
              id: "review",
              label: "Review",
              description: "Review this decision",
              threadId: null,
              draft: {
                draftUserMessage: {
                  version: 1,
                  parts: [{ type: "text", text: "Review this decision" }],
                },
                draftAttachments: null,
              },
            },
          ],
          customOption: {
            id: "custom",
            threadId: null,
            draft: {
              draftUserMessage: {
                version: 1,
                parts: [{ type: "feedback", quote: rationale, note: [] }],
              },
              draftAttachments: null,
            },
          },
        },
      },
    }),
    [200],
  );
  if (kind === "option_selected") {
    await accept(
      api.consume({ headers, params: { id }, body: { optionId: "review" } }),
      [200],
    );
  } else {
    await accept(
      api.feedback({
        headers,
        params: { id },
        body: {
          id: feedbackId,
          kind,
          targetId: null,
          note: {
            less_like_this: "Initial preference",
            not_planned: "Do not nudge me about this again.",
            later: "",
            dismissed: "",
          }[kind],
        },
      }),
      [200],
    );
    if (kind === "less_like_this" || kind === "not_planned") {
      await accept(
        api.feedback({
          headers,
          params: { id },
          body: {
            id: randomUUID(),
            kind: "reason",
            targetId: feedbackId,
            note: reason,
          },
        }),
        [200],
      );
    }
  }
  await saveCompletedActionFeedback(
    created.body.content,
    agentToken,
    completedActionTitles,
  );
  return {
    expected: {
      title,
      rationale,
      message: {
        less_like_this: `Show me fewer suggestions like this. My reason: ${reason}`,
        option_selected: "I chose this direction: Review",
        later: "I want to look at this later. Remind me after a while.",
        not_planned: `Do not nudge me about this again. My reason: ${reason}`,
        dismissed: "",
      }[kind],
    },
    undo: async () => {
      await accept(
        api.feedback({
          headers,
          params: { id },
          body: {
            id: randomUUID(),
            kind: "undo",
            targetId: feedbackId,
            note: "",
            snapshot: created.body,
          },
        }),
        [200],
      );
    },
  };
}

async function prepareForeignFeedback(
  definitionName: string,
  peerOrgId: string,
) {
  if (
    definitionName !== "agent-suggestions" &&
    definitionName !== "proactive-learning"
  ) {
    return;
  }
  const foreign = await publicChatActor(context);
  await withFeedbackRun(foreign, (token) => {
    return saveFeedback(
      token,
      "Another workspace's private decision",
      "Private foreign workspace preference",
    );
  });
  const peer = await publicChatActor(context, {
    actor: createChatEventsFixture(context).bdd.user({ orgId: peerOrgId }),
  });
  await withFeedbackRun(peer, (token) => {
    return saveFeedback(
      token,
      "Another member's private decision",
      "Private same-workspace preference",
    );
  });
}

type ExpectedFeedback = Awaited<ReturnType<typeof saveFeedback>>["expected"];

interface SuggestionFeedbackLifecycle {
  startedAt: number;
  existing: ExpectedFeedback;
  selected: ExpectedFeedback;
  undo: () => Promise<void>;
}

async function prepareWorkflowFeedback(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  definitionName: string,
): Promise<{
  initial: ExpectedFeedback[];
  lifecycle?: SuggestionFeedbackLifecycle;
}> {
  const learning = definitionName === "proactive-learning";
  if (definitionName !== "agent-suggestions" && !learning) {
    return { initial: [] };
  }
  const { expected: existing } = await withFeedbackRun(owned, (token) => {
    return saveFeedback(
      token,
      "Review the launch decision",
      "A teammate owns these reviews",
      learning ? "option_selected" : "less_like_this",
    );
  });
  if (learning) {
    const legacy = await withFeedbackRun(owned, (token) => {
      return saveFeedback(
        token,
        "A suggestion dismissed by an older client",
        "I already have a reminder",
        "not_planned",
      );
    });
    return { initial: [existing, legacy.expected] };
  }
  const startedAt = now();
  return withMockNowForTest(startedAt, () => {
    return withFeedbackRun(owned, async (token) => {
      const undone = await saveFeedback(
        token,
        "Undo this preference",
        "",
        "later",
      );
      const selected = await saveFeedback(
        token,
        "Selected direction",
        "",
        "option_selected",
      );
      await saveFeedback(token, "Dismissed suggestion", "", "dismissed");
      return {
        initial: [existing, undone.expected, selected.expected],
        lifecycle: {
          startedAt,
          existing,
          selected: selected.expected,
          undo: undone.undo,
        },
      };
    });
  });
}

const feedbackSchema = object({
  complete: boolean(),
  feedback: array(
    object({
      message: string(),
      title: string(),
      rationale: string(),
    }),
  ),
});

function readFeedbackContext(
  prompt: string | null | undefined,
  expectedComplete = true,
) {
  expect(prompt).toContain("# Suggestions feedback context");
  const json = prompt?.match(/^(\{"asOf":.*\})$/mu)?.[1];
  expect(json).toBeDefined();
  const feedback = feedbackSchema.parse(JSON.parse(json ?? "null"));
  expect(feedback.complete).toBe(expectedComplete);
  return feedback.feedback;
}

async function expectSuggestionFeedbackLifecycle(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  { startedAt, existing, selected, undo }: SuggestionFeedbackLifecycle,
) {
  const fixture = createChatEventsFixture(context);
  const app = setupApp({ context, routes: proactiveSuggestionsRoutes });
  const cron = createProactiveCronApi(context);
  const headers = { authorization: "Bearer clerk-session" };
  const day = 86_400_000;
  function readFeedback(at: number, expectedComplete = true) {
    return withMockNowForTest(at, async () => {
      // Each read serves an owner who is still chatting with Okou.
      await startOwnerChat(owned);
      await owned.run(() => {
        return accept(
          app(proactiveSuggestionsContract).update({
            headers,
            body: { enabled: true },
          }),
          [200],
        );
      });
      return withMockNowForTest(at + 60_000, async () => {
        await owned.run(() => {
          return createRunsApi(context).registerDirectRunner(owned.runnerGroup);
        });
        await owned.run(cron.dispatch);
        const runId = await owned.run(() => {
          return cron.latestRun(owned.actor, "Proactive Suggestions");
        });
        const { execution, sandboxHeaders } = await owned.runExecution(runId);
        const feedback = readFeedbackContext(
          execution.appendSystemPrompt,
          expectedComplete,
        );
        await owned.run(() => {
          return fixture.failChatRun(
            runId,
            sandboxHeaders,
            "Feedback lifecycle inspected",
          );
        });
        await owned.run(flushWaitUntilForTest);
        await owned.run(() => {
          return accept(
            app(proactiveSuggestionsContract).update({
              headers,
              body: { enabled: false },
            }),
            [200],
          );
        });
        return feedback;
      });
    });
  }
  await withMockNowForTest(startedAt, async () => {
    await owned.run(undo);
    const afterUndo = await readFeedback(startedAt + 60 * 60_000);
    expect(afterUndo).toHaveLength(2);
    expect(afterUndo).toStrictEqual(
      expect.arrayContaining([existing, selected]),
    );
    await expect(readFeedback(startedAt + 7 * day)).resolves.toStrictEqual([
      existing,
    ]);
    await expect(readFeedback(startedAt + 30 * day)).resolves.toStrictEqual([]);
    await withMockNowForTest(startedAt + 30 * day, async () => {
      const completedTitles = Array.from({ length: 101 }, (_, index) => {
        return `Completed owner task ${index + 1}`;
      });
      await withFeedbackRun(owned, (token) => {
        return saveFeedback(
          token,
          "Retained owner preference",
          "Consider the owner's completed work",
          "less_like_this",
          completedTitles,
        );
      });
      // The real scheduled Run must disclose omitted action facts so its
      // instructions skip maintenance instead of repeating completed work.
      const bounded = await readFeedback(now() + 60 * 60_000, false);
      const completed = bounded.filter((feedback) => {
        return completedTitles.includes(feedback.title);
      });
      expect(completed.length).toBeGreaterThan(0);
      expect(completed.length).toBeLessThan(completedTitles.length);
      for (const feedback of completed) {
        expect(completedTitles).toContain(feedback.title);
        expect(feedback).toMatchObject({
          rationale: "Review the owner's pending decision",
          message:
            "I have already done this. My reason: Completed through another channel",
        });
      }
    });
  });
}

function expectScopeGuidance(
  instruction: string | null | undefined,
  learning: boolean,
) {
  if (learning) {
    expect(instruction).toContain(
      "changes to personal Instructions or shared Agent instructions",
    );
    expect(instruction).toContain(
      "Never override a higher-priority framework write restriction",
    );
  } else {
    expect(instruction).toContain("okou chat list --help");
  }
}

const scenarios = [
  { kind: "suggestions", suggestionsEnabled: true },
  { kind: "learning", suggestionsEnabled: true },
  { kind: "morning-brief", suggestionsEnabled: true },
  { kind: "morning-brief", suggestionsEnabled: false },
].map((scenario) => {
  const learning = scenario.kind === "learning";
  const morningBrief = scenario.kind === "morning-brief";
  return {
    ...scenario,
    learning,
    morningBrief,
    curatesSuggestions: !learning && scenario.suggestionsEnabled,
    curatesMorningBrief: morningBrief && scenario.suggestionsEnabled,
    definitionName: learning
      ? "proactive-learning"
      : morningBrief
        ? "morning-brief"
        : "agent-suggestions",
    heading: learning
      ? "# Proactive Learning"
      : morningBrief
        ? "# Morning Brief"
        : "# Proactive Suggestions",
    preferenceContract: morningBrief
      ? morningBriefPreferenceContract
      : proactiveSuggestionsContract,
  };
});

function expectWorkflowInstructions(
  instruction: string | null | undefined,
  definitionName: string,
  learning: boolean,
) {
  if (definitionName === "morning-brief") {
    expect(instruction).toContain("Only maintain Suggestions when");
    expect(instruction).toContain("## Decide whether to email the briefing");
  }
  expectScopeGuidance(instruction, learning);
}

test.each(scenarios)(
  "runs the built-in $kind with its instructions in the user prompt (Suggestions enabled: $suggestionsEnabled)",
  // The Suggestions case creates 101 distinct action receipts through the real
  // API and inspects an additional scheduled Run to verify truncated context.
  { timeout: 15_000 },
  async ({
    learning,
    curatesMorningBrief,
    curatesSuggestions,
    definitionName,
    heading,
    preferenceContract,
  }) => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...proactiveSuggestionsRoutes,
        ...morningBriefPreferenceRoutes,
      ],
    });
    // This member's UTC slots are 02:12 for Learning, :42 for Suggestions and 06:57 for Morning Brief.
    const at =
      definitionName === "morning-brief"
        ? Date.UTC(2030, 0, 2, 6, 57)
        : learning
          ? Date.UTC(2030, 0, 2, 2, 12)
          : Date.UTC(2030, 0, 2, 12, 42);
    mockNow(at - 30_000);
    const cron = createProactiveCronApi(context);
    await prepareForeignFeedback(definitionName, "org_proactive_content");
    const fixture = createChatEventsFixture(context);
    const actor = fixture.bdd.user({
      orgId: "org_proactive_content",
      userId: "user_proactive_content3",
    });
    const owned = await publicChatActor(context, { actor });
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization owner");
    }
    await owned.run(() => {
      return fixture.bdd.completeOnboarding(actor, {
        timezone: "UTC",
      });
    });
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const headers = { authorization: "Bearer clerk-session" };
    if (curatesMorningBrief) {
      await owned.run(() => {
        return accept(
          app(proactiveSuggestionsContract).update({
            headers,
            body: { enabled: true },
          }),
          [200],
        );
      });
    }
    const enabled = await owned.run(() => {
      const request = app(preferenceContract).update({
        headers,
        body: { enabled: true },
      });
      return accept<Awaited<typeof request>, 200>(request, [200]);
    });
    expect(enabled.body).toMatchObject({ enabled: true, status: "enabled" });
    // Platform schedules serve an owner with a recent manual Run.
    await startOwnerChat(owned);
    const feedback = await prepareWorkflowFeedback(owned, definitionName);
    createRouteMocks(context).clerk.session(actor.userId, orgId, actor.orgRole);
    const { execution, sandboxHeaders, runId } = await withMockNowForTest(
      at,
      () => {
        return owned.run(async () => {
          await createRunsApi(context).registerDirectRunner(owned.runnerGroup);
          await expect(cron.dispatch()).resolves.toMatchObject({ enqueued: 1 });
          const runId = await cron.latestRun(actor, heading.slice(2));
          return { ...(await owned.runExecution(runId)), runId };
        });
      },
    );
    if (learning || curatesSuggestions) {
      const initial = readFeedbackContext(execution.appendSystemPrompt);
      expect(initial).toHaveLength(feedback.initial.length);
      expect(initial).toStrictEqual(expect.arrayContaining(feedback.initial));
    } else {
      expect(execution.appendSystemPrompt).not.toContain(
        "# Suggestions feedback context",
      );
    }
    if (!curatesSuggestions) {
      await owned.run(() => {
        return accept(
          setupApp({ context, routes: feedRoutes })(feedContract).manage({
            headers: {
              authorization: `Bearer ${okouTokenFromExecution(execution)}`,
            },
            query: { type: "suggestion" },
          }),
          [403],
        );
      });
    }
    expect(execution.piSessionId).toBe(
      execution.cliAgentType === "pi" ? runId : undefined,
    );
    expect(execution.prompt).toContain(heading);
    expectWorkflowInstructions(execution.prompt, definitionName, learning);
    if (!learning) {
      expect(execution.prompt).toContain(
        "# Suggestion source and publishing reference",
      );
    }
    await withMockNowForTest(at, async () => {
      await owned.run(async () => {
        // An older standalone producer can finish with the hidden thread's ID
        // before its initialization events have been delivered.
        const threadId = execution.platformEnvironment.OKOU_CHAT_THREAD_ID;
        if (!threadId) {
          throw new Error("Expected the proactive Run's chat thread");
        }
        expect(threadId).not.toBe(runId);
        const completed = await fixture.webhooks.requestAgentRunOutputs(
          {
            runId,
            cliAgentType: "pi",
            cliAgentSessionId: threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
          sandboxHeaders,
          [200],
        );
        expect(completed.body).toStrictEqual({
          success: true,
          status: "completed",
        });
      });
      await owned.run(flushWaitUntilForTest);
    });
    if (feedback.lifecycle) {
      await expectSuggestionFeedbackLifecycle(owned, feedback.lifecycle);
    }
  },
);

test.each([
  {
    title: "Proactive Learning",
    hour: 2,
    minute: 12,
    contract: proactiveSuggestionsContract,
  },
  {
    title: "Proactive Suggestions",
    hour: 12,
    minute: 42,
    contract: proactiveSuggestionsContract,
  },
  {
    title: "Morning Brief",
    hour: 6,
    minute: 57,
    contract: morningBriefPreferenceContract,
  },
])(
  "serves $title only while the member has recent manual activity",
  async ({ title, hour, minute, contract }) => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...morningBriefPreferenceRoutes,
        ...proactiveSuggestionsRoutes,
      ],
    });
    const day = 86_400_000;
    const firstSlot = Date.UTC(2030, 0, 2, hour, minute);
    mockNow(firstSlot - 30_000);
    const cron = createProactiveCronApi(context);
    const fixture = createChatEventsFixture(context);
    const actor = fixture.bdd.user({
      orgId: "org_proactive_content",
      userId: "user_proactive_content3",
    });
    const owned = await publicChatActor(context, { actor });
    await owned.run(() => {
      return fixture.bdd.completeOnboarding(actor, { timezone: "UTC" });
    });
    const headers = { authorization: "Bearer clerk-session" };
    await owned.run(async () => {
      const request = app(contract).update({
        headers,
        body: { enabled: true },
      });
      await accept<Awaited<typeof request>, 200>(request, [200]);
    });
    mockNow(firstSlot);
    await expect(owned.run(cron.dispatch)).resolves.toMatchObject({
      enqueued: 0,
      inactive: 1,
    });
    const preference = await owned.run(() => {
      const request = app(contract).get({ headers });
      return accept<Awaited<typeof request>, 200>(request, [200]);
    });
    expect(preference.body).toMatchObject({ enabled: true, status: "enabled" });
    const activeSlot =
      firstSlot + (title === "Proactive Suggestions" ? 60 * 60_000 : day);
    mockNow(activeSlot - 60_000);
    await startOwnerChat(owned);
    mockNow(activeSlot);
    await owned.run(() => {
      return createRunsApi(context).registerDirectRunner(owned.runnerGroup);
    });
    await owned.run(cron.dispatch);
    const id = await owned.run(() => {
      return cron.latestRun(actor, title);
    });
    const { execution, sandboxHeaders } = await owned.runExecution(id);
    const resolved = await owned.run(() => {
      return createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
          },
          firewallBillable: true,
        },
        [200],
      );
    });
    expect(resolved.body).toMatchObject({
      headers: { Authorization: `Bearer ${PROACTIVE_MANAGED_KEY}` },
      resolvedSecrets: ["OPENROUTER_API_KEY"],
    });
    // Report the session the Runner actually received from the standalone cron.
    const sessionId = execution.piSessionId;
    const threadId = execution.platformEnvironment.OKOU_CHAT_THREAD_ID;
    if (!sessionId || !threadId) {
      throw new Error(
        "Expected a Pi session and chat thread for the proactive Run",
      );
    }
    expect(sessionId).toBe(id);
    expect(threadId).not.toBe(sessionId);
    await owned.run(async () => {
      await fixture.webhooks.requestAgentEvents(
        {
          runId: id,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              sequenceNumber: 0,
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      const output = {
        runId: id,
        cliAgentType: "pi",
        cliAgentSessionId: sessionId,
        cliAgentSessionHistoryDisposition: "native_only",
      } as const;
      await fixture.webhooks.requestAgentRunOutputs(
        { ...output, cliAgentSessionId: threadId },
        sandboxHeaders,
        [400],
      );
      const complete = await fixture.webhooks.requestAgentRunOutputs(
        output,
        sandboxHeaders,
        [200],
      );
      expect(complete.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      const replay = await fixture.webhooks.requestAgentRunOutputs(
        output,
        sandboxHeaders,
        [200],
      );
      expect(replay.body).toStrictEqual(complete.body);
      await expect(fixture.api.readRun(actor, id)).resolves.toMatchObject({
        status: "completed",
        result: { framework: "pi", frameworkSessionId: sessionId },
      });
    });
    await owned.run(flushWaitUntilForTest);
    mockNow(activeSlot + 7 * day);
    await owned.run(cron.dispatch);
    mockNow(activeSlot + 8 * day);
    const lapsed = await owned.run(cron.dispatch);
    expect(lapsed).toMatchObject({ enqueued: 0 });
    await expect(
      owned.run(() => {
        return cron.latestRun(actor, title);
      }),
    ).resolves.toBe(id);
  },
);
