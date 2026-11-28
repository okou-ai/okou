import { randomUUID } from "node:crypto";

import type { ExecutionContext } from "@okouai/api-contracts/contracts/runners";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { holdDownloadSigning } from "./helpers/hold-download-signing";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const runsApi = createRunsApi(context);
const workflowsBdd = createWorkflowsBddApi(context);
const chatApi = createChatFilesBddApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });

const appFor = setupApp({
  context,
  routes: [...workflowsRoutes, ...workflowAutomationsRoutes],
});
const workflowsApi = appFor(workflowsCollectionContract);
const workflowDetailApi = appFor(workflowsDetailContract);
const workflowVisibilityApi = appFor(workflowVisibilityContract);
const automationsApi = appFor(workflowAutomationsContract);

function asUser(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return AUTH_HEADERS;
}

function slug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function installExecutionBoundaries() {
  const storage = installWorkflowVolumeS3Fixture(context);
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  return storage;
}

function skillNames(execution: ExecutionContext): readonly string[] {
  return execution.startupInputs.contentBundles.skills.map((skill) => {
    return skill.name;
  });
}

function readSkillMd(
  objects: ReadonlyMap<string, Buffer>,
  execution: ExecutionContext,
  skillName: string,
): string {
  const entry = execution.startupInputs.contentBundles.skills.find((skill) => {
    return skill.name === skillName;
  });
  if (!entry) {
    throw new Error(`Expected mounted skill ${skillName}`);
  }
  const files = readExecutionContentBundle(objects, entry.bundle);
  const content = files.get("SKILL.md")?.toString("utf8");
  if (content === undefined) {
    throw new Error(`Expected SKILL.md in bundle ${skillName}`);
  }
  return content;
}

function readInstructionsMd(
  objects: ReadonlyMap<string, Buffer>,
  execution: ExecutionContext,
): string {
  const instructionsRef = execution.startupInputs.contentBundles.instructions;
  if (!instructionsRef) {
    throw new Error("Expected personal instructions bundle");
  }
  const files = readExecutionContentBundle(objects, instructionsRef);
  const content = files.get("instructions.md")?.toString("utf8");
  if (content === undefined) {
    throw new Error("Expected instructions.md in instructions bundle");
  }
  return content;
}

