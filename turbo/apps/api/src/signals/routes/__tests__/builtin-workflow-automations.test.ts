import { randomUUID } from "node:crypto";
import { array, boolean, object, string } from "zod";
import {
  feedContract,
  type SuggestionContent,
} from "@okouai/api-contracts/contracts/feed";
import { feedRoutes } from "../feed";
import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";
import { now, withMockNowForTest } from "../../../lib/time";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { expect, test } from "vitest";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowAutomationSummary,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CODEX_HOME_DIR,
  PI_SKILLS_ROOT,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { joinAll } from "../../utils";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { publicChatActor } from "./helpers/public-chat-actor";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";

const context = testContext();
// The API test baseline's managed key for platform-paid Official Runs.
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

/** An ordinary chat is the manual Run that keeps Official schedules serving the owner. */
function startOwnerChat(owned: Awaited<ReturnType<typeof publicChatActor>>) {
  return withFeedbackRun(owned, () => {
    return Promise.resolve();
  });
}

/** Settle Official Runs still in flight, such as those launched by the same cron tick. */
async function failActiveOfficialRuns(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  workflows: readonly WorkflowSummary[],
  include: (workflow: WorkflowSummary) => boolean,
) {
  const fixture = createChatEventsFixture(context);
  const app = setupApp({ context, routes: workflowAutomationsRoutes });
  const headers = { authorization: "Bearer clerk-session" };
  for (const item of workflows.filter(include)) {
    const schedules = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).list({
          headers,
          params: { workflowId: item.id },
        }),
        [200],
      );
    });
    const threadId = schedules.body[0]?.chatThreadId;
    if (!threadId) {
      continue;
    }
    const events = await owned.run(() => {
      return createChatFilesBddApi(context).listThreadEventRows(
        owned.actor,
        threadId,
      );
    });
    for (const event of events) {
      if (event.eventType !== "input.prompt" || !event.runId) {
        continue;
      }
      const runId = event.runId;
      const run = await owned.run(() => {
        return createRunsApi(context).readRun(owned.actor, runId);
      });
      if (run.status !== "pending" && run.status !== "running") {
        continue;
      }
      const { sandboxHeaders } = await owned.runExecution(runId);
      await owned.run(() => {
        return fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Concurrent Official Run inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    }
  }
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

async function prepareForeignFeedback(definitionName: string) {
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
  const peer = await publicChatActor(context);
  await withFeedbackRun(peer, (token) => {
    return saveFeedback(
      token,
      "Another member's private decision",
      "Private same-workspace preference",
    );
  });
  return peer.actor.orgId;
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
  workflowId: string,
  { startedAt, existing, selected, undo }: SuggestionFeedbackLifecycle,
) {
  const fixture = createChatEventsFixture(context);
  const app = setupApp({
    context,
    routes: [
      ...proactiveSuggestionsRoutes,
      ...workflowAutomationsRoutes,
      ...cronExecuteWorkflowAutomationsRoutes,
    ],
  });
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
      const schedules = await owned.run(() => {
        return accept(
          app(workflowAutomationsContract).list({
            headers,
            params: { workflowId },
          }),
          [200],
        );
      });
      const schedule = schedules.body[0];
      if (!schedule?.nextRunAt) {
        throw new Error("Expected the Suggestions schedule");
      }
      return withMockNowForTest(
        Math.max(at, Date.parse(schedule.nextRunAt)),
        async () => {
          await owned.run(() => {
            return createRunsApi(context).registerDirectRunner(
              owned.runnerGroup,
            );
          });
          await owned.run(() => {
            return accept(
              app(cronExecuteWorkflowAutomationsContract).execute({
                headers: {
                  authorization: "Bearer workflow-automation-cron-secret",
                },
              }),
              [200],
            );
          });
          await owned.run(flushWaitUntilForTest);
          const current = await owned.run(() => {
            return accept(
              app(workflowAutomationsContract).get({
                headers,
                params: { id: schedule.id },
              }),
              [200],
            );
          });
          if (!current.body.chatThreadId) {
            throw new Error("Expected the Suggestions execution thread");
          }
          const events = await owned.run(() => {
            return createChatFilesBddApi(context).listThreadEventRows(
              owned.actor,
              current.body.chatThreadId ?? "",
            );
          });
          const runId = [...events].reverse().find((event) => {
            return event.eventType === "input.prompt" && event.runId;
          })?.runId;
          if (!runId) {
            throw new Error("Expected a scheduled Suggestions Run");
          }
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
        },
      );
    });
  }
  await withMockNowForTest(startedAt, async () => {
    await owned.run(undo);
    const afterUndo = await readFeedback(startedAt);
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
      const bounded = await readFeedback(now(), false);
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

async function expectMorningBriefRecovery(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  automationId: string,
  workflowId: string,
) {
  const fixture = createChatEventsFixture(context);
  const app = setupApp({
    context,
    routes: [
      ...cronExecuteWorkflowAutomationsRoutes,
      ...workflowAutomationsRoutes,
      ...morningBriefPreferenceRoutes,
      ...feedRoutes,
    ],
  });
  const headers = { authorization: "Bearer clerk-session" };
  async function readAutomation() {
    return (
      await accept(
        app(workflowAutomationsContract).get({
          headers,
          params: { id: automationId },
        }),
        [200],
      )
    ).body;
  }
  const failures: {
    runId: string;
    headers: { authorization: string };
    completedAt: string;
  }[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readAutomation();
    if (!before.enabled || !before.nextRunAt) {
      throw new Error("Expected the published Morning Brief's next occurrence");
    }
    failures.push(
      await withMockNowForTest(Date.parse(before.nextRunAt), async () => {
        await createRunsApi(context).registerDirectRunner(owned.runnerGroup);
        await accept(
          app(cronExecuteWorkflowAutomationsContract).execute({
            headers: {
              authorization: "Bearer workflow-automation-cron-secret",
            },
          }),
          [200],
        );
        await flushWaitUntilForTest();
        const current = await readAutomation();
        if (!current.chatThreadId) {
          throw new Error("Expected the published Morning Brief's thread");
        }
        const events = await createChatFilesBddApi(context).listThreadEventRows(
          owned.actor,
          current.chatThreadId,
        );
        const runId = [...events].reverse().find((event) => {
          return event.eventType === "input.prompt" && event.runId;
        })?.runId;
        if (!runId) {
          throw new Error("Expected the next Morning Brief Run");
        }
        const { sandboxHeaders } = await owned.runExecution(runId);
        await fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Morning Brief execution failed",
        );
        await flushWaitUntilForTest();
        return {
          runId,
          headers: sandboxHeaders,
          completedAt: before.nextRunAt!,
        };
      }),
    );
  }
  const threshold = failures.at(-1);
  if (!threshold) {
    throw new Error("Expected the third Morning Brief failure");
  }
  const disabled = await readAutomation();
  expect(disabled).toMatchObject({
    enabled: false,
    official: { intendedEnabled: true },
  });
  expect(Date.parse(disabled.nextRunAt ?? "")).toBeGreaterThan(
    Date.parse(threshold.completedAt),
  );
  const unchanged = await accept(
    app(morningBriefPreferenceContract).update({
      headers,
      body: { enabled: true },
    }),
    [200],
  );
  expect(unchanged.body).toMatchObject({ enabled: true, status: "error" });
  await expect(readAutomation()).resolves.toMatchObject({
    enabled: false,
    nextRunAt: disabled.nextRunAt,
  });
  const delivered = await accept(
    app(feedContract).list({ headers, query: { type: "event" } }),
    [200],
  );
  expect(delivered.body.items).toStrictEqual([
    expect.objectContaining({
      type: "event",
      content: expect.objectContaining({
        eventType: "automation-disabled",
        automationId,
        workflowId,
        workspaceId: owned.actor.orgId,
        automationDescription: expect.stringMatching(/\S/u),
        consecutiveFailures: 3,
        recoveryScheduled: true,
      }),
    }),
  ]);
  await fixture.failChatRun(
    threshold.runId,
    threshold.headers,
    "Morning Brief execution failed",
  );
  await flushWaitUntilForTest();
  const repeated = await accept(
    app(feedContract).list({ headers, query: { type: "event" } }),
    [200],
  );
  expect(repeated.body.items).toStrictEqual(delivered.body.items);
  await expect(readAutomation()).resolves.toMatchObject({
    enabled: false,
    nextRunAt: disabled.nextRunAt,
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

function expectBuiltinCronSchedule(
  automation: WorkflowAutomationSummary,
  learning: boolean,
) {
  if (automation.kind !== "schedule" || automation.schedule.type !== "cron") {
    throw new Error("Expected an Official cron schedule");
  }
  const { schedule } = automation;
  expect(automation.official?.parameterBindings).toStrictEqual([
    { key: "cron", value: schedule.cronExpression },
  ]);
  if (learning) {
    expect(schedule.cronExpression.split(" ")[1]).toBe("2");
    expect(schedule.timezone).toBe("Asia/Shanghai");
  }
  return schedule;
}

function isProactiveProfileWorkflow(workflow: WorkflowSummary) {
  return (
    workflow.official?.definitionName === "agent-suggestions" ||
    workflow.official?.definitionName === "proactive-learning"
  );
}

async function expectSharedProactiveSchedules(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  workflows: readonly WorkflowSummary[],
  enabled: boolean,
) {
  const proactive = workflows.filter(isProactiveProfileWorkflow);
  if (proactive.length === 0) {
    return;
  }
  expect(
    proactive
      .map((workflow) => {
        return workflow.official?.definitionName;
      })
      .sort(),
  ).toStrictEqual(["agent-suggestions", "proactive-learning"]);
  const app = setupApp({
    context,
    routes: [...proactiveSuggestionsRoutes, ...workflowAutomationsRoutes],
  });
  const headers = { authorization: "Bearer clerk-session" };
  if (!enabled) {
    await owned.run(() => {
      return accept(
        app(proactiveSuggestionsContract).update({
          headers,
          body: { enabled: false },
        }),
        [200],
      );
    });
  }
  for (const workflow of proactive) {
    const schedules = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).list({
          headers,
          params: { workflowId: workflow.id },
        }),
        [200],
      );
    });
    expect(schedules.body).toMatchObject([
      { enabled, official: { intendedEnabled: enabled } },
    ]);
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

function officialWorkflowBundle(
  execution: ExecutionContext,
  definitionName: string,
) {
  const skillRoot =
    execution.cliAgentType === "pi"
      ? PI_SKILLS_ROOT
      : execution.cliAgentType === "codex"
        ? `${CANONICAL_CODEX_HOME_DIR}/skills`
        : `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`;
  const bundles = execution.contentBundles.skills.filter((bundle) => {
    return bundle.mountPath === `${skillRoot}/${definitionName}`;
  });
  expect(bundles).toHaveLength(1);
  const [bundle] = bundles;
  if (!bundle) {
    throw new Error("Expected an Official Workflow bundle in execution input");
  }
  expect(execution.piSessionId).toBe(
    execution.cliAgentType === "pi" ? execution.runId : undefined,
  );
  return bundle;
}

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
    mockEnv("CRON_SECRET", "workflow-automation-cron-secret");
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronExecuteWorkflowAutomationsRoutes,
        ...proactiveSuggestionsRoutes,
        ...morningBriefPreferenceRoutes,
        ...workflowAutomationsRoutes,
        ...workflowsRoutes,
      ],
    });
    const peerOrgId = await prepareForeignFeedback(definitionName);
    const fixture = createChatEventsFixture(context);
    const owned = await publicChatActor(context, {
      actor: peerOrgId ? fixture.bdd.user({ orgId: peerOrgId }) : undefined,
    });
    installWorkflowVolumeS3Fixture(context);
    const cronHeaders = {
      authorization: "Bearer workflow-automation-cron-secret",
    };
    const actor = owned.actor;
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization owner");
    }
    await owned.run(() => {
      return fixture.bdd.completeOnboarding(actor, {
        timezone: "Asia/Shanghai",
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
    // Official schedules serve an owner with a recent manual Run.
    await startOwnerChat(owned);
    const feedback = await prepareWorkflowFeedback(owned, definitionName);
    createRouteMocks(context).clerk.session(actor.userId, orgId, actor.orgRole);
    const workflows = await owned.run(() => {
      return accept(
        app(workflowsCollectionContract).list({ headers, query: {} }),
        [200],
      );
    });
    await expectSharedProactiveSchedules(owned, workflows.body, true);
    const workflow = workflows.body.find((item) => {
      return item.official?.definitionName === definitionName;
    });
    if (!workflow) {
      throw new Error("Expected the Official workflow installation");
    }
    const selectedWorkflowId = workflow.id;
    const detail = await owned.run(() => {
      return accept(
        app(workflowsDetailContract).get({
          headers,
          params: { workflowId: workflow.id },
        }),
        [200],
      );
    });
    expect(detail.body.instruction).toBe("");
    expect(detail.body.fileContents).toStrictEqual([]);
    const automations = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).list({
          headers,
          params: { workflowId: workflow.id },
        }),
        [200],
      );
    });
    const automation = automations.body[0];
    if (!automation) {
      throw new Error("Expected the Official workflow automation");
    }
    if (!automation.nextRunAt) {
      throw new Error("Expected the next Official workflow schedule");
    }
    const schedule = expectBuiltinCronSchedule(automation, learning);
    // Feedback setup may finish after this occurrence becomes due.
    const dispatchedAt = Math.max(now(), Date.parse(automation.nextRunAt));
    await withMockNowForTest(dispatchedAt, async () => {
      await createRunsApi(context).registerDirectRunner(owned.runnerGroup);
      await owned.run(() => {
        return accept(
          app(cronExecuteWorkflowAutomationsContract).execute({
            headers: cronHeaders,
          }),
          [200],
        );
      });
      await owned.run(flushWaitUntilForTest);
    });
    const current = await owned.run(() => {
      return accept(
        app(workflowAutomationsContract).get({
          headers,
          params: { id: automation.id },
        }),
        [200],
      );
    });
    const chatThreadId = current.body.chatThreadId;
    if (!chatThreadId) {
      throw new Error("Expected the Official workflow execution thread");
    }
    const events = await owned.run(() => {
      return createChatFilesBddApi(context).listThreadEventRows(
        actor,
        chatThreadId,
      );
    });
    const launched = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId;
    });
    if (!launched?.runId) {
      throw new Error("Expected the Official Workflow Run");
    }
    const runId = launched.runId;
    const { execution, sandboxHeaders } = await owned.runExecution(runId);
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
    const bundle = officialWorkflowBundle(execution, definitionName);
    expect(bundle.downloadUrl).toBe(
      `https://static.vm0.io/workflows/builtin-skills/${bundle.sha256}.tar.gz`,
    );
    expect(execution.prompt).toContain(heading);
    expectWorkflowInstructions(execution.prompt, definitionName, learning);
    if (!learning) {
      expect(execution.prompt).toContain(
        "# Suggestion source and publishing reference",
      );
    }
    await withMockNowForTest(dispatchedAt, async () => {
      await owned.run(() => {
        return fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Official Workflow inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    });
    if (feedback.lifecycle) {
      await expectSuggestionFeedbackLifecycle(
        owned,
        workflow.id,
        feedback.lifecycle,
      );
    }
    if (definitionName === "morning-brief") {
      await expectMorningBriefRecovery(owned, automation.id, workflow.id);
    }
    await failActiveOfficialRuns(owned, workflows.body, (item) => {
      return item.id !== selectedWorkflowId && isProactiveProfileWorkflow(item);
    });
    await expectSharedProactiveSchedules(owned, workflows.body, false);
    if (learning) {
      await owned.run(async () => {
        const client = app(workflowsDetailContract);
        const copy = await accept(
          client.copy({
            headers,
            params: { workflowId: workflow.id },
            body: {},
          }),
          [201],
        );
        expect(copy.body.official).toBeNull();
        const detail = await accept(
          client.get({ headers, params: { workflowId: copy.body.id } }),
          [200],
        );
        expect(detail.body.instruction).toContain(heading);
        const copied = await accept(
          app(workflowAutomationsContract).list({
            headers,
            params: { workflowId: copy.body.id },
          }),
          [200],
        );
        expect(copied.body).toMatchObject([{ official: null, schedule }]);
      });
    }
  },
);

