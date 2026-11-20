import { randomUUID } from "node:crypto";
import { array, boolean, object, string } from "zod";
import {
  feedContract,
  type SuggestionContent,
} from "@okouai/api-contracts/contracts/feed";
import { feedRoutes } from "../feed";
import {
  cronExecuteWorkflowAutomationsContract,
  cronOfficialWorkflowCatalogContract,
} from "@okouai/api-contracts/contracts/cron";
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
  type WorkflowFileEntry,
  type WorkflowAutomationSummary,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { cronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";

const context = testContext();

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

async function saveOwnedFeedback(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  title: string,
  reason: string,
  kind: "less_like_this" | "option_selected" | "dismissed" = "less_like_this",
  completedActionTitles: readonly string[] = [],
) {
  const fixture = createChatEventsFixture(context);
  const orgId = owned.actor.orgId;
  if (!orgId) {
    throw new Error("Expected a feedback owner workspace");
  }
  owned.ownsFeatureSwitches();
  await owned.run(() => {
    return updateFeatureSwitchesForUser(
      context,
      { ...owned.actor, orgId },
      { [FeatureSwitchKey.AgentSuggestion]: true },
    );
  });
  const { defaultAgentId } = await owned.run(() => {
    return fixture.bdd.readOnboardingStatus(owned.actor);
  });
  if (!defaultAgentId) {
    throw new Error("Expected the owner's default Agent");
  }
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", owned.runnerGroup);
  await owned.run(() => {
    return createRunsApi(context).registerDirectRunner(owned.runnerGroup);
  });
  const ordinary = await owned.sendChatRun(owned.actor, {
    agentId: defaultAgentId,
    model: owned.model,
    prompt: "Review the owner's current suggestions",
  });
  const { execution, sandboxHeaders } = await owned.runExecution(
    ordinary.runId,
  );
  expect(execution.appendSystemPrompt).not.toContain(
    "# Suggestions feedback context",
  );
  const api = setupApp({ context, routes: feedRoutes })(feedContract);
  const id = randomUUID();
  const feedbackId = randomUUID();
  const rationale = "Review the owner's pending decision";
  const headers = { authorization: "Bearer clerk-session" };
  return owned.run(async () => {
    const created = await accept(
      api.create({
        headers: {
          authorization: `Bearer ${okouTokenFromExecution(execution)}`,
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
    createRouteMocks(context).clerk.session(
      owned.actor.userId,
      orgId,
      owned.actor.orgRole,
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
            note: "Initial preference",
          },
        }),
        [200],
      );
      if (kind === "less_like_this") {
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
      okouTokenFromExecution(execution),
      completedActionTitles,
    );
    await fixture.failChatRun(ordinary.runId, sandboxHeaders, "Feedback saved");
    await flushWaitUntilForTest();
    return {
      expected: {
        kind,
        title,
        rationale,
        ...(kind === "less_like_this" ? { reason } : {}),
        ...(kind === "option_selected" ? { choice: "Review" } : {}),
      },
      undo: () => {
        return owned.run(async () => {
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
        });
      },
    };
  });
}

async function prepareForeignFeedback(
  definitionName: string,
  failUpload: boolean,
) {
  if (
    (definitionName !== "agent-suggestions" &&
      definitionName !== "proactive-learning") ||
    failUpload
  ) {
    return;
  }
  const foreign = await publicChatActor(context);
  await saveOwnedFeedback(
    foreign,
    "Another workspace's private decision",
    "Private foreign workspace preference",
  );
  const peer = await publicChatActor(context);
  await saveOwnedFeedback(
    peer,
    "Another member's private decision",
    "Private same-workspace preference",
  );
  return peer.actor.orgId;
}

async function prepareWorkflowFeedback(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  definitionName: string,
) {
  const learning = definitionName === "proactive-learning";
  if (definitionName !== "agent-suggestions" && !learning) {
    return [];
  }
  const { expected } = await saveOwnedFeedback(
    owned,
    "Review the launch decision",
    "A teammate owns these reviews",
    learning ? "option_selected" : "less_like_this",
  );
  return [expected];
}

function expectFeedbackContext(
  prompt: string | null | undefined,
  receivesFeedback: boolean,
  expectedFeedback: readonly Awaited<
    ReturnType<typeof saveOwnedFeedback>
  >["expected"][],
) {
  if (receivesFeedback) {
    expect(prompt).toContain("# Suggestions feedback context");
    const json = prompt?.match(/^(\{"asOf":.*\})$/mu)?.[1];
    expect(json).toBeDefined();
    const injected: unknown = JSON.parse(json ?? "null");
    expect(injected).toMatchObject({
      complete: true,
      feedback: expectedFeedback,
    });
  } else {
    expect(prompt).not.toContain("# Suggestions feedback context");
  }
}

async function expectSuggestionFeedbackLifecycle(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
  workflowId: string,
  definitionName: string,
  expectedFeedback: readonly Awaited<
    ReturnType<typeof saveOwnedFeedback>
  >["expected"][],
) {
  if (definitionName !== "agent-suggestions") {
    return;
  }
  const existing = expectedFeedback[0];
  if (!existing) {
    throw new Error("Expected the owner's saved feedback");
  }
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
  const startedAt = now();
  const feedbackSchema = object({
    complete: boolean(),
    feedback: array(
      object({
        kind: string(),
        title: string(),
        rationale: string(),
        reason: string().optional(),
        choice: string().optional(),
      }),
    ),
  });
  function readFeedback(at: number, expectedComplete = true) {
    return withMockNowForTest(at, async () => {
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
                  authorization: "Bearer official-workflow-catalog-cron-secret",
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
          expect(execution.appendSystemPrompt).toContain(
            "# Suggestions feedback context",
          );
          const json =
            execution.appendSystemPrompt?.match(/^(\{"asOf":.*\})$/mu)?.[1];
          const feedback = feedbackSchema.parse(JSON.parse(json ?? "null"));
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
          expect(feedback.complete).toBe(expectedComplete);
          return feedback.feedback;
        },
      );
    });
  }
  await withMockNowForTest(startedAt, async () => {
    const undone = await saveOwnedFeedback(
      owned,
      "Undo this preference",
      "Temporary preference",
    );
    const selected = await saveOwnedFeedback(
      owned,
      "Selected direction",
      "",
      "option_selected",
    );
    await saveOwnedFeedback(owned, "Dismissed suggestion", "", "dismissed");
    const initial = await readFeedback(startedAt);
    expect(initial).toHaveLength(3);
    expect(initial).toStrictEqual(
      expect.arrayContaining([existing, undone.expected, selected.expected]),
    );
    await undone.undo();
    const afterUndo = await readFeedback(startedAt);
    expect(afterUndo).toHaveLength(2);
    expect(afterUndo).toStrictEqual(
      expect.arrayContaining([existing, selected.expected]),
    );
    await expect(readFeedback(startedAt + 7 * day)).resolves.toStrictEqual([
      existing,
    ]);
    await expect(readFeedback(startedAt + 30 * day)).resolves.toStrictEqual([]);
    await withMockNowForTest(startedAt + 30 * day, async () => {
      const completedTitles = Array.from({ length: 101 }, (_, index) => {
        return `Completed owner task ${index + 1}`;
      });
      await saveOwnedFeedback(
        owned,
        "Retained owner preference",
        "Consider the owner's completed work",
        "less_like_this",
        completedTitles,
      );
      // The real scheduled Run must disclose omitted action facts so its
      // instructions skip maintenance instead of repeating completed work.
      const bounded = await readFeedback(now(), false);
      const completed = bounded.filter((feedback) => {
        return feedback.kind === "already_done";
      });
      expect(completed.length).toBeGreaterThan(0);
      expect(completed.length).toBeLessThan(completedTitles.length);
      for (const feedback of completed) {
        expect(completedTitles).toContain(feedback.title);
        expect(feedback).toMatchObject({
          rationale: "Review the owner's pending decision",
          reason: "Completed through another channel",
        });
      }
    });
  });
}