async function completeClaudeRun(runId: string): Promise<void> {
  const execution = await runsApi.executionInput(runId);
  await webhooksApi.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `wf-dist-${runId}`,
        cliAgentSessionHistoryDisposition: "native_only",
      },
    },
    { authorization: `Bearer ${execution.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
}

function registerRunCleanup(
  actors: () => readonly ApiTestUser[],
  runnerGroup: () => string,
) {
  onTestFinished(async () => {
    await flushWaitUntilForTest();
    for (let round = 0; round < 5; round++) {
      const dispatches = runsApi.receivedDispatches(runnerGroup());
      let cleanedAny = false;
      for (const envelope of dispatches) {
        const { runId, sandboxToken } = envelope.executionContext;
        for (const actor of actors()) {
          const read = await runsApi.requestReadRun(actor, runId, [200, 404]);
          if (read.status !== 200) {
            continue;
          }
          if (
            read.body.status === "pending" ||
            read.body.status === "running"
          ) {
            await runsApi.requestCancelRun(actor, runId, [200]);
            await webhooksApi.requestAgentComplete(
              { runId, exitCode: 1, error: "Cancelled by test cleanup" },
              { authorization: `Bearer ${sandboxToken}` },
              [200],
            );
            await flushWaitUntilForTest();
            cleanedAny = true;
          }
          break;
        }
      }
      if (!cleanedAny) {
        break;
      }
    }
  });
}

describe("workflow execution distribution", () => {
  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      const warmupUser = bdd.user();
      await runsApi.grantProEntitlement(warmupUser);
      await runsApi.configureRunnerGroup();
      await Promise.all([
        accept(
          workflowsApi.create({
            headers: {},
            body: { name: "warmup-dist", visibility: "private" },
          }),
          [401],
        ),
        accept(
          automationsApi.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
      ]);
    });
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it(
    "workflow-execution-distribution-006 keeps the accepted Workflow after sharing withdrawal during startup",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor: admin } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      if (!admin.orgId) {
        throw new Error("Expected org-scoped admin");
      }
      const author = bdd.user({ orgId: admin.orgId, orgRole: "org:admin" });
      const storage = installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      registerRunCleanup(
        () => {
          return [admin];
        },
        () => {
          return runnerGroup;
        },
      );

      const workflowName = slug("demote-startup");
      const workflowId = await workflowsBdd.createWorkflow(author, {
        name: workflowName,
        visibility: "public",
        instruction: "Original shared body",
      });

      const held = holdDownloadSigning(context);
      const firstClientEventId = randomUUID();
      const sent = await chatApi.requestSendEvent(
        admin,
        {
          prompt: "Run while sharing is withdrawn",
          clientEventId: firstClientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected prompt to be accepted");
      }
      const threadId = sent.body.threadId;
      await held.waitForPending();

      await accept(
        workflowVisibilityApi.demote({
          headers: asUser(author),
          params: { workflowId },
          body: undefined,
        }),
        [200],
      );
      held.release();
      await flushWaitUntilForTest();

      asUser(admin);
      const firstEvents = await workflowsBdd.readThreadEvents(threadId);
      const firstRunId = firstEvents.find((event) => {
        return (
          event.revokesEventId === firstClientEventId &&
          event.runId !== undefined
        );
      })?.runId;
      if (!firstRunId) {
        throw new Error("Expected first Run to be admitted");
      }

      const firstExec = await runsApi.executionInput(firstRunId);
      expect(skillNames(firstExec)).toContain(workflowName);
      expect(readSkillMd(storage.objects, firstExec, workflowName)).toContain(
        "Original shared body",
      );

      await completeClaudeRun(firstRunId);

      const secondRun = await runsApi.createThreadRun(admin, {
        threadId,
        prompt: "Follow-up after sharing withdrawal",
      });
      const secondExec = await runsApi.executionInput(secondRun.runId);
      expect(skillNames(secondExec)).not.toContain(workflowName);
    },
  );

  it(
    "workflow-execution-distribution-007 keeps the accepted Workflow after rename during startup",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor: author } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      if (!author.orgId) {
        throw new Error("Expected org-scoped author");
      }
      const viewer = bdd.user({ orgId: author.orgId, orgRole: "org:member" });
      await bdd.completeOnboarding(viewer);
      await runsApi.ensurePersonalSubscriptionModel(viewer);
      const storage = installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      registerRunCleanup(
        () => {
          return [viewer];
        },
        () => {
          return runnerGroup;
        },
      );

      await bdd.updatePersonalInstructions(
        viewer,
        "Accepted personal Instructions",
      );
      const originalName = slug("rename-orig");
      const renamedName = slug("rename-next");
      const workflowId = await workflowsBdd.createWorkflow(author, {
        name: originalName,
        visibility: "public",
        instruction: "Original Workflow instructions",
      });

      const held = holdDownloadSigning(context);
      const firstClientEventId = randomUUID();
      const sent = await chatApi.requestSendEvent(
        viewer,
        {
          prompt: "Run while workflow is renamed",
          clientEventId: firstClientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected prompt to be accepted");
      }
      const threadId = sent.body.threadId;
      await held.waitForPending();

      await accept(
        workflowDetailApi.update({
          headers: asUser(author),
          params: { workflowId },
          body: {
            name: renamedName,
            instruction: "Updated Workflow instructions",
          },
        }),
        [200],
      );
      await bdd.updatePersonalInstructions(
        viewer,
        "Updated personal Instructions",
      );
      held.release();
      await flushWaitUntilForTest();

      const firstEvents = await workflowsBdd.readThreadEvents(threadId);
      const firstRunId = firstEvents.find((event) => {
        return (
          event.revokesEventId === firstClientEventId &&
          event.runId !== undefined
        );
      })?.runId;
      if (!firstRunId) {
        throw new Error("Expected admitted first Run");
      }

      const firstExec = await runsApi.executionInput(firstRunId);
      expect(skillNames(firstExec)).toContain(originalName);
      expect(readSkillMd(storage.objects, firstExec, originalName)).toContain(
        "Original Workflow instructions",
      );
      expect(readInstructionsMd(storage.objects, firstExec)).toBe(
        "Accepted personal Instructions",
      );

      await completeClaudeRun(firstRunId);

      const secondRun = await runsApi.createThreadRun(viewer, {
        threadId,
        prompt: "Follow-up after rename",
      });
      const secondExec = await runsApi.executionInput(secondRun.runId);
      expect(skillNames(secondExec)).not.toContain(originalName);
      expect(skillNames(secondExec)).toContain(renamedName);
      expect(readSkillMd(storage.objects, secondExec, renamedName)).toContain(
        "Updated Workflow instructions",
      );
      expect(readInstructionsMd(storage.objects, secondExec)).toBe(
        "Updated personal Instructions",
      );
    },
  );

  it(
    "workflow-execution-distribution-009 invokes the caller's Private Workflow when Public and foreign Private Workflows share its slug",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor: admin } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      if (!admin.orgId) {
        throw new Error("Expected org-scoped admin");
      }
      const peer = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
      const storage = installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      registerRunCleanup(
        () => {
          return [admin];
        },
        () => {
          return runnerGroup;
        },
      );

      const sharedSlug = slug("same-slug");
      await workflowsBdd.createWorkflow(admin, {
        name: sharedSlug,
        visibility: "public",
        instruction: "public body",
      });
      await workflowsBdd.createWorkflow(admin, {
        name: sharedSlug,
        visibility: "private",
        instruction: "private body",
      });
      await workflowsBdd.createWorkflow(peer, {
        name: sharedSlug,
        visibility: "private",
        instruction: "foreign private body",
      });

      const run = await runsApi.createThreadRun(admin, {
        prompt: `/${sharedSlug} summarize today`,
      });
      const execution = await runsApi.executionInput(run.runId);
      const skillMd = readSkillMd(storage.objects, execution, sharedSlug);
      expect(skillMd).toContain("private body");
      expect(skillMd).not.toContain("public body");
      expect(skillMd).not.toContain("foreign private body");
    },
  );

  it(
    "workflow-execution-distribution-010 an ordinary Automation invokes the name of its bound Workflow package",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor: author } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      if (!author.orgId) {
        throw new Error("Expected org-scoped author");
      }
      const member = bdd.user({ orgId: author.orgId, orgRole: "org:member" });
      await bdd.completeOnboarding(member);
      await runsApi.ensurePersonalSubscriptionModel(member);
      const storage = installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      registerRunCleanup(
        () => {
          return [member];
        },
        () => {
          return runnerGroup;
        },
      );

      const sharedSlug = slug("bound-auto");
      const sharedWorkflowId = await workflowsBdd.createWorkflow(author, {
        name: sharedSlug,
        visibility: "public",
        instruction: "Shared Automation workflow",
      });
      const shadowingPrivateId = await workflowsBdd.createWorkflow(member, {
        name: sharedSlug,
        visibility: "private",
        instruction: "Private shadowing workflow",
      });

      const automation = await accept(
        automationsApi.create({
          headers: asUser(member),
          params: { workflowId: sharedWorkflowId },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 3600 },
          },
        }),
        [201],
      );

      const firstTrigger = await accept(
        automationsApi.run({
          headers: asUser(member),
          params: { id: automation.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const threadId = firstTrigger.body.chatThreadId;

      const eventsAfterShadowed = await workflowsBdd.readThreadEvents(threadId);
      expect(eventsAfterShadowed).toContainEqual(
        expect.objectContaining({
          eventType: "input.rejected",
          error: "conflict",
        }),
      );
      expect(eventsAfterShadowed).toContainEqual(
        expect.objectContaining({
          eventType: "output.error",
          content: "The Automation's Workflow package is unavailable",
        }),
      );

      await accept(
        workflowDetailApi.update({
          headers: asUser(member),
          params: { workflowId: shadowingPrivateId },
          body: { name: slug("unshadowed-priv") },
        }),
        [200],
      );

      const secondTrigger = await accept(
        automationsApi.run({
          headers: asUser(member),
          params: { id: automation.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      expect(secondTrigger.body.chatThreadId).toBe(threadId);

      const eventsAfterSecond = await workflowsBdd.readThreadEvents(threadId);
      const firstRunId = eventsAfterSecond.find((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined;
      })?.runId;
      if (!firstRunId) {
        throw new Error("Expected second trigger to launch first Run");
      }
      const firstExec = await runsApi.executionInput(firstRunId);
      expect(firstExec.cliAgentType).toBe("claude-code");
      expect(skillNames(firstExec)).toContain(sharedSlug);
      expect(readSkillMd(storage.objects, firstExec, sharedSlug)).toContain(
        "Shared Automation workflow",
      );

      const thirdTrigger = await accept(
        automationsApi.run({
          headers: asUser(member),
          params: { id: automation.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      expect(thirdTrigger.body.chatThreadId).toBe(threadId);

      const renamedSlug = slug("bound-renamed");
      await accept(
        workflowDetailApi.update({
          headers: asUser(author),
          params: { workflowId: sharedWorkflowId },
          body: {
            name: renamedSlug,
            instruction: "Renamed Automation Workflow",
          },
        }),
        [200],
      );

      await completeClaudeRun(firstRunId);

      asUser(member);
      const eventsAfterThird = await workflowsBdd.readThreadEvents(threadId);
      const launchedRunIds = eventsAfterThird.flatMap((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined
          ? [event.runId]
          : [];
      });
      const secondRunId = launchedRunIds.find((id) => {
        return id !== firstRunId;
      });
      if (!secondRunId) {
        throw new Error("Expected queued third trigger to launch second Run");
      }
      expect(secondRunId).not.toBe(firstRunId);

      const secondExec = await runsApi.executionInput(secondRunId);
      expect(secondExec.cliAgentType).toBe("claude-code");
      expect(secondExec.prompt.startsWith(`/${renamedSlug}`)).toBeTruthy();
      expect(skillNames(secondExec)).toContain(renamedSlug);
      expect(readSkillMd(storage.objects, secondExec, renamedSlug)).toContain(
        "Renamed Automation Workflow",
      );
    },
  );

  it(
    "workflow-execution-distribution-011 runs a queued explicit invocation without its deleted Workflow",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor: admin } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      registerRunCleanup(
        () => {
          return [admin];
        },
        () => {
          return runnerGroup;
        },
      );

      const workflowName = slug("delete-queued");
      const workflowId = await workflowsBdd.createWorkflow(admin, {
        name: workflowName,
        visibility: "private",
        instruction: "Will be deleted while queued",
      });

      const blocker = await runsApi.createThreadRun(admin, {
        prompt: "Hold thread before deleting workflow",
      });
      const queuedEventId = randomUUID();
      await chatApi.requestSendEvent(
        admin,
        {
          threadId: blocker.threadId,
          prompt: `/${workflowName} run anyway`,
          clientEventId: queuedEventId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      await accept(
        workflowDetailApi.delete({
          headers: asUser(admin),
          params: { workflowId },
          body: undefined,
        }),
        [204],
      );

      await completeClaudeRun(blocker.runId);

      const events = await workflowsBdd.readThreadEvents(blocker.threadId);
      const promotedRunId = events.find((event) => {
        return (
          event.revokesEventId === queuedEventId && event.runId !== undefined
        );
      })?.runId;
      if (!promotedRunId) {
        throw new Error("Expected queued explicit invocation to launch");
      }

      await runsApi.heartbeatRunner(runnerGroup);
      const execution = await runsApi.executionInput(promotedRunId);
      expect([...skillNames(execution)].sort()).toStrictEqual(
        [...BUILT_IN_SKILLS].sort(),
      );
    },
  );
});
