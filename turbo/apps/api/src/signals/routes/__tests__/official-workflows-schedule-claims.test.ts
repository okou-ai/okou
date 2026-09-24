import { createHash, randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { userPreferencesRoutes } from "../user-preferences";
import {
  cronExecuteMorningBriefsContract,
  cronOfficialWorkflowCatalogContract,
} from "@okouai/api-contracts/contracts/cron";
import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  type OfficialWorkflowBlueprint,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { officialWorkflowInstallationsContract } from "@okouai/api-contracts/contracts/official-workflows";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { testOfficialWorkflowCatalogStateContract } from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateContract } from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { setupRawAppRequestWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { serializeOfficialWorkflowCatalogTests } from "../../../test-fixtures/official-workflow-catalog-lease";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { holdChatEventQueueAdmissionLockFixture } from "../../../test-fixtures/chat-events";
import {
  holdMorningBriefFirstMaterialization,
  readLegacyAutomation,
  readNativeOccurrences,
  readNativeSchedule,
  removeMorningBriefNativeScheduleForMigrationFixture,
} from "../../../test-fixtures/morning-brief-native-schedule";
import { waitForDeferredBlocker } from "../../../test-fixtures/pi-deferred-lock";
import { withOwnedPiStableContextGlobalInvalidationFixture } from "../../../test-fixtures/pi-stable-context";
import {
  holdWorkflowAutomationCommittedRunFixture,
  installMorningBriefSettlementFailureFixture,
  observeMorningBriefSettlementAttemptsFixture,
  readMorningBriefScheduleClaimsFixture,
  withWorkflowAutomationRunPersistenceFailureFixture,
} from "../../../test-fixtures/morning-brief-schedule-claim";
import { holdAgentRunPiExecutionSnapshotFixture } from "../../../test-fixtures/thread-bound-run-admission";
import { holdWorkflowAutomationRowFixture } from "../../../test-fixtures/workflow-queue";
import {
  readWorkflowScheduleSkipsFixture,
  skewLegacyMorningBriefAnchorFixture,
} from "../../../test-fixtures/workflow-schedule-expiry";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedBuiltInModelKey } from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";
import { officialWorkflowRoutes } from "../official-workflows";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { createScopedInlineMorningBriefCronRoutesForTest } from "../cron-execute-morning-briefs";
import { testOfficialWorkflowCatalogStateRoutes } from "../test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { acknowledgeDetachedForTest, createDeferredPromise } from "../../utils";

const context = testContext({ connectorCatalog: true });
const bdd = createBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);
const CRON_SECRET = "official-workflow-installation-cron-secret";
serializeOfficialWorkflowCatalogTests();

type ActiveDefinition = Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "active" }
>;

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

// Fable is excluded from Pi, so the brief's legacy Run keeps the native
// Runner lifecycle; Sonnet 5 exercises the Pi launch path.
type BriefDefaultModel = "claude-fable-5-1" | "claude-sonnet-5";

async function selectBuiltInDefaultModel(
  actor: ApiTestUser,
  model: BriefDefaultModel,
): Promise<void> {
  await seedBuiltInModelKey(context, model);
  await runs.updateOrgModelPolicies(actor, [
    {
      model,
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    },
  ]);
}

function catalog(
  definitions: OfficialWorkflowSourceCatalog["definitions"],
): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    definitions,
  };
}

function activeDefinition(
  name: string,
  blueprints: readonly OfficialWorkflowBlueprint[],
  instruction = "Execute only the accepted Definition content.",
): ActiveDefinition {
  return {
    name,
    lifecycle: "active",
    workflow: {
      displayName: `Display ${name}`,
      description: `Description for ${name}`,
      instruction,
      files: [{ path: "references/context.md", content: "accepted\n" }],
    },
    blueprints: [...blueprints],
    presentation: {
      category: "productivity",
      order: 1,
      marketingCopy: "Official catalog entry.",
    },
  };
}

