import { randomUUID } from "node:crypto";

import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEvent,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import {
  clearMockedEnv,
  env,
  mockEnv,
  mockOptionalEnv,
} from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { projectRoutes } from "../projects";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { createRouteMocks } from "./helpers/route-test";

describe("project reference admission through chat send", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  const routeMocks = createRouteMocks(context);

  const projectsClient = setupAppWithRoutes({
    context,
    routes: projectRoutes,
  })(projectsContract);
  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatThreadsClient = setupAppWithRoutes({
    context,
    routes: [...chatThreadCreateRoutes, ...chatThreadRoutes],
  })(chatThreadsContract);
  const chatThreadEventsClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadEventsContract);
  const clerkWebhookClient = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const runnersHeartbeatClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const agentCompleteClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const runsCancelClient = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const runsByIdClient = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);

  function sessionHeaders(actor: ApiTestUser): {
    readonly authorization: string;
  } {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function nextProjectEventId(): string {
    return createProjectOperationId(now(), randomUUID());
  }

  async function provisionWorkspace(actor: ApiTestUser): Promise<void> {
    if (!actor.orgId) {
      throw new Error("Expected actor to belong to an organization");
    }
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "organization.created",
      data: {
        id: actor.orgId,
        created_by: actor.userId,
        created_at: now(),
      },
    });
    await accept(clerkWebhookClient.post({ body: "{}" }), [200]);
    await flushWaitUntilForTest();
  }

  async function createProject(actor: ApiTestUser, name: string) {
    const id = nextProjectEventId();
    const response = await accept(
      projectsClient.create({
        headers: sessionHeaders(actor),
        body: { id, eventId: id, name },
      }),
      [201],
    );
    return response.body;
  }

  async function renameProject(
    actor: ApiTestUser,
    projectId: string,
    name: string,
  ) {
    const response = await accept(
      projectsClient.update({
        headers: sessionHeaders(actor),
        params: { id: projectId },
        body: { eventId: nextProjectEventId(), name },
      }),
      [200],
    );
    return response.body;
  }

  async function deleteProject(actor: ApiTestUser, projectId: string) {
    await accept(
      projectsClient.delete({
        headers: sessionHeaders(actor),
        params: { id: projectId },
        body: { eventId: nextProjectEventId() },
      }),
      [204],
    );
  }

  async function createThread(
    actor: ApiTestUser,
    options: { readonly projectId?: string } = {},
  ) {
    const response = await accept(
      chatThreadsClient.create({
        headers: sessionHeaders(actor),
        body: {
          model: null,
          ...(options.projectId === undefined
            ? {}
            : { projectId: options.projectId }),
        },
      }),
      [201],
    );
    return response.body;
  }

  async function readThreadEvents(
    actor: ApiTestUser,
    threadId: string,
  ): Promise<readonly ChatEvent[]> {
    const response = await accept(
      chatThreadEventsClient.rows({
        headers: sessionHeaders(actor),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    return projectChatEventRows(response.body.rows);
  }

  function registerRunCleanup(actor: ApiTestUser) {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const tracked = new Map<string, string | undefined>();
    let runnerGroup: string | undefined;

    onTestFinished(async () => {
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
      if (runnerGroup !== undefined) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await settleIncludingAbort(flushWaitUntilForTest);

      if (runnerGroup !== undefined) {
        for (const envelope of runs.receivedDispatches(runnerGroup)) {
          const { runId, sandboxToken } = envelope.executionContext;
          if (!tracked.has(runId)) {
            tracked.set(runId, sandboxToken);
          }
        }
      }

      for (const [runId, sandboxToken] of tracked) {
        const current = await accept(
          runsByIdClient.getById({
            headers: sessionHeaders(actor),
            params: { id: runId },
          }),
          [200, 404],
        );
        if (current.status !== 200) {
          continue;
        }
        const status = current.body.status;
        if (["queued", "pending", "running"].includes(status)) {
          await accept(
            runsCancelClient.cancel({
              headers: sessionHeaders(actor),
              params: { id: runId },
            }),
            [200],
          );
        }
        if (
          sandboxToken &&
          !["completed", "failed", "timeout"].includes(status)
        ) {
          await accept(
            agentCompleteClient.complete({
              headers: { authorization: `Bearer ${sandboxToken}` },
              body: { runId, exitCode: 1, error: "Run cancelled" },
            }),
            [200],
          );
        }
      }
      await settleIncludingAbort(flushWaitUntilForTest);
    });

    return {
      setRunnerGroup(group: string) {
        runnerGroup = group;
      },
      track(runId: string, sandboxToken?: string) {
        tracked.set(runId, sandboxToken);
      },
    };
  }

  function prepareRunEnvironment(): void {
    chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    chatCallbacks.disableVapid();
  }

  function completionCliAgentType(
    cliAgentType: string,
  ): "claude-code" | "codex" | "pi" {
    if (
      cliAgentType === "claude-code" ||
      cliAgentType === "codex" ||
      cliAgentType === "pi"
    ) {
      return cliAgentType;
    }
    throw new Error(`Unexpected cliAgentType: ${cliAgentType}`);
  }

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    const warmupId = randomUUID();
    await Promise.all([
      accept(projectsClient.list({ headers: {} }), [401]),
      accept(
        chatEventsClient.send({
          headers: {},
          body: {
            prompt: "warmup",
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
            hasTextContent: true,
          },
        }),
        [401],
      ),
      accept(
        chatThreadsClient.create({ headers: {}, body: { model: null } }),
        [401],
      ),
      accept(
        chatThreadEventsClient.rows({
          headers: {},
          params: { threadId: warmupId },
          query: { sinceSeqId: 0, limit: 1 },
        }),
        [401],
      ),
      accept(clerkWebhookClient.post({ body: "{}" }), [401]),
      accept(
        runnersHeartbeatClient.heartbeat({
          headers: {},
          body: {
            runnerId: warmupId,
            group: "vm0/warmup",
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 2,
            totalMemoryMb: 4096,
            maxConcurrent: 1,
            allocatedVcpu: 0,
            allocatedMemoryMb: 0,
            runningCount: 0,
            admittableProfiles: ["vm0/default"],
            heldSandboxStates: [],
            heldHomeStates: [],
            activeReuseProducers: [],
            mode: "running",
          },
        }),
        [401],
      ),
      accept(
        agentCompleteClient.complete({
          headers: {},
          body: { runId: warmupId, exitCode: 0 },
        }),
        [401],
      ),
      accept(
        runsCancelClient.cancel({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        runsByIdClient.getById({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
    ]);
    clearMockedEnv();
  });

  it("project-reference-validation-009 rejects a batch containing a foreign organization project without leaking its existence", async () => {
    const member = bdd.user();
    const sameUserOtherOrg = bdd.user({
      userId: member.userId,
      orgId: `org_${randomUUID()}`,
    });

    const ownProject = await createProject(member, "Primary org project");
    const foreignOrgProject = await createProject(
      sameUserOtherOrg,
      "Other org project",
    );

    const response = await accept(
      chatEventsClient.send({
        headers: sessionHeaders(member),
        body: {
          model: null,
          prompt: "Compare primary and other org projects",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "project",
                projectId: ownProject.id,
                nameSnapshot: "Primary org project",
              },
              { type: "text", text: " and " },
              {
                type: "project",
                projectId: foreignOrgProject.id,
                nameSnapshot: "Other org project",
              },
            ],
          },
          hasTextContent: true,
        },
      }),
      [404],
    );

    expect(response.status).toBe(404);
    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message: "Project or conversation not found",
      },
    });
  });

  it(
    "project-reference-validation-005 uses current Project names and missing references when a queued input launches",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);
      const actor = bdd.user();
      prepareRunEnvironment();
      const cleanup = registerRunCleanup(actor);

      const [runnerGroup, , projects] = await Promise.all([
        runs.configureRunnerGroup(),
        provisionWorkspace(actor),
        (async () => {
          const bound = await createProject(actor, "Bound before pick");
          const deleted = await createProject(actor, "Deleted before pick");
          const linked = await createProject(actor, "Linked before pick");
          return { bound, deleted, linked };
        })(),
      ]);
      cleanup.setRunnerGroup(runnerGroup);

      const thread = await createThread(actor, {
        projectId: projects.bound.id,
      });

      await accept(
        chatEventsClient.send({
          headers: sessionHeaders(actor),
          body: {
            threadId: thread.id,
            clientEventId: randomUUID(),
            prompt: "Hold the conversation busy",
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "Hold the conversation busy" }],
            },
            hasTextContent: true,
          },
        }),
        [201],
      );

      const busyExecution = await runs.nextReceivedExecution(runnerGroup);
      cleanup.track(busyExecution.runId, busyExecution.sandboxToken);

      const linkedUpperId = projects.linked.id.toUpperCase();
      const queuedUserMessage: UserMessageInputDocument = {
        version: 1,
        parts: [
          { type: "text", text: "Check " },
          {
            type: "project",
            projectId: projects.deleted.id,
            nameSnapshot: "Deleted link",
          },
          {
            type: "feedback",
            quote: "Quoted context",
            note: [
              { type: "text", text: "Also review " },
              {
                type: "project",
                projectId: linkedUpperId,
                nameSnapshot: "Linked before pick",
              },
            ],
          },
        ],
      };

      await accept(
        chatEventsClient.send({
          headers: sessionHeaders(actor),
          body: {
            threadId: thread.id,
            clientEventId: randomUUID(),
            prompt: "Check Deleted link",
            userMessage: queuedUserMessage,
            hasTextContent: true,
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      expect(runs.unobservedDispatches(runnerGroup)).toStrictEqual([]);

      await renameProject(actor, projects.bound.id, "Bound at pick");
      await renameProject(actor, projects.linked.id, "Linked at pick");
      await deleteProject(actor, projects.deleted.id);

      await accept(
        agentCompleteClient.complete({
          headers: { authorization: `Bearer ${busyExecution.sandboxToken}` },
          body: {
            runId: busyExecution.runId,
            exitCode: 0,
            completion: {
              cliAgentType: completionCliAgentType(busyExecution.cliAgentType),
              cliAgentSessionId: thread.id,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );

      const promotedExecution = await runs.nextReceivedExecution(runnerGroup);
      cleanup.track(promotedExecution.runId, promotedExecution.sandboxToken);

      expect(promotedExecution.appendSystemPrompt).toContain(
        `Current Project: "Bound at pick" (PROJECT_ID=${projects.bound.id})`,
      );
      expect(promotedExecution.appendSystemPrompt).toContain(
        `current name="Linked at pick"`,
      );
      expect(promotedExecution.appendSystemPrompt).toContain(
        `Mentioned Project "Deleted link" (${projects.deleted.id}) is unavailable.`,
      );
    },
  );

  it(
    "project-reference-validation-001 admits ordinary chat messages without Project references",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      prepareRunEnvironment();
      const cleanup = registerRunCleanup(actor);

      const [runnerGroup, , project] = await Promise.all([
        runs.configureRunnerGroup(),
        provisionWorkspace(actor),
        createProject(actor, "The conversation's Project"),
      ]);
      cleanup.setRunnerGroup(runnerGroup);

      const thread = await createThread(actor, { projectId: project.id });

      await accept(
        chatEventsClient.send({
          headers: sessionHeaders(actor),
          body: {
            threadId: thread.id,
            clientEventId: randomUUID(),
            prompt: "No project references",
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "No project references" }],
            },
            hasTextContent: true,
          },
        }),
        [201],
      );

      const execution = await runs.nextReceivedExecution(runnerGroup);
      cleanup.track(execution.runId, execution.sandboxToken);

      expect(execution.prompt).toBe("No project references");
      expect(execution.appendSystemPrompt).toContain(
        `Current Project: "The conversation's Project" (PROJECT_ID=${project.id})`,
      );
    },
  );

  it(
    "project-reference-validation-002 preserves multiple, repeated and mixed-case references in ordinary parts and feedback notes",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      prepareRunEnvironment();
      const cleanup = registerRunCleanup(actor);

      const [runnerGroup, , projects] = await Promise.all([
        runs.configureRunnerGroup(),
        provisionWorkspace(actor),
        (async () => {
          const research = await createProject(actor, "Research");
          const launch = await createProject(actor, "Launch");
          return { research, launch };
        })(),
      ]);
      cleanup.setRunnerGroup(runnerGroup);

      const researchUpperId = projects.research.id.toUpperCase();
      const launchUpperId = projects.launch.id.toUpperCase();
      const structuredMessage: UserMessageInputDocument = {
        version: 1,
        parts: [
          { type: "text", text: "Compare " },
          {
            type: "project",
            projectId: projects.research.id,
            nameSnapshot: "Research",
          },
          { type: "text", text: " with " },
          {
            type: "project",
            projectId: researchUpperId,
            nameSnapshot: "Research",
          },
          { type: "text", text: " and " },
          {
            type: "project",
            projectId: launchUpperId,
            nameSnapshot: "Launch",
          },
          {
            type: "feedback",
            quote: "Prior summary",
            note: [
              { type: "text", text: "Keep " },
              {
                type: "project",
                projectId: projects.launch.id,
                nameSnapshot: "Launch",
              },
              { type: "text", text: " aligned with " },
              {
                type: "project",
                projectId: researchUpperId,
                nameSnapshot: "Research",
              },
            ],
          },
        ],
      };

      const clientEventId = randomUUID();
      const sent = await accept(
        chatEventsClient.send({
          headers: sessionHeaders(actor),
          body: {
            clientEventId,
            model: null,
            prompt: "Compare Research and Launch",
            userMessage: structuredMessage,
            hasTextContent: true,
          },
        }),
        [201],
      );

      const execution = await runs.nextReceivedExecution(runnerGroup);
      cleanup.track(execution.runId, execution.sandboxToken);

      const events = await readThreadEvents(actor, sent.body.threadId);
      const storedInput = events.find((event) => {
        return event.eventType === "input.prompt" && event.id === clientEventId;
      });
      expect(
        storedInput?.eventType === "input.prompt"
          ? storedInput.userMessage
          : undefined,
      ).toStrictEqual(structuredMessage);

      expect(execution.prompt).toBe(
        [
          `Compare [Research](/projects/${projects.research.id}) with [Research](/projects/${researchUpperId}) and [Launch](/projects/${launchUpperId})`,
          `The user quoted this part of your reply:\n\n> Prior summary\n\nKeep [Launch](/projects/${projects.launch.id}) aligned with [Research](/projects/${researchUpperId})`,
        ].join("\n\n"),
      );
    },
  );

  it("project-reference-validation-006 rejects a mixed valid/missing batch from ordinary without publishing an input", async () => {
    const actor = bdd.user();
    const [, ownedProject] = await Promise.all([
      provisionWorkspace(actor),
      createProject(actor, "Owned project"),
    ]);

    const thread = await createThread(actor);
    const eventsBefore = await readThreadEvents(actor, thread.id);

    const response = await accept(
      chatEventsClient.send({
        headers: sessionHeaders(actor),
        body: {
          threadId: thread.id,
          prompt: "Check both projects",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "project",
                projectId: ownedProject.id,
                nameSnapshot: "Owned project",
              },
              { type: "text", text: " and " },
              {
                type: "project",
                projectId: randomUUID(),
                nameSnapshot: "Missing project",
              },
            ],
          },
          hasTextContent: true,
        },
      }),
      [404],
    );

    expect(response.status).toBe(404);
    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message: "Project or conversation not found",
      },
    });

    await flushWaitUntilForTest();
    const eventsAfter = await readThreadEvents(actor, thread.id);
    expect(eventsAfter).toStrictEqual(eventsBefore);
  });

  it("project-reference-validation-008 rejects a batch containing a foreign user project without leaking its existence", async () => {
    const member = bdd.user();
    const sameOrgPeer = bdd.user({
      orgId: member.orgId,
      orgRole: "org:member",
    });

    const ownProject = await createProject(member, "Member project");
    const foreignUserProject = await createProject(sameOrgPeer, "Peer project");

    const response = await accept(
      chatEventsClient.send({
        headers: sessionHeaders(member),
        body: {
          model: null,
          prompt: "Compare owned and peer projects",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "project",
                projectId: ownProject.id,
                nameSnapshot: "Member project",
              },
              { type: "text", text: " and " },
              {
                type: "project",
                projectId: foreignUserProject.id,
                nameSnapshot: "Peer project",
              },
            ],
          },
          hasTextContent: true,
        },
      }),
      [404],
    );

    expect(response.status).toBe(404);
    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message: "Project or conversation not found",
      },
    });
  });
});
