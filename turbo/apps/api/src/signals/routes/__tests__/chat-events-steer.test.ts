import { randomUUID } from "node:crypto";

import {
  chatEventsContract,
  chatThreadEventsContract,
  type GenerationTemplateRequest,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
  STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
} from "@okouai/api-contracts/contracts/runners";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { findDocumentTemplateItem } from "@okouai/core/document-template-items";
import { findWebsiteTemplatePackage } from "@okouai/core/resource-registry";
import { websiteImageInstructions } from "@okouai/core/website-generation-instructions";
import { findWebsiteTemplateItem } from "@okouai/core/website-template-items";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { cliAuthRoutes } from "../cli-auth";
import { paidToolsRoutes } from "../paid-tools";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { createRouteMocks } from "./helpers/route-test";

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const WARMUP_UUID = "00000000-0000-4000-8000-000000000001";

const BLACK_SLABS_TEMPLATE_ID = "website-template:black-slabs" as const;
const SIMPLE_INVOICE_TEMPLATE_ID = "document-template:simple-invoice" as const;
const SIMPLE_INVOICE_PINNED_SOURCE_URL =
  "https://raw.githubusercontent.com/sparksuite/simple-html-invoice-template/7d74fe34c862b7712f1a23a3f12147a4a8bd53e1/invoice.html";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);

const app = setupApp({
  context,
  routes: [
    ...chatEventsRoutes,
    ...chatThreadRoutes,
    ...cliAuthRoutes,
    ...paidToolsRoutes,
    ...runnersRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksClerkRoutes,
  ],
});

const chatEventsApi = app(chatEventsContract);
const chatThreadEventsApi = app(chatThreadEventsContract);
const cliDeviceApi = app(cliAuthDeviceContract);
const cliApproveApi = app(cliAuthApproveContract);
const cliTokenApi = app(cliAuthTokenContract);
const paidToolsApi = app(paidToolsContract);
const runnerHeartbeatApi = app(runnersHeartbeatContract);
const runnersSteerApi = app(runnersSteerContract);
const runsByIdApi = app(runsByIdContract);
const runsCancelApi = app(runsCancelContract);
const clerkWebhookApi = app(webhookClerkContract);

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(new Error("warmup"));
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
  await Promise.all([
    accept(
      chatEventsApi.send({
        headers: {},
        body: {
          prompt: "warmup",
          hasTextContent: true,
          clientEventId: WARMUP_UUID,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "warmup" }],
          },
        },
      }),
      [401],
    ),
    accept(
      chatThreadEventsApi.rows({
        headers: {},
        params: { threadId: WARMUP_UUID },
        query: { sinceSeqId: 0 },
      }),
      [401],
    ),
    accept(
      cliApproveApi.approve({
        headers: {},
        body: { device_code: "ABCD-EFGH" },
      }),
      [401],
    ),
    accept(
      cliTokenApi.exchange({
        body: { device_code: "" },
      }),
      [400],
    ),
    accept(
      paidToolsApi.update({
        headers: {},
        params: { toolId: "image-generation" },
        body: { disabled: false },
      }),
      [401],
    ),
    accept(
      runnerHeartbeatApi.heartbeat({
        headers: {},
        body: {
          runnerId: WARMUP_UUID,
          group: "vm0/warmup",
          snapshotGeneration: 1,
          snapshotSequence: 1,
          totalVcpu: 1,
          totalMemoryMb: 1024,
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
      runnersSteerApi.next({
        headers: {},
        params: { runId: WARMUP_UUID },
      }),
      [401],
    ),
    accept(
      runnersSteerApi.steered({
        headers: {},
        params: { runId: WARMUP_UUID, eventId: WARMUP_UUID },
        body: {},
      }),
      [401],
    ),
    accept(
      runsByIdApi.getById({
        headers: {},
        params: { id: WARMUP_UUID },
      }),
      [401],
    ),
    accept(
      runsCancelApi.cancel({
        headers: {},
        params: { id: WARMUP_UUID },
      }),
      [401],
    ),
    accept(
      clerkWebhookApi.post({
        body: "{}",
        extraHeaders: {},
      }),
      [401],
    ),
  ]);
});