const activityScenarios = Object.freeze([
  {
    schedules: "Suggestions and Learning",
    definitionNames: ["agent-suggestions", "proactive-learning"],
    preferenceContract: proactiveSuggestionsContract,
  },
  {
    schedules: "Morning Brief",
    definitionNames: ["morning-brief"],
    preferenceContract: morningBriefPreferenceContract,
  },
]);

test.each(activityScenarios)(
  "serves $schedules only within seven days of the owner's manual Run",
  { timeout: 15_000 },
  async ({ definitionNames, preferenceContract }) => {
    mockEnv("CRON_SECRET", "workflow-automation-cron-secret");
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronExecuteWorkflowAutomationsRoutes,
        ...proactiveSuggestionsRoutes,
        ...morningBriefPreferenceRoutes,
        ...workflowAutomationsRoutes,
        ...workflowsRoutes,
      ],
    });
    const fixture = createChatEventsFixture(context);
    const owned = await publicChatActor(context);
    installWorkflowVolumeS3Fixture(context);
    const cronHeaders = {
      authorization: "Bearer workflow-automation-cron-secret",
    };
    const { actor } = owned;
    await owned.run(() => {
      return fixture.bdd.completeOnboarding(actor, {
        timezone: "Asia/Shanghai",
      });
    });
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const headers = { authorization: "Bearer clerk-session" };
    await owned.run(() => {
      const request = app(preferenceContract).update({
        headers,
        body: { enabled: true },
      });
      return accept<Awaited<typeof request>, 200>(request, [200]);
    });
    const workflows = await owned.run(() => {
      return accept(
        app(workflowsCollectionContract).list({ headers, query: {} }),
        [200],
      );
    });
    const watched = definitionNames.map((name) => {
      const workflow = workflows.body.find((item) => {
        return item.official?.definitionName === name;
      });
      if (!workflow) {
        throw new Error(`Expected the ${name} installation`);
      }
      return workflow;
    });
    async function readSchedules() {
      const schedules = [];
      for (const workflow of watched) {
        const listed = await owned.run(() => {
          return accept(
            app(workflowAutomationsContract).list({
              headers,
              params: { workflowId: workflow.id },
            }),
            [200],
          );
        });
        const schedule = listed.body[0];
        if (!schedule) {
          throw new Error("Expected the Official schedule");
        }
        schedules.push(schedule);
      }
      return schedules;
    }
    async function readLaunchedRunIds(threadId: string | null) {
      if (!threadId) {
        return [];
      }
      const events = await owned.run(() => {
        return createChatFilesBddApi(context).listThreadEventRows(
          actor,
          threadId,
        );
      });
      return events.flatMap((event) => {
        return event.eventType === "input.prompt" && event.runId
          ? [event.runId]
          : [];
      });
    }
    async function dispatch(at: number) {
      await withMockNowForTest(at, async () => {
        await createRunsApi(context).registerDirectRunner(owned.runnerGroup);
        await owned.run(() => {
          return accept(
            app(cronExecuteWorkflowAutomationsContract).execute({
              headers: cronHeaders,
            }),
            [200],
          );
        });
        await owned.run(flushWaitUntilForTest);
      });
      return await readSchedules();
    }
    function latestDue(schedules: readonly WorkflowAutomationSummary[]) {
      return Math.max(
        ...schedules.map((schedule) => {
          if (!schedule.nextRunAt) {
            throw new Error("Expected the next Official occurrence");
          }
          return Date.parse(schedule.nextRunAt);
        }),
      );
    }
    async function expectSkipped(
      schedules: readonly WorkflowAutomationSummary[],
      due: number,
      launched: readonly (readonly string[])[],
    ) {
      for (const [index, schedule] of schedules.entries()) {
        expect(schedule).toMatchObject({
          enabled: true,
          official: { intendedEnabled: true },
        });
        expect(Date.parse(schedule.nextRunAt ?? "")).toBeGreaterThan(due);
        await expect(
          readLaunchedRunIds(schedule.chatThreadId),
        ).resolves.toStrictEqual(launched[index] ?? []);
      }
    }
    const day = 86_400_000;

    // An owner without a manual Run receives no occurrence, and the schedule
    // moves on without pausing their preference.
    const firstDue = latestDue(await readSchedules());
    await expectSkipped(await dispatch(firstDue), firstDue, []);
    const preference = await owned.run(() => {
      const request = app(preferenceContract).get({ headers });
      return accept<Awaited<typeof request>, 200>(request, [200]);
    });
    expect(preference.body).toMatchObject({ enabled: true, status: "enabled" });

    // A manual Run brings back the next occurrence.
    const activeDue = latestDue(await readSchedules());
    const chattedAt = activeDue - 10 * 60_000;
    await withMockNowForTest(chattedAt, () => {
      return startOwnerChat(owned);
    });
    const active = await dispatch(activeDue);
    const launched = [];
    for (const schedule of active) {
      launched.push(await readLaunchedRunIds(schedule.chatThreadId));
    }
    expect(
      launched.map((runIds) => {
        return runIds.length;
      }),
    ).toStrictEqual(
      active.map(() => {
        return 1;
      }),
    );
    // Platform-paid Official Runs spend from their own managed key.
    for (const runId of launched.flat()) {
      const { execution, sandboxHeaders } = await owned.runExecution(runId);
      await withMockNowForTest(activeDue, async () => {
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
        await owned.run(() => {
          return fixture.failChatRun(
            runId,
            sandboxHeaders,
            "Official Run key inspected",
          );
        });
        await owned.run(flushWaitUntilForTest);
      });
    }
    await withMockNowForTest(activeDue, () => {
      return failActiveOfficialRuns(owned, workflows.body, (item) => {
        return item.official !== null;
      });
    });

    // Scheduled Runs do not count as activity: one week after the manual Run,
    // fresh occurrences are skipped again.
    const lapsedDue = latestDue(await dispatch(chattedAt + 7 * day + 60_000));
    await expectSkipped(await dispatch(lapsedDue), lapsedDue, launched);
  },
);