function syncClient(candidate: unknown) {
  return setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
  })(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await withOwnedPiStableContextGlobalInvalidationFixture(
    [],
    async () => {
      return await accept(
        syncClient(candidate).sync({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
    },
  );
}

function connectorDoctorDefinition(): ActiveDefinition {
  return activeDefinition("connector-doctor", [
    {
      key: "weekly-check",
      parameters: [],
      desiredState: {
        kind: "schedule",
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * 1",
        },
      },
      runtime: { resultEmail: false },
    },
  ]);
}

async function syncDeployedCatalog() {
  await syncCatalog(catalog([connectorDoctorDefinition()]));
  return await withOwnedPiStableContextGlobalInvalidationFixture(
    [],
    async () => {
      return await accept(
        setupApp({ context, routes: cronOfficialWorkflowCatalogRoutes })(
          cronOfficialWorkflowCatalogContract,
        ).sync({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
        [200],
      );
    },
  );
}

function stateClient() {
  return setupApp({
    context,
    routes: testOfficialWorkflowCatalogStateRoutes,
  })(testOfficialWorkflowCatalogStateContract);
}

async function cleanupCatalog() {
  await accept(stateClient().action({ body: { action: "cleanup" } }), [200]);
}

function morningBriefPreferenceClient() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
}

function installationClient() {
  return setupApp({ context, routes: officialWorkflowRoutes })(
    officialWorkflowInstallationsContract,
  );
}

function workflowCollectionClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function automationClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function automationExecutionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
}

function storageClient() {
  return setupApp({
    context,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  })(testSystemStoragePresignedUrlCacheStateContract);
}

async function readAcceptedDefinitionFixture(definitionName: string) {
  const response = await accept(
    stateClient().action({ body: { action: "read", definitionName } }),
    [200],
  );
  if (!response.body.definition || !response.body.storage) {
    throw new Error(`Accepted Definition is unavailable: ${definitionName}`);
  }
  return {
    definition: response.body.definition,
    storage: response.body.storage,
  };
}

function s3BodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected an S3 object body");
}

function missingS3Object(key: string): Error {
  return Object.assign(new Error(`Missing S3 object ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function requiredS3ObjectKey(key: string | undefined): string {
  if (!key) {
    throw new Error("Expected an S3 object key");
  }
  return key;
}

function installCatalogStorageFixture() {
  const objects = new Map<string, Buffer>();
  let nextWriteError: Error | null = null;
  let heldWrite:
    | {
        readonly started: ReturnType<typeof createDeferredPromise<void>>;
        readonly release: ReturnType<typeof createDeferredPromise<void>>;
      }
    | undefined;
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = null;
        throw error;
      }
      const key = requiredS3ObjectKey(command.input.Key);
      if (heldWrite) {
        const gate = heldWrite;
        heldWrite = undefined;
        gate.started.resolve(undefined);
        return gate.release.promise.then(() => {
          objects.set(key, s3BodyBuffer(command.input.Body));
          return {};
        });
      }
      objects.set(key, s3BodyBuffer(command.input.Body));
      return Promise.resolve({});
    }
    if (command instanceof HeadObjectCommand) {
      const key = requiredS3ObjectKey(command.input.Key);
      const body = objects.get(key);
      return body
        ? Promise.resolve({ ContentLength: body.length })
        : Promise.reject(missingS3Object(key));
    }
    if (command instanceof GetObjectCommand) {
      const key = requiredS3ObjectKey(command.input.Key);
      const body = objects.get(key);
      return body
        ? Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator]() {
                yield body;
              },
            },
            ContentLength: body.length,
          })
        : Promise.reject(missingS3Object(key));
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return Promise.resolve({
        Contents: [...objects.entries()].flatMap(([Key, body]) => {
          return Key.startsWith(prefix)
            ? [{ Key, Size: body.length, LastModified: new Date(0) }]
            : [];
        }),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }
      return Promise.resolve({});
    }
    if (!fallback) {
      return Promise.reject(
        new Error(
          `Unexpected S3 command in Official Workflow storage fixture: ${command?.constructor.name ?? "unknown"}`,
        ),
      );
    }
    return fallback(command);
  });
  return {
    readObject(key: string): Buffer {
      const object = objects.get(key);
      if (!object) {
        throw new Error(`Missing test snapshot object ${key}`);
      }
      return object;
    },
    objectCount(): number {
      return objects.size;
    },
    failNextWrite(error: Error): void {
      nextWriteError = error;
    },
    holdNextWrite() {
      if (heldWrite) {
        throw new Error("An S3 write is already held");
      }
      const started = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      heldWrite = { started, release };
      return {
        started: started.promise,
        resolve(): void {
          release.resolve(undefined);
        },
        reject(error: Error): void {
          acknowledgeDetachedForTest(release.promise);
          release.reject(error);
        },
      };
    },
  };
}

async function setOfficialWorkflowsEnabled(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.OfficialWorkflows]: enabled },
  );
}

async function setMorningBriefEnabled(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.MorningBrief]: enabled },
  );
}

async function setNativeMorningBriefEnabled(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.NativeMorningBrief]: enabled },
  );
}

async function deliverClerkOrganizationCreated(
  actor: ApiTestUser,
  createdAt: Date,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: {
      id: actor.orgId,
      created_by: actor.userId,
      created_at: createdAt.getTime(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function deliverClerkOrganizationMembershipDeleted(
  actor: ApiTestUser,
): Promise<void> {
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.deleted",
    data: {
      id: `membership-${actor.userId}-${actor.orgId}`,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function listMorningBriefInstallations(actor: ApiTestUser) {
  const response = await accept(
    workflowCollectionClient().list({
      headers: authHeaders(actor),
      query: {},
    }),
    [200],
  );
  return response.body.filter((workflow) => {
    return workflow.official?.definitionName === "morning-brief";
  });
}

beforeEach(async () => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  // testContext seeds the default source; this hook also seeds the source
  // derived from the unique bucket used by this test.
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `official-workflow-installation-test-${randomUUID()}`,
  );
  await installApiTestConnectorCatalog();
  await cleanupCatalog();
});

async function readMorningBriefAutomations(
  actor: ApiTestUser,
  workflowId: string,
) {
  const response = await accept(
    installationClient().get({
      headers: authHeaders(actor),
      params: { workflowId },
    }),
    [200],
  );
  return response.body.workflow.automations;
}

function mockBriefMemberships(
  entries: readonly {
    readonly actor: ApiTestUser;
    readonly createdAt: Date;
    readonly membershipId?: string;
  }[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: entries.map(({ actor, createdAt, membershipId }) => {
        return {
          id: membershipId ?? `membership-${actor.userId}-${actor.orgId}`,
          role: actor.orgRole ?? "org:member",
          createdAt: createdAt.getTime(),
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        };
      }),
    },
  );
}

async function initializeBriefMember(actor: ApiTestUser, timezone: string) {
  return await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone },
    }),
    [200],
  );
}

async function readBriefPreference(actor: ApiTestUser) {
  return await accept(
    morningBriefPreferenceClient().get({ headers: authHeaders(actor) }),
    [200],
  );
}

async function tickNativeMorningBrief(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped Morning Brief owner");
  }
  return await accept(
    setupApp({
      context,
      routes: createScopedInlineMorningBriefCronRoutesForTest({
        orgId: actor.orgId,
        userId: actor.userId,
      }),
    })(cronExecuteMorningBriefsContract).execute({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
}

async function prepareBriefMember({
  actor = bdd.user(),
  createdAt = new Date("2030-01-01T00:00:00.000Z"),
  catalogAvailable = true,
  bootstrap = true,
}: {
  readonly actor?: ApiTestUser;
  readonly createdAt?: Date;
  readonly catalogAvailable?: boolean;
  readonly bootstrap?: boolean;
} = {}) {
  installCatalogStorageFixture();
  if (catalogAvailable) {
    await syncDeployedCatalog();
  }
  mockBriefMemberships([{ actor, createdAt }]);
  await setOfficialWorkflowsEnabled(actor, false);
  await setMorningBriefEnabled(actor, true);
  if (bootstrap) {
    await deliverClerkOrganizationCreated(actor, createdAt);
  }
  onTestFinished(async () => {
    installCatalogStorageFixture();
    await cleanupCatalog();
  });
  return { actor, createdAt };
}

describe("Morning Brief legacy schedule claim journal", () => {
  /** The published Morning Brief cadence, evaluated independently of the API. */
  function briefOccurrenceAfter(
    cronExpression: string,
    timezone: string,
    from: Date,
  ): Date | null {
    return new Cron(cronExpression, { timezone }).nextRun(from);
  }

  interface JournaledBrief {
    readonly actor: ApiTestUser;
    readonly runnerGroup: string;
    readonly workflowId: string;
    readonly automationId: string;
    readonly anchor: number;
  }

  async function installJournaledBrief(
    timezone = "Asia/Shanghai",
    model: BriefDefaultModel = "claude-fable-5-1",
  ): Promise<JournaledBrief> {
    // A subscribed org, so the legacy Run and its credit checks stay real.
    const { actor } = await workflowBdd.setupWorkflowOrg({ tier: "pro" });
    await prepareBriefMember({ actor });
    await selectBuiltInDefaultModel(actor, model);
    await initializeBriefMember(actor, timezone);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected one Morning Brief installation");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected the Morning Brief automation");
    }
    const preference = await readBriefPreference(actor);
    if (!preference.body.nextRunAt) {
      throw new Error("Expected an enabled Morning Brief schedule");
    }
    // Configured last so installation setup cannot replace the runner group
    // the fired brief's job is enqueued into, and registered before the tick
    // so the job it enqueues is claimable.
    const runnerGroup = runs.configureRunnerGroup();
    await runs.heartbeatRunner(runnerGroup);
    return {
      actor,
      runnerGroup,
      workflowId: installation.id,
      automationId: automation.id,
      anchor: Date.parse(preference.body.nextRunAt),
    };
  }

  /**
   * Fire the cron at a chosen instant and keep the clock there, so the runner
   * claim and completion that follow observe the same time as the tick.
   */
  async function pollAt(automationId: string, at: number): Promise<void> {
    mockNow(at);
    await accept(
      automationExecutionClient().execute({
        body: { automation_id: automationId },
      }),
      [200],
    );
  }

  async function briefThreadId(
    actor: ApiTestUser,
    workflowId: string,
  ): Promise<string> {
    const [automation] = await readMorningBriefAutomations(actor, workflowId);
    if (!automation?.chatThreadId) {
      throw new Error("Expected the fired brief to bind its chat thread");
    }
    return automation.chatThreadId;
  }

  /**
   * Deliver the run's terminal internal callbacks through the production
   * dispatcher. `dispatchCount` above one runs concurrent initial dispatches,
   * which is what actually reaches the handler more than once: the dispatcher
   * only selects pending or failed callbacks, so a sequential redelivery after
   * a successful one selects nothing. The returned counts are the arrival
   * evidence tests assert on.
   */
  async function deliverBriefCallback(
    runId: string,
    dispatchCount = 1,
    status: "completed" | "failed" = "completed",
  ): Promise<{
    readonly callbackResults: number;
    readonly successfulCallbacks: number;
  }> {
    const response = await accept(
      automationExecutionClient().dispatchCallbacks({
        body:
          status === "completed"
            ? {
                run_id: runId,
                status,
                dispatch_count: dispatchCount,
              }
            : {
                run_id: runId,
                status,
                error: "forced failed Morning Brief Run",
                dispatch_count: dispatchCount,
              },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    return {
      callbackResults: response.body.callback_results,
      successfulCallbacks: response.body.successful_callbacks,
    };
  }

  async function briefRunIds(threadId: string): Promise<readonly string[]> {
    const events = await workflowBdd.readThreadEvents(threadId);
    return events.flatMap((event) => {
      return event.eventType === "input.prompt" && event.runId
        ? [event.runId]
        : [];
    });
  }

  async function briefAutomationEventCount(threadId: string): Promise<number> {
    const events = await workflowBdd.readThreadEvents(threadId);
    return events.filter((event) => {
      return event.eventType === "input.automation";
    }).length;
  }

  it("skips an expired unclaimed legacy brief without inventing a Run or leaving the native anchor behind", async () => {
    mockEnv("WORKFLOW_SCHEDULE_EXPIRY_ENABLED", "true");
    const brief = await installJournaledBrief();
    const at = brief.anchor + 30 * 60_000 + 1;
    await pollAt(brief.automationId, at);

    await expect(
      readMorningBriefScheduleClaimsFixture(brief.automationId),
    ).resolves.toHaveLength(0);
    await expect(
      readWorkflowScheduleSkipsFixture(brief.automationId),
    ).resolves.toMatchObject([{ scheduledAnchorAt: new Date(brief.anchor) }]);
    const preference = await readBriefPreference(brief.actor);
    expect(preference.body.nextRunAt).toStrictEqual(expect.any(String));
    const next = Date.parse(preference.body.nextRunAt ?? "");
    expect(next).toBeGreaterThan(at);
    const [automation] = await readMorningBriefAutomations(
      brief.actor,
      brief.workflowId,
    );
    expect(automation?.nextRunAt).toBe(preference.body.nextRunAt);
    expect(automation?.lastRunAt).toBeNull();
    expect(automation?.chatThreadId).toBeNull();
  });

  it("audits a stale expired legacy mirror without replacing the durable future brief", async () => {
    mockEnv("WORKFLOW_SCHEDULE_EXPIRY_ENABLED", "true");
    const brief = await installJournaledBrief();
    const staleAnchor = new Date(brief.anchor - 60 * 60_000);
    const at = brief.anchor - 20 * 60_000;
    await skewLegacyMorningBriefAnchorFixture({
      automationId: brief.automationId,
      expectedAnchor: new Date(brief.anchor),
      staleAnchor,
    });

    await pollAt(brief.automationId, at);
    await expect(
      readWorkflowScheduleSkipsFixture(brief.automationId),
    ).resolves.toMatchObject([{ scheduledAnchorAt: staleAnchor }]);
    await expect(
      readMorningBriefScheduleClaimsFixture(brief.automationId),
    ).resolves.toHaveLength(0);
    const preference = await readBriefPreference(brief.actor);
    expect(preference.body.nextRunAt).toBe(
      new Date(brief.anchor).toISOString(),
    );
    const [automation] = await readMorningBriefAutomations(
      brief.actor,
      brief.workflowId,
    );
    expect(automation?.nextRunAt).toBe(preference.body.nextRunAt);
    expect(automation?.lastRunAt).toBeNull();
    expect(automation?.chatThreadId).toBeNull();
  });

  it("records the original due instant when the poll is late and keeps one occurrence across a retried tick", async () => {
    const brief = await installJournaledBrief();
    const polledAt = brief.anchor + 47 * 60 * 1000;

    await pollAt(brief.automationId, polledAt);

    const claims = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claims).toHaveLength(1);
    const [claim] = claims;
    expect(claim?.scheduledAnchorAt.getTime()).toBe(brief.anchor);
    // The poll clock stays the real fire time; only the anchor is the schedule.
    expect(claim?.claimedAt.getTime()).toBe(polledAt);
    expect(claim?.claimSequence).toBe(1);
    expect(claim?.queueEventId).not.toBeNull();
    expect(claim?.settlement).toBe("unsettled");

    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    const runIds = await briefRunIds(threadId);
    expect(runIds).toHaveLength(1);
    // The Run is bound in the launch transaction, before the post-return
    // last-run write, so it is already authoritative here.
    expect(claim?.runId).toBe(runIds[0]);
    expect(claim?.queueDisposition).toBe("claimed");

    // A retried tick for the same occurrence produces no second identity.
    await pollAt(brief.automationId, polledAt + 60_000);
    await expect(
      readMorningBriefScheduleClaimsFixture(brief.automationId),
    ).resolves.toHaveLength(1);
    await expect(briefRunIds(threadId)).resolves.toStrictEqual(runIds);
  });

  it("yields one occurrence when two ticks compete at the queue admission lock", async () => {
    const brief = await installJournaledBrief();
    await pollAt(brief.automationId, brief.anchor + 60_000);
    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    const [firstRunId] = await briefRunIds(threadId);
    if (!firstRunId) {
      throw new Error("Expected the first occurrence to start a run");
    }
    await deliverBriefCallback(firstRunId);

    const advanced = await readBriefPreference(brief.actor);
    if (!advanced.body.nextRunAt) {
      throw new Error("Expected the completion to publish the next occurrence");
    }
    const secondAnchor = Date.parse(advanced.body.nextRunAt);

    // Both ticks reach the shared thread admission lock before either can
    // consume the schedule, so the race is observed rather than assumed.
    const barrier = await holdChatEventQueueAdmissionLockFixture({
      threadId,
      signal: context.signal,
    });
    // Release the shared admission lock even when an assertion below throws.
    onTestFinished(async () => {
      barrier.release();
      // Await the holding transaction: releasing only resolves its deferred
      // promise, and the lock survives until that transaction actually ends.
      await barrier.done;
    });
    mockNow(secondAnchor + 60_000);
    const ticks = Promise.all([
      accept(
        automationExecutionClient().execute({
          body: { automation_id: brief.automationId },
        }),
        [200],
      ),
      accept(
        automationExecutionClient().execute({
          body: { automation_id: brief.automationId },
        }),
        [200],
      ),
    ]);
    await expect
      .poll(async () => {
        return await barrier.directWaiterCount();
      })
      .toBe(2);
    barrier.release();
    await barrier.done;
    await ticks;

    const claims = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claims).toHaveLength(2);
    expect(claims[1]?.scheduledAnchorAt.getTime()).toBe(secondAnchor);
    expect(claims[1]?.claimSequence).toBe(2);
    expect(claims[0]?.settlement).toBe("completed");
    expect(claims[1]?.settlement).toBe("unsettled");
    // Exactly one canonical queue event belongs to the new occurrence, and it
    // is not the event the first occurrence already consumed.
    expect(claims[1]?.queueEventId).toStrictEqual(expect.any(String));
    expect(claims[1]?.queueEventId).not.toBe(claims[0]?.queueEventId);
    // One canonical queue event per occurrence: the losing tick added none.
    await expect(briefAutomationEventCount(threadId)).resolves.toBe(
      claims.length,
    );
  });

  it("binds the journal through the actual Pi launch composition", async () => {
    const commit = "a".repeat(40);
    mockEnv("GIT_COMMIT_SHA", commit);
    mockEnv(
      "CLI_PKG_URL",
      `https://static.okou.io/okou-cli/${commit}/package.tgz`,
    );
    const brief = await installJournaledBrief(
      "Asia/Shanghai",
      "claude-sonnet-5",
    );
    if (!brief.actor.orgId) {
      throw new Error("Expected an organization-scoped brief owner");
    }
    const gate = holdAgentRunPiExecutionSnapshotFixture({
      userId: brief.actor.userId,
      orgId: brief.actor.orgId,
      signal: context.signal,
    });
    onTestFinished(() => {
      gate.release();
    });
    mockNow(brief.anchor + 60_000);
    const tick = accept(
      automationExecutionClient().execute({
        body: { automation_id: brief.automationId },
      }),
      [200],
    );
    await expect(gate.arrival).resolves.toMatchObject({
      piExecution: true,
    });
    gate.release();
    await tick;

    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    const [runId] = await briefRunIds(threadId);
    expect(runId).toStrictEqual(expect.any(String));
    const claims = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      runId,
      queueDisposition: "claimed",
      settlement: "unsettled",
    });
  });

  it("settles once when concurrent first deliveries of the same completion arrive", async () => {
    const brief = await installJournaledBrief();
    await pollAt(brief.automationId, brief.anchor + 60_000);
    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    const [runId] = await briefRunIds(threadId);
    if (!runId) {
      throw new Error("Expected the occurrence to start a run");
    }

    // Four concurrent initial dispatches: none has been marked delivered yet,
    // so more than one really selects the callback and enters settlement.
    const delivery = await deliverBriefCallback(runId, 4);
    expect(delivery.callbackResults).toBeGreaterThan(1);
    expect(delivery.successfulCallbacks).toBeGreaterThan(1);

    const settled = await readBriefPreference(brief.actor);
    const successor = settled.body.nextRunAt;
    expect(successor).toStrictEqual(expect.any(String));
    const claims = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.settlement).toBe("completed");
    expect(claims[0]?.settledAt).not.toBeNull();

    // Exactly one recurrence step: a second settlement would have advanced
    // past this successor rather than republishing it.
    const expectedSuccessor = briefOccurrenceAfter(
      "0 7 * * *",
      "Asia/Shanghai",
      new Date(brief.anchor + 60_000),
    );
    expect(successor).toBe(expectedSuccessor?.toISOString());
  });

  it("settles an active claim with the timezone edited while it was running", async () => {
    const brief = await installJournaledBrief("Asia/Shanghai");
    await pollAt(brief.automationId, brief.anchor + 60_000);
    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    const [runId] = await briefRunIds(threadId);
    if (!runId) {
      throw new Error("Expected the occurrence to start a run");
    }

    // The claim is active, so the timezone edit deliberately leaves the
    // schedule NULL and its owning completion applies the new zone.
    await accept(
      setupApp({ context, routes: userPreferencesRoutes })(
        userPreferencesContract,
      ).update({
        headers: authHeaders(brief.actor),
        body: { timezone: "America/New_York" },
      }),
      [200],
    );
    const duringClaim = await readBriefPreference(brief.actor);
    expect(duringClaim.body).toMatchObject({
      timezone: "America/New_York",
      nextRunAt: null,
    });

    await deliverBriefCallback(runId);
    const settled = await readBriefPreference(brief.actor);
    expect(settled.body.timezone).toBe("America/New_York");
    if (!settled.body.nextRunAt) {
      throw new Error("Expected the completion to publish the next occurrence");
    }
    expect(
      new Date(settled.body.nextRunAt).toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hour12: false,
      }),
    ).toBe("07");
  });

  /** Cancel an ordinary automation Run and process its callback. */
  async function cancelRunAndFlush(
    actor: ApiTestUser,
    runId: string,
  ): Promise<void> {
    await runs.requestCancelRun(actor, runId, [200]);
    await flushWaitUntilForTest();
  }

  /** Report the real insufficient-credits completion without dispatching it. */
  async function reportInsufficientCreditsCompletion(
    brief: JournaledBrief,
    runId: string,
  ): Promise<void> {
    const sandboxToken = runs.sandboxTokenForRun(brief.actor, runId);
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 1,
        failureReason: "insufficient_credits",
        error: "Insufficient credits. Add credits to continue.",
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `morning-brief-compatibility-${runId}`,
          cliAgentSessionHistoryHash: createHash("sha256")
            .update(`morning brief compatibility ${runId}`)
            .digest("hex"),
        },
      },
      { authorization: `Bearer ${sandboxToken}` },
      [200],
    );
  }

  it("preserves ordinary cron and loop callback behavior", async () => {
    const brief = await installJournaledBrief();
    const ordinaryAgent = await workflowBdd.createAgent(brief.actor);
    onTestFinished(async () => {
      await bdd.deleteAgent(brief.actor, ordinaryAgent.agentId);
    });
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(brief.actor, {
      agentId: ordinaryAgent.agentId,
      name: "ordinary-callback-compatibility",
      visibility: "private",
    });
    const ordinaryLoop = await accept(
      automationClient().create({
        headers: authHeaders(brief.actor),
        params: { workflowId: ordinaryWorkflowId },
        body: { schedule: { type: "loop", intervalSeconds: 300 } },
      }),
      [201],
    );
    if (!ordinaryLoop.body.nextRunAt) {
      throw new Error("Expected ordinary loop next run");
    }
    await pollAt(
      ordinaryLoop.body.id,
      Date.parse(ordinaryLoop.body.nextRunAt) + 1000,
    );
    const firedLoop = await workflowBdd.readAutomation(ordinaryLoop.body.id);
    if (!firedLoop.chatThreadId) {
      throw new Error("Expected ordinary loop chat thread");
    }
    const [loopRunId] = await briefRunIds(firedLoop.chatThreadId);
    if (!loopRunId) {
      throw new Error("Expected ordinary loop Run");
    }
    await cancelRunAndFlush(brief.actor, loopRunId);
    await expect(
      readLegacyAutomation(ordinaryLoop.body.id),
    ).resolves.toMatchObject({
      enabled: true,
      consecutiveFailures: 1,
      nextRunAt: expect.any(Date),
    });

    const ordinaryCron = await accept(
      automationClient().create({
        headers: authHeaders(brief.actor),
        params: { workflowId: ordinaryWorkflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    if (!ordinaryCron.body.nextRunAt) {
      throw new Error("Expected ordinary cron next run");
    }
    mockNow(Date.parse(ordinaryCron.body.nextRunAt) + 60_000);
    await pollAt(ordinaryCron.body.id, now());
    const firedCron = await workflowBdd.readAutomation(ordinaryCron.body.id);
    if (!firedCron.chatThreadId) {
      throw new Error("Expected ordinary cron chat thread");
    }
    const cronRunIds = await briefRunIds(firedCron.chatThreadId);
    const cronRunId = cronRunIds[cronRunIds.length - 1];
    if (!cronRunId || cronRunId === loopRunId) {
      throw new Error("Expected ordinary cron Run");
    }
    await cancelRunAndFlush(brief.actor, cronRunId);
    await expect(
      readLegacyAutomation(ordinaryCron.body.id),
    ).resolves.toMatchObject({
      enabled: true,
      consecutiveFailures: 1,
      nextRunAt: expect.any(Date),
    });
  });

  async function setupRevokedDepartingBriefOccurrence() {
    const kept = await installJournaledBrief();
    await pollAt(kept.automationId, kept.anchor + 60_000);
    const departing = await installJournaledBrief();
    await pollAt(departing.automationId, departing.anchor + 60_000);
    await expect(
      readMorningBriefScheduleClaimsFixture(departing.automationId),
    ).resolves.toHaveLength(1);
    const departingThread = await briefThreadId(
      departing.actor,
      departing.workflowId,
    );
    const [departingRunId] = await briefRunIds(departingThread);
    if (!departingRunId) {
      throw new Error("Expected the departing member's occurrence to run");
    }

    await deliverClerkOrganizationMembershipDeleted(departing.actor);
    const revoked = await readMorningBriefScheduleClaimsFixture(
      departing.automationId,
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      orgId: null,
      ownerUserId: null,
      settlement: "revoked",
    });
    expect(revoked[0]?.settledAt).not.toBeNull();
    return { kept, departing, departingRunId, revoked };
  }

  it("keeps a departed member's in-flight occurrence revoked after callback", async () => {
    const { kept, departing, departingRunId, revoked } =
      await setupRevokedDepartingBriefOccurrence();
    const untouched = await readMorningBriefScheduleClaimsFixture(
      kept.automationId,
    );
    expect(untouched).toHaveLength(1);
    expect(untouched[0]?.settlement).toBe("unsettled");
    expect(untouched[0]?.ownerUserId).toBe(kept.actor.userId);
    const scheduleBefore = await readBriefPreference(departing.actor);
    const delivery = await deliverBriefCallback(departingRunId);
    expect(delivery.callbackResults).toBeGreaterThan(0);
    await expect(readBriefPreference(departing.actor)).resolves.toMatchObject({
      body: { nextRunAt: scheduleBefore.body.nextRunAt },
    });
    const afterCallback = await readMorningBriefScheduleClaimsFixture(
      departing.automationId,
    );
    expect(afterCallback[0]?.settlement).toBe("revoked");
    expect(afterCallback[0]?.settledAt?.getTime()).toBe(
      revoked[0]?.settledAt?.getTime(),
    );
  });

  it("rolls the claim and its queue event back together when the claim transaction fails", async () => {
    const brief = await installJournaledBrief();
    await pollAt(brief.automationId, brief.anchor + 60_000);
    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    const [runId] = await briefRunIds(threadId);
    if (!runId) {
      throw new Error("Expected the first occurrence to start a run");
    }
    await deliverBriefCallback(runId);
    const secondAnchor = Date.parse(
      (await readBriefPreference(brief.actor)).body.nextRunAt ?? "",
    );
    const eventsBefore = await briefAutomationEventCount(threadId);

    // The tick reaches the claim, then fails inside the same transaction that
    // would have inserted its queue event.
    const held = await holdWorkflowAutomationRowFixture({
      automationId: brief.automationId,
      signal: context.signal,
    });
    // An open automation row lock would block unrelated agent deletion later.
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    mockNow(secondAnchor + 60_000);
    const failingTick = accept(
      automationExecutionClient().execute({
        body: { automation_id: brief.automationId },
      }),
      [200],
    );
    await expect
      .poll(async () => {
        return await held.blockedWaiterCount();
      })
      .toBeGreaterThan(0);
    await expect(held.cancelBlockedWaiters()).resolves.toBeGreaterThan(0);
    held.release();
    await held.done;
    await failingTick;

    // Nothing partial survives: the claim and the queue event rolled back
    // together, and the existing failure policy left a real future schedule
    // rather than a permanently NULL hole.
    await expect(
      readMorningBriefScheduleClaimsFixture(brief.automationId),
    ).resolves.toHaveLength(1);
    await expect(briefAutomationEventCount(threadId)).resolves.toBe(
      eventsBefore,
    );
    const recoveredSchedule = await readBriefPreference(brief.actor);
    if (!recoveredSchedule.body.nextRunAt) {
      throw new Error("Expected the failed claim to leave a usable schedule");
    }
    const recoveredAnchor = Date.parse(recoveredSchedule.body.nextRunAt);
    expect(recoveredAnchor).toBeGreaterThan(secondAnchor);
    expect(recoveredSchedule.body.enabled).toBeTruthy();

    // The real cron then records the recovered occurrence on its next tick.
    await pollAt(brief.automationId, recoveredAnchor + 60_000);
    const recovered = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(recovered).toHaveLength(2);
    expect(recovered[1]?.scheduledAnchorAt.getTime()).toBe(recoveredAnchor);
    expect(recovered[1]?.queueEventId).toStrictEqual(expect.any(String));
  });

  it("rolls back the journal binding when a real Run persistence fails", async () => {
    const brief = await installJournaledBrief();
    const fault = await withWorkflowAutomationRunPersistenceFailureFixture({
      automationId: brief.automationId,
      work: async () => {
        await pollAt(brief.automationId, brief.anchor + 60_000);
      },
    });
    expect(fault.attempts).toBe(1);

    const claims = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      runId: null,
      queueDisposition: "queued",
      settlement: "pre_run_failure",
    });
    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    // The scoped fault raises after the real atomic persistence statement, so
    // this empty public projection proves that the Run and its earlier journal
    // binding rolled back with the launch transaction.
    await expect(briefRunIds(threadId)).resolves.toHaveLength(0);
    await expect(readBriefPreference(brief.actor)).resolves.toMatchObject({
      body: { enabled: true, nextRunAt: expect.any(String) },
    });
  });

  it("settles once when a failed-Run callback races the real outer failure path", async () => {
    const brief = await installJournaledBrief();
    const acceptedDefinition =
      await readAcceptedDefinitionFixture("morning-brief");
    await accept(
      storageClient().action({
        body: {
          action: "cleanup-owned-storage-cache",
          storage_id: acceptedDefinition.definition.artifact.storageId,
        },
      }),
      [200],
    );
    context.mocks.s3.getSignedUrl.mockRejectedValue(
      new Error("forced Morning Brief launch preparation failure"),
    );
    const settlementFault = await installMorningBriefSettlementFailureFixture({
      automationId: brief.automationId,
    });
    onTestFinished(settlementFault.release);
    const settlementAttempts = observeMorningBriefSettlementAttemptsFixture({
      automationId: brief.automationId,
    });
    onTestFinished(settlementAttempts.release);
    const committedGate = holdWorkflowAutomationCommittedRunFixture({
      automationId: brief.automationId,
      signal: context.signal,
      rejectOnRelease: true,
    });
    onTestFinished(() => {
      committedGate.release();
    });

    mockNow(brief.anchor + 60_000);
    const tick = setupRawAppRequestWithRoutes({
      context,
      routes: testWorkflowAutomationExecutionRoutes,
    })("/api/test/workflow-automation-execution/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ automation_id: brief.automationId }),
    });
    onTestFinished(async () => {
      committedGate.release();
      await tick;
    });

    // The failed Run's automatic callback enters the real settlement handler.
    // PostgreSQL rejects that update after arrival, so dispatcher bookkeeping
    // persists a retryable callback failure while the occurrence stays open.
    const committed = await committedGate.arrival;
    await expect(settlementFault.readAttempts()).resolves.toBe(1);
    expect(settlementAttempts.readArrivals()).toBe(1);
    const claimsBeforeRace = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claimsBeforeRace[0]).toMatchObject({
      runId: committed.runId,
      queueDisposition: "claimed",
      settlement: "unsettled",
    });

    // Hold the exact row both settlement paths acquire first. The failed
    // callback retry and the post-commit hook's outer failure are independently
    // observed as two blocked PostgreSQL sessions before either can win.
    const held = await holdWorkflowAutomationRowFixture({
      automationId: brief.automationId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const callbackRetry = deliverBriefCallback(committed.runId, 1, "failed");
    await expect.poll(settlementAttempts.readArrivals).toBe(2);
    await expect
      .poll(async () => {
        return await held.blockedWaiterCount();
      })
      .toBe(1);
    committedGate.release();
    // The outer path has entered the same production settlement operation
    // while the callback is observably blocked at its first row lock. A one-
    // connection test pool may queue this transaction client-side, so handler
    // entry—not a second PostgreSQL backend—is the portable overlap barrier.
    await expect.poll(settlementAttempts.readArrivals).toBe(3);
    held.release();
    await held.done;
    const [delivery, tickResponse] = await Promise.all([callbackRetry, tick]);
    expect(tickResponse.status).toBe(200);
    expect(delivery.callbackResults).toBeGreaterThan(0);
    expect(delivery.successfulCallbacks).toBeGreaterThan(0);

    const settled = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(settled).toHaveLength(1);
    expect(["failed", "pre_run_failure"]).toContain(settled[0]?.settlement);
    expect(settled[0]?.settledAt).not.toBeNull();
    const preference = await readBriefPreference(brief.actor);
    expect(preference.body).toMatchObject({
      enabled: true,
      nextRunAt: expect.any(String),
    });
  });

  it("keeps the legacy three-failure auto-disable policy for journaled occurrences", async () => {
    const brief = await installJournaledBrief();
    let anchor = brief.anchor;
    const seenRunIds = new Set<string>();

    for (let failure = 1; failure <= 3; failure += 1) {
      await pollAt(brief.automationId, anchor + 60_000);
      const threadId = await briefThreadId(brief.actor, brief.workflowId);
      const runId = (await briefRunIds(threadId)).find((candidate) => {
        return !seenRunIds.has(candidate);
      });
      if (!runId) {
        throw new Error(`Expected journaled failure Run ${failure}`);
      }
      seenRunIds.add(runId);
      await runs.requestCancelRun(brief.actor, runId, [200]);
      await flushWaitUntilForTest();

      const preference = await readBriefPreference(brief.actor);
      if (failure < 3) {
        expect(preference.body).toMatchObject({
          enabled: true,
          nextRunAt: expect.any(String),
        });
        if (!preference.body.nextRunAt) {
          throw new Error("Expected a successor before the disable threshold");
        }
        anchor = Date.parse(preference.body.nextRunAt);
      } else {
        expect(preference.body).toMatchObject({
          enabled: false,
          nextRunAt: null,
        });
      }
    }

    const claims = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claims).toHaveLength(3);
    expect(
      claims.every((claim) => {
        return claim.settlement === "failed" && claim.settledAt !== null;
      }),
    ).toBeTruthy();
    if (!brief.actor.orgId) {
      throw new Error("Expected an organization-scoped Morning Brief owner");
    }
    await expect(
      readNativeSchedule({
        orgId: brief.actor.orgId,
        userId: brief.actor.userId,
      }),
    ).resolves.toMatchObject({
      enabled: false,
      phase: "legacy",
      ownerEpoch: 2,
      nextRunAt: null,
      scheduleOwner: null,
    });

    // The implementation switch cannot resurrect the deliberately paused
    // choice. Two real native ticks transfer ownership, but admit no slot.
    await setNativeMorningBriefEnabled(brief.actor, true);
    await tickNativeMorningBrief(brief.actor);
    await tickNativeMorningBrief(brief.actor);
    await expect(
      readNativeSchedule({
        orgId: brief.actor.orgId,
        userId: brief.actor.userId,
      }),
    ).resolves.toMatchObject({
      enabled: false,
      phase: "native",
      ownerEpoch: 3,
      nextRunAt: null,
      scheduleOwner: null,
    });
    await expect(
      readNativeOccurrences({
        orgId: brief.actor.orgId,
        userId: brief.actor.userId,
      }),
    ).resolves.toHaveLength(0);
  });

  it("orders cutover before a journaled callback and closes only its drain fact", async () => {
    const brief = await installJournaledBrief();
    await pollAt(brief.automationId, brief.anchor + 60_000);
    const threadId = await briefThreadId(brief.actor, brief.workflowId);
    const [runId] = await briefRunIds(threadId);
    if (!runId || !brief.actor.orgId) {
      throw new Error("Expected one organization-scoped Morning Brief Run");
    }
    await setNativeMorningBriefEnabled(brief.actor, true);
    const held = await holdWorkflowAutomationRowFixture({
      automationId: brief.automationId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });

    // The transition takes durable authority first and blocks on the held
    // automation. The callback arrives second, so it can settle only after the
    // phase has committed as draining.
    const cutover = tickNativeMorningBrief(brief.actor);
    await expect
      .poll(async () => {
        return await held.blockedWaiterCount();
      })
      .toBe(1);
    const attempts = observeMorningBriefSettlementAttemptsFixture({
      automationId: brief.automationId,
    });
    onTestFinished(attempts.release);
    const callback = deliverBriefCallback(runId, 1, "failed");
    await expect.poll(attempts.readArrivals).toBe(1);
    held.release();
    await held.done;
    await Promise.all([cutover, callback]);

    await expect(
      readLegacyAutomation(brief.automationId),
    ).resolves.toMatchObject({
      enabled: true,
      nextRunAt: null,
      consecutiveFailures: 0,
    });
    await expect(
      readNativeSchedule({
        orgId: brief.actor.orgId,
        userId: brief.actor.userId,
      }),
    ).resolves.toMatchObject({
      enabled: true,
      phase: "draining",
      ownerEpoch: 1,
      nextRunAt: null,
      scheduleOwner: null,
    });
    const claims = await readMorningBriefScheduleClaimsFixture(
      brief.automationId,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.settlement).toBe("failed");
  });

  it("removes an uninstalled brief's journal without touching another owner's occurrences", async () => {
    const kept = await installJournaledBrief();
    await pollAt(kept.automationId, kept.anchor + 60_000);
    const removed = await installJournaledBrief();
    await pollAt(removed.automationId, removed.anchor + 60_000);
    await expect(
      readMorningBriefScheduleClaimsFixture(removed.automationId),
    ).resolves.toHaveLength(1);

    await accept(
      installationClient().uninstall({
        headers: authHeaders(removed.actor),
        params: { workflowId: removed.workflowId },
      }),
      [204],
    );

    await expect(
      readMorningBriefScheduleClaimsFixture(removed.automationId),
    ).resolves.toHaveLength(0);
    await expect(
      readMorningBriefScheduleClaimsFixture(kept.automationId),
    ).resolves.toHaveLength(1);
  });

  describe("first native materialization", () => {
    interface PreMaterializationOwner {
      readonly orgId: string;
      readonly userId: string;
    }

    function briefOwner(brief: JournaledBrief): PreMaterializationOwner {
      if (!brief.actor.orgId) {
        throw new Error("Expected an organization-scoped Morning Brief owner");
      }
      return { orgId: brief.actor.orgId, userId: brief.actor.userId };
    }

    /**
     * Put the member back into the state the bootstrap scan exists for: an
     * installed legacy brief, with its real automation and any journaled
     * occurrence intact, that has never been materialized.
     *
     * Every current creation route materializes on enrollment, so no external
     * entry point can produce it. Removing the durable row after the real
     * routes committed is the only way to reach the pre-migration owner the
     * first-materialization boundary is about.
     */
    async function reconstructPreMaterializationOwner(
      owner: PreMaterializationOwner,
    ): Promise<void> {
      await removeMorningBriefNativeScheduleForMigrationFixture(owner);
    }

    /**
     * Start the real bootstrap and stop it at the statement that publishes the
     * first row.
     *
     * The tick holds the owner key and has already sampled the legacy state it
     * is about to publish, so whatever a selected legacy writer does next has to
     * be ordered against it. The returned pid is what the next observation
     * chains onto.
     */
    async function holdBootstrapAtFirstInsert(
      brief: JournaledBrief,
      owner: PreMaterializationOwner,
    ): Promise<{
      readonly bootstrapPid: number;
      readonly finish: () => Promise<void>;
    }> {
      const materialization = await holdMorningBriefFirstMaterialization(
        owner,
        context.signal,
      );
      const tick = tickNativeMorningBrief(brief.actor);
      const bootstrapPid = await materialization.waitForBlocked();
      return {
        bootstrapPid,
        finish: async () => {
          await materialization.release();
          await tick;
        },
      };
    }

    /** The one durable obligation a subsequent real legacy claim consumes. */
    async function consumeDurableObligation(
      brief: JournaledBrief,
      owner: PreMaterializationOwner,
      nextRunAt: Date,
      expectedClaims: number,
    ): Promise<void> {
      await pollAt(brief.automationId, nextRunAt.getTime() + 60_000);
      const claims = await readMorningBriefScheduleClaimsFixture(
        brief.automationId,
      );
      expect(claims).toHaveLength(expectedClaims);
      expect(claims[expectedClaims - 1]?.scheduledAnchorAt).toStrictEqual(
        nextRunAt,
      );
      await expect(readNativeSchedule(owner)).resolves.toMatchObject({
        enabled: true,
        nextRunAt: null,
        scheduleOwner: null,
      });
    }

    /** One real journaled occurrence, left in flight with nothing scheduled. */
    async function startPreMaterializationOccurrence(
      brief: JournaledBrief,
      owner: PreMaterializationOwner,
      anchor: number,
    ): Promise<string> {
      await pollAt(brief.automationId, anchor + 60_000);
      const threadId = await briefThreadId(brief.actor, brief.workflowId);
      const runIds = await briefRunIds(threadId);
      const runId = runIds[runIds.length - 1];
      if (!runId) {
        throw new Error("Expected the occurrence to start a run");
      }
      await expect(
        readLegacyAutomation(brief.automationId),
      ).resolves.toMatchObject({ enabled: true, nextRunAt: null });
      await reconstructPreMaterializationOwner(owner);
      return runId;
    }

    it("orders a journaled completion behind the first materialization it raced", async () => {
      const brief = await installJournaledBrief();
      const owner = briefOwner(brief);
      const runId = await startPreMaterializationOccurrence(
        brief,
        owner,
        brief.anchor,
      );

      const bootstrap = await holdBootstrapAtFirstInsert(brief, owner);
      const callback = deliverBriefCallback(runId);

      // The completion cannot settle under the absent-parent authority it would
      // have read: it waits on the owner key the pending insert holds.
      await waitForDeferredBlocker(bootstrap.bootstrapPid);
      await expect(readNativeSchedule(owner)).resolves.toBeUndefined();

      await bootstrap.finish();
      await callback;

      // The settlement owed the row that appeared while it waited, so both
      // authorities carry the same single successor.
      const legacy = await readLegacyAutomation(brief.automationId);
      expect(legacy).toMatchObject({
        enabled: true,
        consecutiveFailures: 0,
        nextRunAt: expect.any(Date),
      });
      await expect(readNativeSchedule(owner)).resolves.toMatchObject({
        enabled: true,
        phase: "legacy",
        ownerEpoch: 1,
        nextRunAt: legacy?.nextRunAt,
        scheduleOwner: "legacy",
        legacyWorkflowId: brief.workflowId,
        legacyAutomationId: brief.automationId,
      });
      const claims = await readMorningBriefScheduleClaimsFixture(
        brief.automationId,
      );
      expect(claims).toHaveLength(1);
      expect(claims[0]?.settlement).toBe("completed");
      if (!legacy?.nextRunAt) {
        throw new Error("Expected one coherent successor");
      }
      await consumeDurableObligation(brief, owner, legacy.nextRunAt, 2);
    });

    it("keeps insufficient credits non-pausing across the first materialization", async () => {
      const brief = await installJournaledBrief();
      const owner = briefOwner(brief);
      const runId = await startPreMaterializationOccurrence(
        brief,
        owner,
        brief.anchor,
      );

      const bootstrap = await holdBootstrapAtFirstInsert(brief, owner);
      await reportInsufficientCreditsCompletion(brief, runId);
      const callback = flushWaitUntilForTest();
      await waitForDeferredBlocker(bootstrap.bootstrapPid);
      await bootstrap.finish();
      await callback;

      const legacy = await readLegacyAutomation(brief.automationId);
      expect(legacy).toMatchObject({
        enabled: true,
        officialIntendedEnabled: true,
        consecutiveFailures: 0,
        nextRunAt: expect.any(Date),
      });
      await expect(readNativeSchedule(owner)).resolves.toMatchObject({
        enabled: true,
        phase: "legacy",
        ownerEpoch: 1,
        nextRunAt: legacy?.nextRunAt,
        scheduleOwner: "legacy",
      });
    });

    it("lets the current Settings choice win over the first materialization it raced", async () => {
      const brief = await installJournaledBrief();
      const owner = briefOwner(brief);
      await reconstructPreMaterializationOwner(owner);
      const headers = authHeaders(brief.actor);

      const bootstrap = await holdBootstrapAtFirstInsert(brief, owner);
      const paused = accept(
        morningBriefPreferenceClient().update({
          headers,
          body: { enabled: false },
        }),
        [200],
      );
      await waitForDeferredBlocker(bootstrap.bootstrapPid);
      await bootstrap.finish();
      expect((await paused).body).toMatchObject({
        enabled: false,
        nextRunAt: null,
      });

      await expect(
        readLegacyAutomation(brief.automationId),
      ).resolves.toMatchObject({
        enabled: false,
        officialIntendedEnabled: false,
        nextRunAt: null,
      });
      const disabled = await readNativeSchedule(owner);
      expect(disabled).toMatchObject({
        enabled: false,
        phase: "legacy",
        ownerEpoch: 2,
        nextRunAt: null,
        scheduleOwner: null,
      });

      // The durable choice is authority from here: a later tick never resamples
      // the installation it was materialized from.
      await tickNativeMorningBrief(brief.actor);
      await expect(readNativeSchedule(owner)).resolves.toMatchObject({
        enabled: false,
        ownerEpoch: 2,
        nextRunAt: null,
        scheduleOwner: null,
        materializedAt: disabled?.materializedAt,
        membershipId: disabled?.membershipId,
      });

      const resumed = await accept(
        morningBriefPreferenceClient().update({
          headers,
          body: { enabled: true },
        }),
        [200],
      );
      expect(resumed.body).toMatchObject({ enabled: true });
      const legacy = await readLegacyAutomation(brief.automationId);
      await expect(readNativeSchedule(owner)).resolves.toMatchObject({
        enabled: true,
        phase: "legacy",
        ownerEpoch: 3,
        nextRunAt: legacy?.nextRunAt,
        scheduleOwner: "legacy",
      });
    });
  });
});
