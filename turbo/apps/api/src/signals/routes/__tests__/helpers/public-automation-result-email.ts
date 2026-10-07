import { drainEmailOutboxItemsForTest } from "../../../../test-fixtures/email-outbox-workers";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { officialWorkflowsContract } from "@okouai/api-contracts/contracts/official-workflows";
import { testOfficialWorkflowCatalogStateContract } from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createHash, randomUUID } from "node:crypto";
import { expect, onTestFinished } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { installApiTestConnectorCatalog } from "../../../../test-fixtures/connector-catalog";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../../cron-official-workflow-catalog";
import { officialWorkflowRoutes } from "../../official-workflows";
import { testOfficialWorkflowCatalogStateRoutes } from "../../test-official-workflow-catalog-state";
import { workflowAutomationsRoutes } from "../../workflow-automations";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createWorkflowsBddApi } from "./api-bdd-workflows";
import { mockClerkUsers } from "./clerk-users";
import { installDurableUserExportStorage } from "./durable-user-export-storage";
import { createEmailOutboxStateApi } from "./email-outbox-state";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";

interface OwnedRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly runnerGroup: string;
  sandboxToken?: string;
  acknowledged: boolean;
  readonly restoreStorage: () => void;
}

/** Real producers and external delivery for the approved ordinary email cases. */
export function createPublicAutomationResultEmailApi(context: TestContext) {
  const runs = createRunsApi(context);
  const workflows = createWorkflowsBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const outbox = createEmailOutboxStateApi(context);
  const mocks = createRouteMocks(context);
  const owned = new Map<string, OwnedRun>();

  function headers(actor: ApiTestUser) {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function configureDelivery(actor: ApiTestUser): void {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("RESEND_API_KEY", "public-result-email-key");
    mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
    mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
    const emailId = `email_${actor.userId}`;
    mockClerkUsers(context, [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "Official",
        lastName: "Automation",
        imageUrl: null,
      },
    ]);
    context.mocks.resend.send.mockReset();
    context.mocks.resend.send.mockResolvedValue({
      data: { id: `email-${randomUUID()}` },
      error: null,
    });
  }

  async function cleanup(actor: ApiTestUser): Promise<void> {
    const cleanupRuns = createRunsApi(context);
    const cleanupWebhooks = createWebhookCallbackApi(context);
    for (const run of owned.values()) {
      if (
        run.actor.userId !== actor.userId ||
        run.actor.orgId !== actor.orgId ||
        run.acknowledged
      ) {
        continue;
      }
      run.restoreStorage();
      cleanupRuns.acceptTelemetryIngest();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const current = await cleanupRuns.readRun(actor, run.runId);
      if (current.status === "pending" || current.status === "running") {
        await cleanupRuns.requestCancelRun(actor, run.runId, [200]);
      }
      // A public cancellation keeps a claimed slot until its Runner ACKs.
      if (
        run.sandboxToken &&
        (current.status === "pending" ||
          current.status === "running" ||
          current.status === "cancelled")
      ) {
        await cleanupWebhooks.requestAgentComplete(
          { runId: run.runId, exitCode: 1, error: "Cancelled by test cleanup" },
          { authorization: `Bearer ${run.sandboxToken}` },
          [200],
        );
      }
      run.acknowledged = true;
      await flushWaitUntilForTest();
    }
  }

  function track(
    actor: ApiTestUser,
    runId: string,
    runnerGroup: string,
  ): OwnedRun {
    const existing = owned.get(runId);
    if (existing) {
      return existing;
    }
    const storage = context.mocks.s3.send.getMockImplementation();
    const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const run: OwnedRun = {
      actor,
      runId,
      runnerGroup,
      acknowledged: false,
      restoreStorage() {
        mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
        mockOptionalEnv("SECRETS_KMS_KEY_ID", kmsKey);
        if (storage) {
          context.mocks.s3.send.mockImplementation(storage);
        }
        if (signedUrl) {
          context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
        }
      },
    };
    owned.set(runId, run);
    onTestFinished(async () => {
      await cleanup(actor);
    });
    return run;
  }

  async function start(
    actor: ApiTestUser,
    automationId: string,
    runnerGroup: string,
  ) {
    const response = await accept(
      setupApp({ context, routes: workflowAutomationsRoutes })(
        workflowAutomationsContract,
      ).run({
        headers: headers(actor),
        params: { id: automationId },
      }),
      [201],
    );
    expect(response.body.runId).toBeNull();
    await flushWaitUntilForTest();
    const events = await workflows.readThreadEvents(response.body.chatThreadId);
    const input = [...events].reverse().find((event) => {
      return event.eventType === "input.prompt" && event.runId;
    });
    if (!input?.runId) {
      throw new Error("Expected a publicly launched Automation Run");
    }
    track(actor, input.runId, runnerGroup);
    return { runId: input.runId, threadId: response.body.chatThreadId };
  }

  async function complete(
    actor: ApiTestUser,
    runId: string,
    runnerGroup: string,
    args: { readonly output?: string; readonly exitCode?: number } = {},
  ): Promise<void> {
    const run = track(actor, runId, runnerGroup);
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(runId);
    run.sandboxToken = claim.sandboxToken;
    const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
    if (args.output !== undefined) {
      await webhooks.requestAgentEvents(
        {
          runId,
          events: [{ type: "result", sequenceNumber: 0, result: args.output }],
        },
        sandboxHeaders,
        [200],
      );
    }
    const history = Buffer.from(
      `official result email history ${runId}`,
      "utf8",
    );
    const hash = createHash("sha256").update(history).digest("hex");
    const previousStorage = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (
        (command instanceof HeadObjectCommand ||
          command instanceof GetObjectCommand) &&
        command.input.Key === `blobs/${hash}.blob`
      ) {
        return Promise.resolve({
          ContentLength: history.byteLength,
          ...(command instanceof GetObjectCommand
            ? {
                Body: {
                  async *[Symbol.asyncIterator]() {
                    yield history;
                  },
                },
              }
            : {}),
        });
      }
      if (!previousStorage) {
        throw new Error("Expected the owned external object store");
      }
      return previousStorage(command);
    });
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId,
        hash,
        rawSize: history.byteLength,
        encodedSize: history.byteLength,
        encoding: "identity",
      },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: args.exitCode ?? 0,
        ...(args.output === undefined ? {} : { lastEventSequence: 0 }),
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `official-result-email-${runId}`,
          cliAgentSessionHistoryHash: hash,
        },
      },
      sandboxHeaders,
      [200],
    );
    run.acknowledged = true;
    await flushWaitUntilForTest();
    const current = await runs.readRun(actor, runId);
    expect(current.status).toBe(args.exitCode === 1 ? "failed" : "completed");
    if (args.exitCode !== 1) {
      expect(current.result?.checkpointId).toStrictEqual(expect.any(String));
    }
  }

  async function drain(runId: string, automationId: string): Promise<number> {
    // Approved lookup supplies every owned ID solely to the actual worker.
    const { items } = await outbox.findSourceState({
      sourceRunId: runId,
      sourceWorkflowAutomationId: automationId,
    });
    return items.length === 0
      ? 0
      : await drainEmailOutboxItemsForTest(
          items.map((item) => {
            return item.id;
          }),
          context.signal,
        );
  }

  async function setupOfficial(
    options: {
      readonly morningBrief?: boolean;
      readonly budget?: number;
      readonly resultEmail?: boolean;
    } = {},
  ) {
    mockEnv("CRON_SECRET", "public-result-email-cron");
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `public-result-email-${randomUUID()}`,
    );
    await installApiTestConnectorCatalog({ ifAbsent: true });
    installDurableUserExportStorage(context, { prefixes: [""] });
    const storage = context.mocks.s3.send.getMockImplementation();
    const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const cleanupState: {
      owner?: { actor: ApiTestUser; agentId: string };
    } = {};
    async function cleanupCatalog() {
      await accept(
        setupApp({ context, routes: testOfficialWorkflowCatalogStateRoutes })(
          testOfficialWorkflowCatalogStateContract,
        ).action({ body: { action: "cleanup" } }),
        [200],
      );
    }
    onTestFinished(async () => {
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      if (storage) {
        context.mocks.s3.send.mockImplementation(storage);
      }
      if (signedUrl) {
        context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
      }
      if (cleanupState.owner) {
        const { actor, agentId } = cleanupState.owner;
        await cleanup(actor);
        await createBddApi(context).deleteAgent(actor, agentId);
      }
      await cleanupCatalog();
    });
    // The calling case owns an isolated database for this operator fixture.
    await cleanupCatalog();
    if (options.morningBrief) {
      // The deployed release retires connector-doctor. Establish its accepted
      // predecessor through the same producer as syncDeployedCatalog's fixture.
      const previous = await accept(
        setupApp({
          context,
          routes: createCronOfficialWorkflowCatalogRoutes({
            schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
            definitions: [
              {
                name: "connector-doctor",
                lifecycle: "active",
                workflow: {
                  displayName: "Display connector-doctor",
                  description: "Description for connector-doctor",
                  instruction: "Execute only the accepted Definition content.",
                  files: [
                    { path: "references/context.md", content: "accepted\n" },
                  ],
                },
                blueprints: [
                  {
                    key: "weekly-check",
                    parameters: [],
                    desiredState: {
                      kind: "schedule",
                      schedule: { type: "cron", cronExpression: "0 9 * * 1" },
                    },
                    runtime: { resultEmail: false },
                  },
                ],
                presentation: {
                  category: "productivity",
                  order: 1,
                  marketingCopy: "Official catalog entry.",
                },
              },
            ],
          }),
        })(cronOfficialWorkflowCatalogContract).sync({
          headers: { authorization: "Bearer public-result-email-cron" },
        }),
        [200],
      );
      expect(previous.body).toMatchObject({
        outcome: "accepted",
        diagnostics: [],
      });
    }
    const definitionName = options.morningBrief
      ? "morning-brief"
      : `api-test-result-email-${randomUUID().slice(0, 8)}`;
    const blueprintKey = options.morningBrief ? "daily-delivery" : "result";
    const routes = options.morningBrief
      ? cronOfficialWorkflowCatalogRoutes
      : createCronOfficialWorkflowCatalogRoutes({
          schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
          definitions: [
            {
              name: definitionName,
              lifecycle: "active",
              workflow: {
                displayName: "Official result email",
                description: "Public result delivery",
                instruction: "Return the result.",
                files: [],
              },
              blueprints: [
                {
                  key: blueprintKey,
                  parameters: [],
                  desiredState: {
                    kind: "schedule",
                    schedule: { type: "loop", intervalSeconds: 3600 },
                    autonomyBudget: options.budget ?? 3,
                  },
                  runtime: { resultEmail: options.resultEmail ?? true },
                },
              ],
              presentation: { category: "productivity" },
            },
          ],
        });
    const synced = await accept(
      setupApp({ context, routes })(cronOfficialWorkflowCatalogContract).sync({
        headers: { authorization: "Bearer public-result-email-cron" },
      }),
      [200],
    );
    expect(synced.body).toMatchObject({ outcome: "accepted", diagnostics: [] });
    const { actor } = await workflows.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
      tier: "team",
      model: "claude-fable-5-1",
    });
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const { agentId } = await workflows.createAgent(actor);
    cleanupState.owner = { actor, agentId };
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      { [FeatureSwitchKey.OfficialWorkflows]: true },
    );
    // Agent creation may install its own broad S3 mock. Restore this source's store.
    if (storage) {
      context.mocks.s3.send.mockImplementation(storage);
    }
    const installed = await accept(
      setupApp({ context, routes: officialWorkflowRoutes })(
        officialWorkflowsContract,
      ).install({
        headers: headers(actor),
        params: { definitionName },
        body: { agentId, blueprints: [{ blueprintKey, bindings: [] }] },
      }),
      [201],
    );
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected the real installed Automation");
    }
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptTelemetryIngest();
    configureDelivery(actor);
    return {
      actor,
      agentId,
      workflowId: installed.body.workflow.id,
      automationId: automation.id,
      runnerGroup,
    };
  }

  return {
    cleanup,
    configureDelivery,
    track,
    start,
    complete,
    drain,
    setupOfficial,
  };
}