function signIn(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return SESSION_HEADERS;
}

function mockClerkOrgMembership(actor: ApiTestUser): void {
  if (!actor.orgId) {
    return;
  }
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `membership-${actor.userId}-${actor.orgId}`,
          createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    },
  );
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function templateUserMessage(
  prompt: string,
  titleSnapshot: string,
  template: GenerationTemplateRequest,
) {
  return {
    version: 1 as const,
    parts: [
      { type: "text" as const, text: prompt },
      { type: "text" as const, text: "\n\n" },
      { type: "template" as const, titleSnapshot, template },
    ],
  };
}

interface TrackedRun {
  readonly runId: string;
  readonly sandboxToken: string;
  completed: boolean;
}

function prepareRunEnvironment() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor with an organization");
  }
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);

  const trackedRuns: TrackedRun[] = [];
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");

  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: { id: actor.orgId, created_by: actor.userId, created_at: now() },
  });

  const runnerGroupPromise = runs.configureRunnerGroup();
  const orgCreatedPromise = accept(
    clerkWebhookApi.post({ body: "{}", extraHeaders: {} }),
    [200],
  );
  let resolvedRunnerGroup: string | undefined;

  onTestFinished(async () => {
    const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
    if (resolvedRunnerGroup !== undefined) {
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", resolvedRunnerGroup);
    }
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const result = await settleIncludingAbort(async () => {
      await flushWaitUntilForTest();
      const activeRuns = trackedRuns.filter((tracked) => {
        return !tracked.completed;
      });
      if (activeRuns.length > 0) {
        const ownerHeaders = signIn(actor);
        await Promise.all(
          activeRuns.map(async (tracked) => {
            const current = await accept(
              runsByIdApi.getById({
                headers: ownerHeaders,
                params: { id: tracked.runId },
              }),
              [200],
            );
            if (
              ["queued", "pending", "running"].includes(current.body.status)
            ) {
              await accept(
                runsCancelApi.cancel({
                  headers: ownerHeaders,
                  params: { id: tracked.runId },
                }),
                [200],
              );
            }
          }),
        );
      }
      await flushWaitUntilForTest();
    });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
    if (!result.ok) {
      throw result.error;
    }
  });

  async function awaitBootstrap() {
    const [runnerGroup] = await Promise.all([
      runnerGroupPromise,
      orgCreatedPromise,
    ]);
    resolvedRunnerGroup = runnerGroup;
    return runnerGroup;
  }

  async function startRun(prompt: string) {
    const runnerGroup = resolvedRunnerGroup ?? (await awaitBootstrap());
    const clientEventId = randomUUID();
    const sent = await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          prompt,
          model: null,
          hasTextContent: true,
          clientEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
        },
      }),
      [201],
    );
    const execution = await runs.nextReceivedExecution(runnerGroup);
    const tracked: TrackedRun = {
      runId: execution.runId,
      sandboxToken: execution.sandboxToken,
      completed: false,
    };
    trackedRuns.push(tracked);
    return {
      threadId: sent.body.threadId,
      runId: execution.runId,
      sandboxToken: execution.sandboxToken,
      initialEventId: clientEventId,
      execution,
      tracked,
    };
  }

  async function startTwoRuns(firstPrompt: string, secondPrompt: string) {
    const runnerGroup = resolvedRunnerGroup ?? (await awaitBootstrap());
    const ownerHeaders = signIn(actor);
    const [firstSent, secondSent] = await Promise.all([
      accept(
        chatEventsApi.send({
          headers: ownerHeaders,
          body: {
            prompt: firstPrompt,
            model: null,
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: firstPrompt }],
            },
          },
        }),
        [201],
      ),
      accept(
        chatEventsApi.send({
          headers: ownerHeaders,
          body: {
            prompt: secondPrompt,
            model: null,
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: secondPrompt }],
            },
          },
        }),
        [201],
      ),
    ]);
    await flushWaitUntilForTest();
    const dispatches = runs.receivedDispatches(runnerGroup);
    const findForThread = (threadId: string) => {
      const execution = dispatches.find((envelope) => {
        return (
          envelope.executionContext.platformEnvironment.OKOU_CHAT_THREAD_ID ===
          threadId
        );
      })?.executionContext;
      if (!execution) {
        throw new Error(`Expected dispatched execution for thread ${threadId}`);
      }
      const tracked: TrackedRun = {
        runId: execution.runId,
        sandboxToken: execution.sandboxToken,
        completed: false,
      };
      trackedRuns.push(tracked);
      return {
        threadId,
        runId: execution.runId,
        sandboxToken: execution.sandboxToken,
        execution,
        tracked,
      };
    };
    return [
      findForThread(firstSent.body.threadId),
      findForThread(secondSent.body.threadId),
    ] as const;
  }

  async function queuePrompt(
    threadId: string,
    prompt: string,
    options?: {
      readonly titleSnapshot: string;
      readonly template: GenerationTemplateRequest;
    },
  ): Promise<string> {
    const clientEventId = randomUUID();
    await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          threadId,
          prompt,
          model: null,
          hasTextContent: true,
          clientEventId,
          userMessage: options
            ? templateUserMessage(
                prompt,
                options.titleSnapshot,
                options.template,
              )
            : {
                version: 1,
                parts: [{ type: "text", text: prompt }],
              },
        },
      }),
      [201],
    );
    return clientEventId;
  }

  async function listThreadEvents(threadId: string) {
    const response = await accept(
      chatThreadEventsApi.rows({
        headers: signIn(actor),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    return projectChatEventRows(response.body.rows);
  }

  return {
    actor,
    awaitBootstrap,
    startRun,
    startTwoRuns,
    queuePrompt,
    listThreadEvents,
  };
}

describe("CHAT-02: steering input prompts into a running run", () => {
  it(
    "chat-events-steer-010 accepts only the run's own sandbox token",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const {
        actor,
        awaitBootstrap,
        startTwoRuns,
        queuePrompt,
        listThreadEvents,
      } = prepareRunEnvironment();

      const [cliToken, [activeRun, otherRun]] = await Promise.all([
        accept(cliDeviceApi.create({ body: {} }), [200]).then(
          async (device) => {
            await accept(
              cliApproveApi.approve({
                headers: signIn(actor),
                body: { device_code: device.body.device_code },
              }),
              [200],
            );
            const exchanged = await accept(
              cliTokenApi.exchange({
                body: { device_code: device.body.device_code },
              }),
              [200],
            );
            return exchanged.body.access_token;
          },
        ),
        awaitBootstrap().then(() => {
          return startTwoRuns(
            "Start the active thread run for steering auth checks.",
            "Start another run in a separate thread.",
          );
        }),
      ]);

      const queuedPrompt = "Tighten the rollout checklist before launch.";
      const queuedEventId = await queuePrompt(activeRun.threadId, queuedPrompt);

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      mockClerkOrgMembership(actor);
      const cliHeaders = bearerHeaders(cliToken);
      const otherHeaders = bearerHeaders(otherRun.sandboxToken);
      const ownerHeaders = bearerHeaders(activeRun.sandboxToken);
      const [
        unauthNext,
        unauthSteered,
        cliNext,
        cliSteered,
        otherNext,
        otherSteeredActive,
        otherSteeredForeign,
      ] = await Promise.all([
        accept(
          runnersSteerApi.next({
            headers: {},
            params: { runId: activeRun.runId },
          }),
          [401],
        ),
        accept(
          runnersSteerApi.steered({
            headers: {},
            params: { runId: activeRun.runId, eventId: queuedEventId },
            body: {},
          }),
          [401],
        ),
        accept(
          runnersSteerApi.next({
            headers: cliHeaders,
            params: { runId: activeRun.runId },
          }),
          [403],
        ),
        accept(
          runnersSteerApi.steered({
            headers: cliHeaders,
            params: { runId: activeRun.runId, eventId: queuedEventId },
            body: {},
          }),
          [403],
        ),
        accept(
          runnersSteerApi.next({
            headers: otherHeaders,
            params: { runId: activeRun.runId },
          }),
          [403],
        ),
        accept(
          runnersSteerApi.steered({
            headers: otherHeaders,
            params: { runId: activeRun.runId, eventId: queuedEventId },
            body: {},
          }),
          [403],
        ),
        accept(
          runnersSteerApi.steered({
            headers: otherHeaders,
            params: { runId: otherRun.runId, eventId: queuedEventId },
            body: {},
          }),
          [404],
        ),
      ]);
      expect(unauthNext.status).toBe(401);
      expect(unauthSteered.status).toBe(401);
      expect(cliNext.status).toBe(403);
      expect(cliSteered.status).toBe(403);
      expect(otherNext.status).toBe(403);
      expect(otherSteeredActive.status).toBe(403);
      expect(otherSteeredForeign.status).toBe(404);

      const polled = await accept(
        runnersSteerApi.next({
          headers: ownerHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );
      expect(polled.body).toStrictEqual({
        input: { eventId: queuedEventId, prompt: queuedPrompt },
      });

      const firstAck = await accept(
        runnersSteerApi.steered({
          headers: ownerHeaders,
          params: { runId: activeRun.runId, eventId: queuedEventId },
          body: {},
        }),
        [200],
      );
      const secondAck = await accept(
        runnersSteerApi.steered({
          headers: ownerHeaders,
          params: { runId: activeRun.runId, eventId: queuedEventId },
          body: {},
        }),
        [200],
      );
      expect(firstAck.body).toStrictEqual({ outcome: "steered" });
      expect(secondAck.body).toStrictEqual({ outcome: "steered" });

      const [afterAck, events] = await Promise.all([
        accept(
          runnersSteerApi.next({
            headers: ownerHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
        listThreadEvents(activeRun.threadId),
      ]);
      expect(afterAck.body).toStrictEqual({ input: null });

      const replacements = events.filter((event) => {
        return event.revokesEventId === queuedEventId;
      });
      expect(replacements).toHaveLength(1);
      expect(replacements[0]).toMatchObject({
        eventType: "input.prompt",
        runId: activeRun.runId,
        revokesEventId: queuedEventId,
      });
    },
  );

  it(
    "chat-events-steer-001 renders website steering from current settings after starting disabled=false",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun, queuePrompt } =
        prepareRunEnvironment();
      await awaitBootstrap();

      await accept(
        paidToolsApi.update({
          headers: signIn(actor),
          params: { toolId: "image-generation" },
          body: { disabled: false },
        }),
        [200],
      );

      const initialPrompt = "Prepare the initial workspace before steering.";
      const activeRun = await startRun(initialPrompt);
      const sandboxHeaders = bearerHeaders(activeRun.sandboxToken);

      const blackSlabsItem = findWebsiteTemplateItem(BLACK_SLABS_TEMPLATE_ID);
      if (!blackSlabsItem) {
        throw new Error("Expected Black Slabs website template catalog entry");
      }
      const blackSlabsPkg = findWebsiteTemplatePackage(
        blackSlabsItem.templateId,
      );
      if (!blackSlabsPkg) {
        throw new Error("Expected Black Slabs website template package");
      }
      const [imageWorkflowInstruction] = websiteImageInstructions(true);
      if (!imageWorkflowInstruction) {
        throw new Error("Expected website image workflow instruction");
      }

      const literalCommand =
        "okou generate image --provider built-in --prompt 'hero visual'";
      const userText = `Build a product launch site and keep the literal CLI snippet \`${literalCommand}\` visible in the guide.`;
      const templateMarker = `[Template #1: ${blackSlabsItem.title} (website)]`;

      const queuedEventId = await queuePrompt(activeRun.threadId, userText, {
        titleSnapshot: blackSlabsItem.title,
        template: {
          type: "website",
          selection: { websiteTemplateId: BLACK_SLABS_TEMPLATE_ID },
        },
      });

      await accept(
        paidToolsApi.update({
          headers: signIn(actor),
          params: { toolId: "image-generation" },
          body: { disabled: true },
        }),
        [200],
      );

      const disabledPoll = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );
      expect(disabledPoll.body.input?.eventId).toBe(queuedEventId);
      const disabledPrompt = disabledPoll.body.input?.prompt ?? "";
      expect(disabledPrompt).toContain("# Inline Templates");
      expect(disabledPrompt).toContain("## Template #1 (website)");
      expect(disabledPrompt).toContain(
        `Template: ${blackSlabsItem.title} (${blackSlabsItem.id})`,
      );
      expect(disabledPrompt).toContain(
        `okou resource pull ${blackSlabsPkg.resourceId} --dir ./generated/resources`,
      );
      expect(disabledPrompt).toContain(
        `Read ./generated/resources/${blackSlabsPkg.slug}/SKILL.md before authoring`,
      );
      expect(disabledPrompt).toContain(
        "okou host screenshot ./publish --out ./generated/previews/cover.png",
      );
      expect(disabledPrompt).toContain(
        "okou host ./publish --site <slug> --preview ./generated/previews/cover.png --json",
      );
      expect(disabledPrompt).toContain(userText);
      expect(disabledPrompt).toContain(literalCommand);
      expect(disabledPrompt).toContain(templateMarker);
      expect(disabledPrompt).not.toContain("Image workflow:");
      expect(disabledPrompt).not.toContain(imageWorkflowInstruction);

      await accept(
        paidToolsApi.update({
          headers: signIn(actor),
          params: { toolId: "image-generation" },
          body: { disabled: false },
        }),
        [200],
      );

      const enabledPoll = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );
      const repeatedPoll = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );
      expect(enabledPoll.body.input?.eventId).toBe(queuedEventId);
      expect(repeatedPoll.body).toStrictEqual(enabledPoll.body);
      const enabledPrompt = enabledPoll.body.input?.prompt ?? "";
      expect(enabledPrompt).toContain(
        `Template: ${blackSlabsItem.title} (${blackSlabsItem.id})`,
      );
      expect(enabledPrompt).toContain(
        `Template package id: ${blackSlabsPkg.templateId}`,
      );
      expect(enabledPrompt).toContain(
        `Template archive SHA-256: ${blackSlabsPkg.source.archive.sha256}`,
      );
      expect(enabledPrompt).toContain(
        `okou resource pull ${blackSlabsPkg.resourceId} --dir ./generated/resources`,
      );
      expect(enabledPrompt).toContain(imageWorkflowInstruction);
      expect(enabledPrompt).toContain(
        "okou host ./publish --site <slug> --preview ./generated/previews/cover.png --json",
      );
      expect(enabledPrompt).toContain(userText);
      expect(enabledPrompt).toContain(literalCommand);
      expect(enabledPrompt).toContain(templateMarker);

      const ack = await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId, eventId: queuedEventId },
          body: {},
        }),
        [200],
      );
      expect(ack.body).toStrictEqual({ outcome: "steered" });

      const [runAfterSteer, postAckPoll] = await Promise.all([
        accept(
          runsByIdApi.getById({
            headers: signIn(actor),
            params: { id: activeRun.runId },
          }),
          [200],
        ),
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
      ]);
      expect(activeRun.execution.prompt).toBe(initialPrompt);
      expect(runAfterSteer.body.prompt).toBe(initialPrompt);
      expect(postAckPoll.body).toStrictEqual({ input: null });
    },
  );

  it(
    "chat-events-steer-005 steers Document input with its pinned source before the next queued prompt",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { awaitBootstrap, startRun, queuePrompt, listThreadEvents } =
        prepareRunEnvironment();
      await awaitBootstrap();

      const invoiceItem = findDocumentTemplateItem(SIMPLE_INVOICE_TEMPLATE_ID);
      if (!invoiceItem) {
        throw new Error("Expected Simple Invoice document template entry");
      }

      const activeRun = await startRun("Start active document steering run.");
      const sandboxHeaders = bearerHeaders(activeRun.sandboxToken);

      const invoicePrompt =
        "Draft the April consulting invoice for Northwind Studio.";
      const summaryPrompt =
        "Summarize the invoice payment terms in three concise bullets.";

      const invoiceEventId = await queuePrompt(
        activeRun.threadId,
        invoicePrompt,
        {
          titleSnapshot: invoiceItem.title,
          template: {
            type: "document",
            selection: { documentTemplateId: SIMPLE_INVOICE_TEMPLATE_ID },
          },
        },
      );
      const summaryEventId = await queuePrompt(
        activeRun.threadId,
        summaryPrompt,
      );

      const [queuedEvents, firstPoll] = await Promise.all([
        listThreadEvents(activeRun.threadId),
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
      ]);

      const queuedInvoiceEvent = queuedEvents.find((event) => {
        return event.id === invoiceEventId;
      });
      expect(queuedInvoiceEvent).toBeDefined();
      expect(queuedInvoiceEvent?.eventType).toBe("input.prompt");
      if (queuedInvoiceEvent?.eventType === "input.prompt") {
        expect(queuedInvoiceEvent.runId).toBeUndefined();
        expect(queuedInvoiceEvent.userMessage.parts).toContainEqual({
          type: "template",
          titleSnapshot: invoiceItem.title,
          template: {
            type: "document",
            selection: { documentTemplateId: SIMPLE_INVOICE_TEMPLATE_ID },
          },
        });
      }

      expect(firstPoll.body.input?.eventId).toBe(invoiceEventId);
      const firstDeliveredPrompt = firstPoll.body.input?.prompt ?? "";
      expect(firstDeliveredPrompt).toContain(invoicePrompt);
      expect(firstDeliveredPrompt).toContain(
        `Selected document template: ${invoiceItem.title}`,
      );
      expect(firstDeliveredPrompt).toContain(SIMPLE_INVOICE_PINNED_SOURCE_URL);
      expect(firstDeliveredPrompt).toContain(
        `[Template #1: ${invoiceItem.title} (document)]`,
      );

      const ack = await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId, eventId: invoiceEventId },
          body: {},
        }),
        [200],
      );
      expect(ack.body).toStrictEqual({ outcome: "steered" });

      const secondPoll = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );
      expect(secondPoll.body).toStrictEqual({
        input: { eventId: summaryEventId, prompt: summaryPrompt },
      });
    },
  );

  it(
    "chat-events-steer-007 returns the next prompt after the run's own input and declares it steered once",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { awaitBootstrap, startRun, queuePrompt, listThreadEvents } =
        prepareRunEnvironment();
      await awaitBootstrap();

      const activeRun = await startRun(
        "Analyze the quarterly conversion funnel.",
      );
      const sandboxHeaders = bearerHeaders(activeRun.sandboxToken);

      const beforeEnqueue = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );
      expect(beforeEnqueue.body).toStrictEqual({ input: null });

      const firstQueuedPrompt = "Segment conversion by acquisition channel.";
      const secondQueuedPrompt = "List the top three onboarding drop-offs.";
      const firstQueuedId = await queuePrompt(
        activeRun.threadId,
        firstQueuedPrompt,
      );
      const secondQueuedId = await queuePrompt(
        activeRun.threadId,
        secondQueuedPrompt,
      );

      const [firstRead, repeatedHeadRead] = await Promise.all([
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
      ]);
      expect(firstRead.body).toStrictEqual({
        input: { eventId: firstQueuedId, prompt: firstQueuedPrompt },
      });
      expect(repeatedHeadRead.body).toStrictEqual(firstRead.body);

      const [concurrentAckA, concurrentAckB] = await Promise.all([
        accept(
          runnersSteerApi.steered({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId, eventId: firstQueuedId },
            body: {},
          }),
          [200],
        ),
        accept(
          runnersSteerApi.steered({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId, eventId: firstQueuedId },
            body: {},
          }),
          [200],
        ),
      ]);
      expect(concurrentAckA.body).toStrictEqual({ outcome: "steered" });
      expect(concurrentAckB.body).toStrictEqual({ outcome: "steered" });

      const secondRead = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );
      expect(secondRead.body).toStrictEqual({
        input: { eventId: secondQueuedId, prompt: secondQueuedPrompt },
      });

      const secondAck = await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId, eventId: secondQueuedId },
          body: {},
        }),
        [200],
      );
      const replayedFirstAck = await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId, eventId: firstQueuedId },
          body: {},
        }),
        [200],
      );
      expect(secondAck.body).toStrictEqual({ outcome: "steered" });
      expect(replayedFirstAck.body).toStrictEqual({ outcome: "steered" });

      const [finalPoll, events] = await Promise.all([
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
        listThreadEvents(activeRun.threadId),
      ]);
      expect(finalPoll.body).toStrictEqual({ input: null });

      const firstReplacements = events.filter((event) => {
        return event.revokesEventId === firstQueuedId;
      });
      const secondReplacements = events.filter((event) => {
        return event.revokesEventId === secondQueuedId;
      });
      expect(firstReplacements).toHaveLength(1);
      expect(firstReplacements[0]).toMatchObject({
        eventType: "input.prompt",
        runId: activeRun.runId,
        revokesEventId: firstQueuedId,
      });
      expect(secondReplacements).toHaveLength(1);
      expect(secondReplacements[0]).toMatchObject({
        eventType: "input.prompt",
        runId: activeRun.runId,
        revokesEventId: secondQueuedId,
      });
    },
  );

  it(
    "chat-events-steer-008 skips recalled prompts and rejects unknown input",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun, queuePrompt, listThreadEvents } =
        prepareRunEnvironment();
      await awaitBootstrap();

      const activeRun = await startRun("Review the deployment rollback plan.");
      const sandboxHeaders = bearerHeaders(activeRun.sandboxToken);

      const recalledPrompt = "Disregard this outdated checklist item.";
      const remainingPrompt = "Verify the database backup checksum instead.";
      const recalledEventId = await queuePrompt(
        activeRun.threadId,
        recalledPrompt,
      );
      const remainingEventId = await queuePrompt(
        activeRun.threadId,
        remainingPrompt,
      );

      const [unknownDeclaration, headBeforeRecall] = await Promise.all([
        accept(
          runnersSteerApi.steered({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId, eventId: randomUUID() },
            body: {},
          }),
          [404],
        ),
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
      ]);
      expect(unknownDeclaration.status).toBe(404);
      expect(headBeforeRecall.body).toStrictEqual({
        input: { eventId: recalledEventId, prompt: recalledPrompt },
      });

      const recalled = await accept(
        chatEventsApi.send({
          headers: signIn(actor),
          body: {
            threadId: activeRun.threadId,
            revokesEventId: recalledEventId,
          },
        }),
        [201],
      );
      expect(recalled.status).toBe(201);

      const [lateDeclaration, nextAfterRecall] = await Promise.all([
        accept(
          runnersSteerApi.steered({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId, eventId: recalledEventId },
            body: {},
          }),
          [409],
        ),
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
      ]);
      expect(lateDeclaration.body.error.code).toBe(
        STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
      );
      expect(nextAfterRecall.body).toStrictEqual({
        input: { eventId: remainingEventId, prompt: remainingPrompt },
      });

      const firstAck = await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId, eventId: remainingEventId },
          body: {},
        }),
        [200],
      );
      const secondAck = await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: activeRun.runId, eventId: remainingEventId },
          body: {},
        }),
        [200],
      );
      expect(firstAck.body).toStrictEqual({ outcome: "steered" });
      expect(secondAck.body).toStrictEqual({ outcome: "steered" });

      const [finalPoll, events] = await Promise.all([
        accept(
          runnersSteerApi.next({
            headers: sandboxHeaders,
            params: { runId: activeRun.runId },
          }),
          [200],
        ),
        listThreadEvents(activeRun.threadId),
      ]);
      expect(finalPoll.body).toStrictEqual({ input: null });

      const recalledRevokers = events.filter((event) => {
        return event.revokesEventId === recalledEventId;
      });
      expect(recalledRevokers).toHaveLength(1);
      expect(recalledRevokers[0]).toMatchObject({
        eventType: "control.revoke",
        revokesEventId: recalledEventId,
      });

      const remainingRevokers = events.filter((event) => {
        return event.revokesEventId === remainingEventId;
      });
      expect(remainingRevokers).toHaveLength(1);
      expect(remainingRevokers[0]).toMatchObject({
        eventType: "input.prompt",
        runId: activeRun.runId,
        revokesEventId: remainingEventId,
      });
    },
  );
});