async function expectPublishedMorningBriefRecovery(
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
              authorization: "Bearer official-workflow-catalog-cron-secret",
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
    expect(instruction).not.toContain("--all-agents");
  }
}

function expectPublishingReference(
  files: ReadonlyMap<string, Buffer>,
  fileContents: readonly WorkflowFileEntry[] | null,
  learning: boolean,
) {
  if (learning) {
    return;
  }
  const reference = fileContents?.find((file) => {
    return file.path === "references/suggestions.md";
  });
  if (!reference) {
    throw new Error("Expected the suggestion publishing reference");
  }
  expect(files.get(reference.path)?.toString()).toBe(reference.content);
}

function expectLearningSchedule(automation: WorkflowAutomationSummary) {
  if (automation.kind !== "schedule" || automation.schedule.type !== "cron") {
    throw new Error("Expected the Learning cron schedule");
  }
  expect(automation.schedule.cronExpression.split(" ")[1]).toBe("2");
  expect(automation.schedule.timezone).toBe("Asia/Shanghai");
}

test("requires authentication to publish the Official Workflow catalog", async () => {
  mockEnv("CRON_SECRET", "official-workflow-catalog-cron-secret");
  const app = setupApp({
    context,
    routes: cronOfficialWorkflowCatalogRoutes,
  });
  const unauthorized = await accept(
    app(cronOfficialWorkflowCatalogContract).sync({}),
    [401],
  );
  expect(unauthorized.status).toBe(401);
});

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
  { kind: "suggestions", failUpload: false, suggestionsEnabled: true },
  { kind: "suggestions", failUpload: true, suggestionsEnabled: true },
  { kind: "learning", failUpload: false, suggestionsEnabled: true },
  { kind: "morning-brief", failUpload: false, suggestionsEnabled: true },
  { kind: "morning-brief", failUpload: false, suggestionsEnabled: false },
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
        ? scenario.suggestionsEnabled
          ? "internal-test-morning-brief"
          : "morning-brief"
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

test.each(scenarios)(
  "publishes the $kind catalog idempotently (upload failure: $failUpload, suggestions: $suggestionsEnabled)",
  // The Suggestions case creates 101 distinct action receipts through the real
  // API and inspects an additional scheduled Run to verify truncated context.
  { timeout: 15_000 },
  async ({
    failUpload,
    learning,
    curatesMorningBrief,
    curatesSuggestions,
    definitionName,
    heading,
    preferenceContract,
  }) => {
    mockEnv("CRON_SECRET", "official-workflow-catalog-cron-secret");
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronOfficialWorkflowCatalogRoutes,
        ...cronExecuteWorkflowAutomationsRoutes,
        ...proactiveSuggestionsRoutes,
        ...morningBriefPreferenceRoutes,
        ...workflowAutomationsRoutes,
        ...workflowsRoutes,
      ],
    });
    const peerOrgId = await prepareForeignFeedback(definitionName, failUpload);
    const fixture = createChatEventsFixture(context);
    const owned = await publicChatActor(context, {
      actor: peerOrgId ? fixture.bdd.user({ orgId: peerOrgId }) : undefined,
    });
    const s3 = installWorkflowVolumeS3Fixture(context);
    const cronHeaders = {
      authorization: "Bearer official-workflow-catalog-cron-secret",
    };
    if (failUpload) {
      context.mocks.s3.send.mockRejectedValueOnce(
        new Error("S3 publication unavailable"),
      );
      const rejected = await owned.run(() => {
        return accept(
          app(cronOfficialWorkflowCatalogContract).sync({
            headers: cronHeaders,
          }),
          [200],
        );
      });
      expect(rejected.body).toMatchObject({
        outcome: "rejected",
        releaseId: null,
        diagnostics: [{ code: "artifact-preparation-failed" }],
      });
    }
    const published = await owned.run(() => {
      return accept(
        app(cronOfficialWorkflowCatalogContract).sync({ headers: cronHeaders }),
        [200],
      );
    });
    expect(published.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });
    const repeated = await owned.run(() => {
      return accept(
        app(cronOfficialWorkflowCatalogContract).sync({ headers: cronHeaders }),
        [200],
      );
    });
    expect(repeated.body).toStrictEqual({
      outcome: "unchanged",
      releaseId: published.body.releaseId,
      diagnostics: [],
    });
    if (failUpload) {
      return;
    }
    const actor = owned.actor;
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization owner");
    }
    owned.ownsFeatureSwitches();
    await owned.run(() => {
      return updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.AgentSuggestion]: true,
        },
      );
    });
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
    const expectedFeedback = await prepareWorkflowFeedback(
      owned,
      definitionName,
    );
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
    expect(detail.body.instruction).toContain(heading);
    expectScopeGuidance(detail.body.instruction, learning);
    expect(detail.body.fileContents).toStrictEqual(expect.any(Array));
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
    if (learning) {
      expectLearningSchedule(automation);
    }
    await withMockNowForTest(
      new Date(automation.nextRunAt).getTime(),
      async () => {
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
      },
    );
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
    expectFeedbackContext(
      execution.appendSystemPrompt,
      learning || curatesSuggestions,
      expectedFeedback,
    );
    if (learning) {
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
    const files = readExecutionContentBundle(s3.objects, bundle);
    expect(files.get("SKILL.md")?.toString()).toContain(heading);
    expectScopeGuidance(files.get("SKILL.md")?.toString(), learning);
    expectPublishingReference(
      files,
      detail.body.fileContents,
      !curatesSuggestions,
    );
    await withMockNowForTest(Date.parse(automation.nextRunAt), async () => {
      await owned.run(() => {
        return fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Official Workflow inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    });
    await expectSuggestionFeedbackLifecycle(
      owned,
      workflow.id,
      definitionName,
      expectedFeedback,
    );
    if (definitionName === "morning-brief") {
      await expectPublishedMorningBriefRecovery(
        owned,
        automation.id,
        workflow.id,
      );
    }
    async function finishConcurrentProactiveWorkflows() {
      const concurrent = workflows.body.filter((item) => {
        return (
          item.id !== selectedWorkflowId && isProactiveProfileWorkflow(item)
        );
      });
      for (const item of concurrent) {
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
            actor,
            threadId,
          );
        });
        for (const event of events) {
          if (event.eventType !== "input.prompt" || !event.runId) {
            continue;
          }
          const runId = event.runId;
          const run = await owned.run(() => {
            return createRunsApi(context).readRun(actor, runId);
          });
          if (run.status !== "pending" && run.status !== "running") {
            continue;
          }
          const { sandboxHeaders } = await owned.runExecution(runId);
          await owned.run(() => {
            return fixture.failChatRun(
              runId,
              sandboxHeaders,
              "Concurrent proactive Run inspected",
            );
          });
          await owned.run(flushWaitUntilForTest);
        }
      }
    }
    await finishConcurrentProactiveWorkflows();
    await expectSharedProactiveSchedules(owned, workflows.body, false);
  },
);
