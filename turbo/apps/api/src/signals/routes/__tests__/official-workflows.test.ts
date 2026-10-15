import { notificationsContract } from "@okouai/api-contracts/contracts/notifications";
import { notificationsRoutes } from "../notifications";
import { mockClerkUsers } from "./helpers/clerk-users";
import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
import { debugMorningBriefRoutes } from "../debug-morning-brief";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { readPublishedArchive } from "./helpers/published-archive";
import { publicChatActor } from "./helpers/public-chat-actor";
import { claimBudgetRun } from "./helpers/public-autonomy-budget";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  cronExecuteWorkflowAutomationsContract,
  cronOfficialWorkflowCatalogContract,
} from "@okouai/api-contracts/contracts/cron";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
  morningBriefPreferenceContract,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
  type OfficialWorkflowBlueprint,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";

import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomSkillStorageName,
  getOfficialWorkflowDefinitionStorageName,
} from "@okouai/core/storage-names";

import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { acknowledgeDetachedForTest, createDeferredPromise } from "../../utils";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";
import { logsRoutes } from "../logs";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";

import { userPreferencesRoutes } from "../user-preferences";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";

import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";

import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const CRON_SECRET = "official-workflow-installation-cron-secret";
type ActiveDefinition = Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "active" }
>;

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

// Official workflow Runs complete through the native Runner claim protocol,
// so fixtures select Fable, whose personal subscription route never uses Pi.
async function selectPersonalDefaultModel(actor: ApiTestUser): Promise<void> {
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
}

function catalog(
  definitions: OfficialWorkflowSourceCatalog["definitions"],
): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
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

async function syncClient(candidate: unknown) {
  const app = await setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
    isolatePg: true,
  });
  return app(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await accept(
    (await syncClient(candidate)).sync({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
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
    },
  ]);
}

async function syncDeployedCatalog() {
  await syncCatalog(catalog([connectorDoctorDefinition()]));
  return await accept(
    setupApp({ context, routes: cronOfficialWorkflowCatalogRoutes })(
      cronOfficialWorkflowCatalogContract,
    ).sync({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
}

async function executeAutomationCron() {
  await accept(
    setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes })(
      cronExecuteWorkflowAutomationsContract,
    ).execute({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
}

async function fireOfficialSchedule(
  actor: ApiTestUser,
  automation: Pick<WorkflowAutomationSummary, "id" | "nextRunAt">,
) {
  if (!automation.nextRunAt) {
    throw new Error("Expected a scheduled Official Automation");
  }
  await withMockNowForTest(
    new Date(automation.nextRunAt).getTime(),
    async () => {
      await executeAutomationCron();
      await flushWaitUntilForTest();
    },
  );
  const current = await accept(
    automationClient().get({
      headers: authHeaders(actor),
      params: { id: automation.id },
    }),
    [200],
  );
  const chatThreadId = current.body.chatThreadId;
  if (!chatThreadId) {
    throw new Error("Expected the Official Automation thread");
  }
  const runId = await launchedAutomationRunId(actor, chatThreadId);
  if (!runId) {
    throw new Error("Expected the scheduled Official Automation Run");
  }
  return { chatThreadId, runId };
}

function morningBriefPreferenceClient() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
}

function workflowClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function workflowCollectionClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function workflowVisibilityClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowVisibilityContract,
  );
}

function automationClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

async function allThreadEventRows(actor: ApiTestUser, chatThreadId: string) {
  const rows = await chat.listThreadEventRows(actor, chatThreadId);
  let page = rows;
  // The endpoint caps each page at 50; a 32-hop chain spans multiple pages.
  while (page.length === 50) {
    const last = page.at(-1);
    if (!last) {
      throw new Error("Expected a cursor on a full event page");
    }
    page = await chat.listThreadEventRows(actor, chatThreadId, {
      lastEventId: last.id,
      lastSeqId: last.seqId,
    });
    rows.push(...page);
  }
  return rows;
}

/**
 * Run now only enqueues; the background pick launches the run. Flush the pick
 * and read the newest launched run from the automation thread.
 */
async function launchedAutomationRunId(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<string | undefined> {
  await flushWaitUntilForTest();
  const events = await allThreadEventRows(actor, chatThreadId);
  const launched = [...events].reverse().find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  });
  return launched?.runId ?? undefined;
}

/** Every Run the actor can see for one Agent, through the public log list. */
async function listAgentRunLogIds(
  actor: ApiTestUser,
  agentId: string,
): Promise<readonly string[]> {
  const response = await accept(
    setupApp({ context, routes: logsRoutes })(logsListContract).list({
      headers: authHeaders(actor),
      query: { agentId, limit: 100 },
    }),
    [200],
  );
  return response.body.data.map((log) => {
    return log.id;
  });
}

// A failed reconciliation is retried on the app clock; its first backoff is
// one second, so a minute later the retry is due without touching the work row.
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

async function deliverClerkOrganizationMembershipCreated(
  actor: ApiTestUser,
  createdAt: Date,
  membershipId = `membership-${actor.userId}-${actor.orgId}`,
): Promise<void> {
  if (!actor.orgId || !actor.orgRole) {
    throw new Error("Expected organization-scoped Clerk member");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.created",
    data: {
      id: membershipId,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
      role: actor.orgRole,
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
    return MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.some((name) => {
      return name === workflow.official?.definitionName;
    });
  });
}

async function ordinaryDelegationScenario() {
  const owned = await publicChatActor(context);
  return await owned.run(async () => {
    await runs.updateUserModelPreference(owned.actor, "claude-fable-5-1");
    const workflowId = await workflowBdd.createWorkflow(owned.actor, {
      agentId: owned.agentId,
      name: `ordinary-delegation-${randomUUID().slice(0, 8)}`,
    });
    const detail = await accept(
      workflowClient().get({
        headers: authHeaders(owned.actor),
        params: { workflowId },
      }),
      [200],
    );
    const sent = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Delegate a workflow",
    });
    const source = await claimBudgetRun(context, owned, sent);
    return { owned, actor: owned.actor, workflow: detail.body, source };
  });
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
});

describe("Morning Brief preference", () => {
  it("publishes one choice for overlapping Morning Brief disable requests", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    const headers = authHeaders(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the preference installation");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected the Morning Brief automation");
    }
    const responses = await Promise.all([
      accept(
        automationClient().disable({ headers, params: { id: automation.id } }),
        [200, 409],
      ),
      accept(
        automationClient().disable({ headers, params: { id: automation.id } }),
        [200, 409],
      ),
    ]);
    expect(
      responses.some((response) => {
        return response.status === 200;
      }),
    ).toBeTruthy();
    await expect(
      readMorningBriefAutomations(actor, installation.id),
    ).resolves.toMatchObject([
      { enabled: false, nextRunAt: null, official: { intendedEnabled: false } },
    ]);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
  });

  it("preserves enable intent while timezone is unavailable", async () => {
    const missingTimezone = await workflowBdd.setupWorkflowOrg();
    const timezoneHeaders = authHeaders(missingTimezone.actor);
    const unavailableTimezone = await accept(
      morningBriefPreferenceClient().get({ headers: timezoneHeaders }),
      [200],
    );
    expect(unavailableTimezone.body).toMatchObject({
      enabled: false,
      unavailableReason: "missing-timezone",
    });
    const rejectedTimezone = await accept(
      morningBriefPreferenceClient().update({
        headers: timezoneHeaders,
        body: { enabled: true },
      }),
      [200],
    );
    expect(rejectedTimezone.body).toMatchObject({
      status: "preparing",
      enabled: true,
      unavailableReason: "missing-timezone",
    });

    const listed = await accept(
      workflowCollectionClient().list({
        headers: authHeaders(missingTimezone.actor),
        query: {},
      }),
      [200],
    );
    expect(
      listed.body.filter((workflow) => {
        return MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.some((name) => {
          return name === workflow.official?.definitionName;
        });
      }),
    ).toHaveLength(0);
  });
});

async function readMorningBriefAutomations(
  actor: ApiTestUser,
  workflowId: string,
) {
  const response = await accept(
    workflowClient().get({
      headers: authHeaders(actor),
      params: { workflowId },
    }),
    [200],
  );
  return response.body.automations;
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

async function connectBriefSource(actor: ApiTestUser): Promise<void> {
  const onboarding = await bdd.readOnboardingStatus(actor);
  if (!onboarding.defaultAgentId) {
    throw new Error("Expected default Agent");
  }
  mockGmailConnectorOAuth();
  const start = await connectors.startOauth(
    actor,
    "gmail",
    "oauth",
    onboarding.defaultAgentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  await connectors.completeOauthCallback("gmail", {
    code: "brief-code",
    state,
  });
  const membershipRead =
    context.mocks.clerk.organizations.getOrganizationMembershipList.getMockImplementation();
  await runs.enableAgentConnectors(actor, onboarding.defaultAgentId, ["gmail"]);
  if (membershipRead) {
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      membershipRead,
    );
  }
}

async function initializeBriefMember(actor: ApiTestUser, timezone: string) {
  return await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone, locale: "en-US" },
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

/** The member's Official schedule, read through the workflow detail endpoint. */
async function readBriefSchedule(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const [installation] = await listMorningBriefInstallations(actor);
  if (!installation) {
    throw new Error("Expected one Morning Brief installation");
  }
  const [automation] = await readMorningBriefAutomations(
    actor,
    installation.id,
  );
  return {
    nextRunAt: automation?.nextRunAt ?? null,
    timezone:
      automation?.kind === "schedule" && automation.schedule.type !== "loop"
        ? automation.schedule.timezone
        : null,
  };
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
  if (bootstrap) {
    await deliverClerkOrganizationCreated(actor, createdAt);
  }
  return { actor, createdAt };
}

describe("Morning Brief explicit installation", () => {
  it.each(["ordinary-first", "official-first"] as const)(
    "keeps Morning Brief enrollment on the Official identity with same-name user content (%s)",
    async (order) => {
      const { actor } = await prepareBriefMember();
      await initializeBriefMember(actor, "Asia/Shanghai");
      await bdd.completeOnboarding(actor, { timezone: "Asia/Shanghai" });
      const onboarding = await bdd.readOnboardingStatus(actor);
      if (!onboarding.defaultAgentId) {
        throw new Error("Expected the default Agent");
      }
      const headers = authHeaders(actor);
      const enable = () => {
        return accept(
          morningBriefPreferenceClient().update({
            headers,
            body: { enabled: true },
          }),
          [200],
        );
      };
      if (order === "official-first") {
        await enable();
      }
      const ordinaryId = await workflowBdd.createWorkflow(actor, {
        agentId: onboarding.defaultAgentId,
        name: "morning-brief",
        visibility: "private",
        instruction: "The user's Morning Brief instructions",
      });
      if (order === "ordinary-first") {
        await enable();
      }
      const [installation] = await listMorningBriefInstallations(actor);
      if (!installation) {
        throw new Error("Expected the enrolled Official installation");
      }
      expect(installation.id).not.toBe(ordinaryId);
      const [automation] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      expect(automation).toMatchObject({ enabled: true });
      await accept(
        morningBriefPreferenceClient().update({
          headers,
          body: { enabled: false },
        }),
        [200],
      );
      await expect(
        readMorningBriefAutomations(actor, installation.id),
      ).resolves.toMatchObject([{ id: automation?.id, enabled: false }]);
      const ordinary = await accept(
        workflowClient().get({ headers, params: { workflowId: ordinaryId } }),
        [200],
      );
      expect(ordinary.body).toMatchObject({
        id: ordinaryId,
        name: "morning-brief",
        instruction: "The user's Morning Brief instructions",
        official: null,
      });
    },
  );

  it("installs only from the preference toggle, not initialization or onboarding", async () => {
    const { actor } = await prepareBriefMember();
    const headers = authHeaders(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await bdd.completeOnboarding(actor, { timezone: "Asia/Shanghai" });
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    await flushWaitUntilForTest();
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
    const reenabled = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    expect(reenabled.body).toMatchObject({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("reschedules an existing brief after a timezone change and keeps a paused brief paused", async () => {
    const { actor } = await prepareBriefMember();
    await connectBriefSource(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [before] = await listMorningBriefInstallations(actor);
    await bdd.updateUserTimezone(actor, "America/Los_Angeles");
    const changed = await readBriefPreference(actor);
    expect(changed.body).toMatchObject({
      enabled: true,
      status: "enabled",
    });
    const changedSchedule = await readBriefSchedule(actor);
    expect(changedSchedule.timezone).toBe("America/Los_Angeles");
    expect(changedSchedule.nextRunAt).not.toBeNull();
    if (!changedSchedule.nextRunAt) {
      throw new Error("Expected next run");
    }
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        hour12: false,
      }).format(new Date(changedSchedule.nextRunAt)),
    ).toBe("07");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    await initializeBriefMember(actor, "Asia/Shanghai");
    const [after] = await listMorningBriefInstallations(actor);
    expect(after?.id).toBe(before?.id);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    await expect(readBriefSchedule(actor)).resolves.toStrictEqual({
      timezone: "Asia/Tokyo",
      nextRunAt: null,
    });
  });

  it("installs a rejoined member's brief from their explicit preference", async () => {
    const owner = await prepareBriefMember({
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const actor = bdd.user({ orgId: owner.actor.orgId, orgRole: "org:member" });
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await deliverClerkOrganizationMembershipDeleted(actor);
    await deliverClerkOrganizationMembershipCreated(
      actor,
      new Date(createdAt.getTime() + 1000),
      `rejoined-${actor.userId}-${actor.orgId}`,
    );
    await initializeBriefMember(actor, "Asia/Shanghai");
    const enabled = await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({
      status: "enabled",
      enabled: true,
      unavailableReason: null,
    });
    expect((await readBriefPreference(actor)).body).toMatchObject({
      status: "enabled",
      enabled: true,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("keeps an explicit timezone choice when initialization runs later", async () => {
    const { actor } = await prepareBriefMember();
    const invalid = await setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone: "Invalid/Timezone", locale: "en-US" },
    });
    expect(invalid.status).toBe(400);
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    const initialized = await initializeBriefMember(
      actor,
      "America/Los_Angeles",
    );
    expect(initialized.body.timezone).toBe("Asia/Tokyo");
    const saved = await accept(
      setupApp({ context, routes: userPreferencesRoutes })(
        userPreferencesContract,
      ).get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body.timezone).toBe("Asia/Tokyo");
  });
});

function capturedOfficialSkill(
  manifest: Parameters<typeof expectCanonicalStorageManifest>[0],
  definitionName: string,
) {
  const mount = expectCanonicalStorageManifest(manifest)?.storageMounts.find(
    (entry) => {
      return (
        entry.name === getOfficialWorkflowDefinitionStorageName(definitionName)
      );
    },
  );
  if (!mount) {
    throw new Error(`Expected captured Official skill: ${definitionName}`);
  }
  const archive = context.mocks.s3.send.mock.calls
    .flatMap(([command]) => {
      if (
        !(command instanceof PutObjectCommand) ||
        !command.input.Key?.endsWith(`/${mount.versionId}/archive.tar.gz`) ||
        !(command.input.Body instanceof Uint8Array)
      ) {
        return [];
      }
      return [command.input.Body];
    })
    .at(-1);
  if (!archive) {
    throw new Error("Expected the exact captured skill publication");
  }
  return gunzipSync(archive).toString("utf8");
}

describe("Morning Brief suggestion instruction rollout", () => {
  it.each([
    { enabled: false, expected: false },
    { enabled: true, expected: true },
  ])(
    "scopes suggestion guidance to enabled=$enabled scheduled runs",
    async ({ enabled, expected }) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        installCatalogStorageFixture();
        await syncDeployedCatalog();

        const { actor } = await workflowBdd.setupWorkflowOrg({
          timezone: "Asia/Shanghai",
        });
        if (!actor.orgId) {
          throw new Error("Expected an organization-scoped actor");
        }
        await connectBriefSource(actor);
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: enabled },
        );
        await accept(
          morningBriefPreferenceClient().update({
            headers: authHeaders(actor),
            body: { enabled: true },
          }),
          [200],
        );
        const [installation] = await listMorningBriefInstallations(actor);
        if (!installation) {
          throw new Error("Expected the primary Morning Brief installation");
        }
        const [automation] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!automation) {
          throw new Error("Expected a Morning Brief schedule");
        }
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        await runs.heartbeatRunner(runnerGroup);
        const { runId } = await fireOfficialSchedule(actor, automation);
        const claim = await runs.claimRunnerJob(runId);
        onTestFinished(async () => {
          await webhooks.requestAgentComplete(
            {
              runId,
              exitCode: 1,
              error: "Morning Brief suggestion fixture cleanup",
            },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
          await flushWaitUntilForTest();
        });
        expect(claim.appendSystemPrompt).not.toContain("okou suggestion");
        const definitionName = expected
          ? "internal-test-morning-brief"
          : "morning-brief";
        expect(claim.prompt).toMatch(new RegExp(`^/${definitionName}\\n`));
        const mountedSkill = capturedOfficialSkill(
          claim.storageManifest,
          definitionName,
        );
        expect(mountedSkill.includes("okou suggestion list --json")).toBe(
          expected,
        );
        if (expected) {
          expect(mountedSkill).toContain(
            "Before completing the briefing or making its email decision",
          );
          expect(mountedSkill).toContain(
            "There may be zero to ten active suggestions",
          );
        }
      });
    },
  );
});

describe("Debug Morning Brief", () => {
  function debugClient() {
    return setupApp({ context, routes: debugMorningBriefRoutes })(
      debugMorningBriefContract,
    );
  }
  async function enabledBrief() {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    await selectPersonalDefaultModel(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    if (!actor.orgId) {
      throw new Error("Expected a workspace");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.OkouDebug]: true },
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected Morning Brief");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected a daily schedule");
    }
    return { actor, installation, automation };
  }
  it.each([false, true])(
    "executes the selected Official skill with suggestions enabled=%s, deduplicates retries and preserves the daily schedule",
    async (enabled) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        const { actor, installation, automation } = await enabledBrief();
        if (!actor.orgId) {
          throw new Error("Expected a workspace");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: enabled },
        );
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        await runs.heartbeatRunner(runnerGroup);
        const requestId = randomUUID();
        const requestHeaders = authHeaders(actor);
        const submissions = await Promise.all(
          Array.from({ length: enabled ? 1 : 4 }, () => {
            return accept(
              debugClient().run({
                headers: requestHeaders,
                body: { requestId: requestId.toUpperCase() },
              }),
              [200],
            );
          }),
        );
        const requested = submissions[0];
        if (!requested) {
          throw new Error("Expected an accepted Debug request");
        }
        for (const submission of submissions) {
          expect(submission.body).toMatchObject({
            requestId,
            chatThreadId: requested.body.chatThreadId,
          });
        }
        expect(requested.body).toMatchObject({ requestId, status: "queued" });
        const retryHeaders = authHeaders(actor);
        const replayed = await Promise.all(
          Array.from({ length: 3 }, () => {
            return debugClient().run({
              headers: retryHeaders,
              body: { requestId },
            });
          }),
        );
        for (const replay of replayed) {
          expect(replay).toMatchObject({
            status: 200,
            body: { requestId, chatThreadId: requested.body.chatThreadId },
          });
        }
        await flushWaitUntilForTest();
        const receipt = await accept(
          debugClient().get({
            headers: authHeaders(actor),
            params: { id: requestId },
          }),
          [200],
        );
        const runId = receipt.body.runId;
        if (!runId) {
          throw new Error("Expected a real Agent Run");
        }
        expect(
          (
            await accept(
              debugClient().run({
                headers: authHeaders(actor),
                body: { requestId },
              }),
              [200],
            )
          ).body,
        ).toStrictEqual(receipt.body);
        const claim = await runs.claimRunnerJob(runId);
        const name = enabled ? "internal-test-morning-brief" : "morning-brief";
        mockEnv("RESEND_API_KEY", "test-key");
        mockEnv("RESEND_FROM_DOMAIN", "okou.io");
        mockClerkUsers(context, [
          {
            id: actor.userId,
            primaryEmailAddressId: "primary",
            emailAddresses: [{ id: "primary", emailAddress: actor.email }],
          },
        ]);
        const notifications = setupApp({
          context,
          routes: notificationsRoutes,
        })(notificationsContract);
        const notificationHeaders = {
          authorization: `Bearer ${okouTokenFromClaim(claim)}`,
        };
        const brief = {
          kind: "morning-brief" as const,
          to: "me" as const,
          subject: "Debug Morning Brief",
          text: "Verified briefing.",
        };
        const notification = await accept(
          notifications.mail({ headers: notificationHeaders, body: brief }),
          [200],
        );
        expect(notification.body).toMatchObject({
          status: "queued",
          deduplicated: false,
        });
        // The automation event, not an agent-supplied key, identifies the email.
        expect(
          (
            await accept(
              notifications.mail({
                headers: notificationHeaders,
                body: { ...brief, idempotencyKey: `debug-brief:${requestId}` },
              }),
              [200],
            )
          ).body,
        ).toStrictEqual({ ...notification.body, deduplicated: true });
        await accept(
          notifications.mail({
            headers: notificationHeaders,
            body: { ...brief, text: "A regenerated briefing." },
          }),
          [409],
        );
        expect(claim.prompt.split("\n")[0]).toBe(`/${name}`);
        expect(claim.prompt).toContain("morning-brief-debug");
        expect(claim.appendSystemPrompt).not.toContain("okou suggestion");
        expect(
          capturedOfficialSkill(claim.storageManifest, name).includes(
            "okou suggestion list --json",
          ),
        ).toBe(enabled);
        expect(
          (await readMorningBriefAutomations(actor, installation.id))[0],
        ).toMatchObject({
          id: automation.id,
          nextRunAt: automation.nextRunAt,
          enabled: true,
          schedule: automation.schedule,
        });
        if (enabled) {
          await createChatEventsFixture(context).completeChatRunOk(runId, {
            authorization: `Bearer ${claim.sandboxToken}`,
          });
        } else {
          await webhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Debug brief finished" },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
        }
        await flushWaitUntilForTest();
        expect(
          (
            await accept(
              debugClient().get({
                headers: authHeaders(actor),
                params: { id: requestId },
              }),
              [200],
            )
          ).body,
        ).toMatchObject({ runId, status: enabled ? "completed" : "failed" });
        expect(
          (await readMorningBriefAutomations(actor, installation.id))[0],
        ).toMatchObject({
          nextRunAt: automation.nextRunAt,
          enabled: true,
        });
      });
    },
  );
  it("preserves a scheduled occurrence queued behind a Debug run", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor, installation, automation } = await enabledBrief();
      if (!automation.nextRunAt) {
        throw new Error("Expected a daily anchor");
      }
      // Cross the due boundary without expiring the Debug run's sandbox JWT.
      mockNow(new Date(new Date(automation.nextRunAt).getTime() - 60_000));
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      const requestId = randomUUID();
      const requested = await accept(
        debugClient().run({ headers: authHeaders(actor), body: { requestId } }),
        [200],
      );
      await flushWaitUntilForTest();
      const receipt = await accept(
        debugClient().get({
          headers: authHeaders(actor),
          params: { id: requestId },
        }),
        [200],
      );
      const debugRunId = receipt.body.runId;
      if (!debugRunId || !automation.nextRunAt) {
        throw new Error("Expected a debug run and daily anchor");
      }
      const debugClaim = await runs.claimRunnerJob(debugRunId);
      mockEnv("RESEND_API_KEY", "test-key");
      mockEnv("RESEND_FROM_DOMAIN", "okou.io");
      mockClerkUsers(context, [
        {
          id: actor.userId,
          primaryEmailAddressId: "primary",
          emailAddresses: [{ id: "primary", emailAddress: actor.email }],
        },
      ]);
      // Run-token requests re-read membership once the mocked schedule clock
      // has outlived the cached member role.
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              role: actor.orgRole ?? "org:member",
              organization: { id: actor.orgId },
            },
          ],
        },
      );
      const sendBrief = async (claim: typeof debugClaim) => {
        return (
          await accept(
            setupApp({ context, routes: notificationsRoutes })(
              notificationsContract,
            ).mail({
              headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
              body: {
                kind: "morning-brief",
                to: "me",
                subject: "Morning Brief",
                text: "Verified briefing.",
              },
            }),
            [200],
          )
        ).body;
      };
      const debugBrief = await sendBrief(debugClaim);
      expect(debugBrief).toMatchObject({
        status: "queued",
        deduplicated: false,
      });
      await withMockNowForTest(new Date(automation.nextRunAt), async () => {
        await executeAutomationCron();
        await flushWaitUntilForTest();
        expect(
          (await readMorningBriefAutomations(actor, installation.id))[0]
            ?.nextRunAt,
        ).toBeNull();
        await webhooks.requestAgentComplete(
          {
            runId: debugRunId,
            exitCode: 1,
            error: "Debug finished before scheduled run",
          },
          { authorization: `Bearer ${debugClaim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        const pending = (
          await readMorningBriefAutomations(actor, installation.id)
        )[0];
        expect(pending?.nextRunAt).toBeNull();
        const scheduledRunId = await launchedAutomationRunId(
          actor,
          requested.body.chatThreadId,
        );
        if (!scheduledRunId || scheduledRunId === debugRunId) {
          throw new Error("Expected the queued scheduled run");
        }
        const scheduledClaim = await runs.claimRunnerJob(scheduledRunId);
        // Each automation event sends its own email, even with identical content.
        const scheduledBrief = await sendBrief(scheduledClaim);
        expect(scheduledBrief).toMatchObject({
          status: "queued",
          deduplicated: false,
        });
        expect(scheduledBrief.notificationId).not.toBe(
          debugBrief.notificationId,
        );
        await createChatEventsFixture(context).completeChatRunOk(
          scheduledRunId,
          { authorization: `Bearer ${scheduledClaim.sandboxToken}` },
        );
        await flushWaitUntilForTest();
        const settled = (
          await readMorningBriefAutomations(actor, installation.id)
        )[0];
        expect(settled?.nextRunAt).not.toBeNull();
        expect(settled?.enabled).toBeTruthy();
      });
    });
  });
  it("requires a signed-in session and Okou Debug", async () => {
    const anonymous = await accept(
      debugClient().run({ body: { requestId: randomUUID() } }),
      [401],
    );
    expect(anonymous.status).toBe(401);
    await accept(debugClient().get({ params: { id: randomUUID() } }), [401]);
    const { actor } = await enabledBrief();
    if (!actor.orgId) {
      throw new Error("Expected a workspace");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.OkouDebug]: false },
    );
    await accept(
      debugClient().run({
        headers: authHeaders(actor),
        body: { requestId: randomUUID() },
      }),
      [403],
    );
    await accept(
      debugClient().get({
        headers: authHeaders(actor),
        params: { id: randomUUID() },
      }),
      [403],
    );
  });
  it("does not enable a paused schedule or consume an in-flight scheduled occurrence", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor, installation, automation } = await enabledBrief();
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: false },
        }),
        [200],
      );
      await accept(
        debugClient().run({
          headers: authHeaders(actor),
          body: { requestId: randomUUID() },
        }),
        [409],
      );
      expect(
        (await readMorningBriefAutomations(actor, installation.id))[0]?.enabled,
      ).toBeFalsy();
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      const fired = await fireOfficialSchedule(actor, automation);
      const claim = await runs.claimRunnerJob(fired.runId);
      onTestFinished(async () => {
        await webhooks.requestAgentComplete(
          { runId: fired.runId, exitCode: 1, error: "Scheduled brief cleanup" },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });
      await accept(
        debugClient().run({
          headers: authHeaders(actor),
          body: { requestId: randomUUID() },
        }),
        [409],
      );
      expect(
        (await readMorningBriefAutomations(actor, installation.id))[0]
          ?.nextRunAt,
      ).toBeNull();
    });
  });
  it("scopes request receipts to their member and workspace", async () => {
    const { actor } = await enabledBrief();
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    await runs.heartbeatRunner(runnerGroup);
    const requestId = randomUUID();
    await accept(
      debugClient().run({ headers: authHeaders(actor), body: { requestId } }),
      [200],
    );
    await flushWaitUntilForTest();
    const { actor: other } = await enabledBrief();
    await accept(
      debugClient().get({
        headers: authHeaders(other),
        params: { id: requestId },
      }),
      [404],
    );
    await accept(
      debugClient().run({ headers: authHeaders(other), body: { requestId } }),
      [409],
    );
    expect(
      (
        await accept(
          debugClient().get({
            headers: authHeaders(actor),
            params: { id: requestId },
          }),
          [200],
        )
      ).body.requestId,
    ).toBe(requestId);
  });
});

describe("Morning Brief workflow selection", () => {
  it("switches an existing schedule both ways without replacing settings or conversation", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor } = await prepareBriefMember();
      await initializeBriefMember(actor, "Asia/Tokyo");
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const [installation] = await listMorningBriefInstallations(actor);
      if (!installation || !actor.orgId) {
        throw new Error("Expected a Morning Brief installation");
      }
      const [initial] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!initial) {
        throw new Error("Expected its schedule");
      }
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      let conversation: string | undefined;
      for (const [iteration, enabled] of [false, true, false].entries()) {
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: enabled },
        );
        const [schedule] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!schedule?.nextRunAt) {
          throw new Error("Expected retained schedule");
        }
        expect(schedule).toMatchObject({
          id: initial.id,
          enabled: true,
          schedule: { timezone: "Asia/Tokyo" },
        });
        const fired = await fireOfficialSchedule(actor, schedule);
        if (conversation) {
          expect(fired.chatThreadId).toBe(conversation);
        }
        conversation = fired.chatThreadId;
        const claim = await withMockNowForTest(
          new Date(schedule.nextRunAt),
          () => {
            return runs.claimRunnerJob(fired.runId);
          },
        );
        const name = enabled ? "internal-test-morning-brief" : "morning-brief";
        expect(claim.prompt).toMatch(new RegExp(`^/${name}\\n`));
        expect(claim.appendSystemPrompt).not.toContain("okou suggestion");
        expect(
          capturedOfficialSkill(claim.storageManifest, name).includes(
            "okou suggestion list --json",
          ),
        ).toBe(enabled);
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          { id: installation.id, official: { definitionName: name } },
        ]);
        expect((await readBriefPreference(actor)).body).toMatchObject({
          enabled: true,
          status: "enabled",
        });
        if (iteration === 0) {
          await updateFeatureSwitchesForUser(
            context,
            { ...actor, orgId: actor.orgId },
            { [FeatureSwitchKey.AgentSuggestion]: true },
          );
          await withMockNowForTest(
            new Date(schedule.nextRunAt),
            executeAutomationCron,
          );
          await expect(
            listMorningBriefInstallations(actor),
          ).resolves.toMatchObject([
            {
              id: installation.id,
              official: { definitionName: "morning-brief" },
            },
          ]);
        }
        await withMockNowForTest(new Date(schedule.nextRunAt), async () => {
          await webhooks.requestAgentComplete(
            { runId: fired.runId, exitCode: 0 },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
          await flushWaitUntilForTest();
        });
      }
    });
  });

  it("keeps paused briefs paused and admits one occurrence across concurrent rollout ticks", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor } = await prepareBriefMember();
      await initializeBriefMember(actor, "Asia/Shanghai");
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const [installation] = await listMorningBriefInstallations(actor);
      if (!installation) {
        throw new Error("Expected installed brief");
      }
      const [initial] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!initial) {
        throw new Error("Expected a schedule");
      }
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: false },
        }),
        [200],
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId },
        { [FeatureSwitchKey.AgentSuggestion]: true },
      );
      await executeAutomationCron();
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: false,
        status: "paused",
      });
      await expect(
        readMorningBriefAutomations(actor, installation.id),
      ).resolves.toMatchObject([
        { id: initial.id, enabled: false, nextRunAt: null },
      ]);
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const [schedule] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!schedule?.nextRunAt) {
        throw new Error("Expected resumed schedule");
      }
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      await withMockNowForTest(new Date(schedule.nextRunAt), async () => {
        await Promise.all([executeAutomationCron(), executeAutomationCron()]);
        await flushWaitUntilForTest();
      });
      const [running] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!running?.chatThreadId) {
        throw new Error("Expected a delivery thread");
      }
      const runId = await launchedAutomationRunId(actor, running.chatThreadId);
      if (!runId) {
        throw new Error("Expected its scheduled Run");
      }
      const onboarding = await bdd.readOnboardingStatus(actor);
      if (!onboarding.defaultAgentId) {
        throw new Error("Expected Okou");
      }
      await expect(
        listAgentRunLogIds(actor, onboarding.defaultAgentId),
      ).resolves.toStrictEqual([runId]);
      const claim = await withMockNowForTest(
        new Date(schedule.nextRunAt),
        () => {
          return runs.claimRunnerJob(runId);
        },
      );
      expect(claim.prompt).toMatch(/^\/internal-test-morning-brief\n/);
      await expect(
        readMorningBriefAutomations(actor, installation.id),
      ).resolves.toMatchObject([{ id: initial.id, nextRunAt: null }]);
      await withMockNowForTest(new Date(schedule.nextRunAt), async () => {
        await webhooks.requestAgentComplete(
          { runId, exitCode: 0 },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "enabled",
      });
    });
  });
});

describe("Official schedule expiry", () => {
  async function readAutomation(actor: ApiTestUser, id: string) {
    const response = await accept(
      automationClient().get({ headers: authHeaders(actor), params: { id } }),
      [200],
    );
    return response.body;
  }

  it("preserves a claimed Morning Brief occurrence across later ticks and duplicate Runner completion", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      installCatalogStorageFixture();
      await syncDeployedCatalog();
      const { actor } = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
      });
      await connectBriefSource(actor);
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const [installation] = await listMorningBriefInstallations(actor);
      if (!installation?.agentId) {
        throw new Error("Expected the member's Morning Brief Agent");
      }
      const [automation] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!automation?.nextRunAt) {
        throw new Error("Expected the Morning Brief anchor");
      }
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      mockNow(Date.parse(automation.nextRunAt) + 30 * 60_000);
      await executeAutomationCron();
      await flushWaitUntilForTest();
      const runIds = await listAgentRunLogIds(actor, installation.agentId);
      expect(runIds).toHaveLength(1);
      const runId = runIds[0];
      if (!runId) {
        throw new Error("Expected the scheduled Morning Brief Run");
      }
      const claim = await runs.claimRunnerJob(runId);
      const completion = () => {
        return webhooks.requestAgentComplete(
          { runId, exitCode: 1, error: "Morning Brief Runner completion" },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
      };
      onTestFinished(async () => {
        await completion();
      });
      mockNow(now() + 60 * 60_000);
      await executeAutomationCron();
      await expect(readAutomation(actor, automation.id)).resolves.toMatchObject(
        {
          enabled: true,
          nextRunAt: null,
        },
      );
      await expect(
        listAgentRunLogIds(actor, installation.agentId),
      ).resolves.toStrictEqual(runIds);
      await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
        status: "running",
      });
      await completion();
      await flushWaitUntilForTest();
      const settled = await readAutomation(actor, automation.id);
      expect(settled.nextRunAt).not.toBeNull();
      if (!settled.nextRunAt) {
        throw new Error("Expected the successor Morning Brief anchor");
      }
      expect(Date.parse(settled.nextRunAt)).toBeGreaterThan(now());
      await completion();
      await executeAutomationCron();
      await expect(readAutomation(actor, automation.id)).resolves.toStrictEqual(
        settled,
      );
      await expect(
        listAgentRunLogIds(actor, installation.agentId),
      ).resolves.toStrictEqual(runIds);
    });
  });
});

describe("Official Workflow installations", () => {
  it("names a new Morning Brief thread in the default locale", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    await selectPersonalDefaultModel(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the preference installation");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected the Morning Brief Automation");
    }

    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const started = await fireOfficialSchedule(actor, automation);
    await expect(
      chat.readThreadMetadata(actor, started.chatThreadId),
    ).resolves.toMatchObject({ title: "Okou Morning Brief" });
    await runs.requestCancelRun(actor, started.runId, [200, 400]);
  });

  it("rejects manual runs and ordinary workflow and automation mutations of an Official installation", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Tokyo");
    const headers = authHeaders(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the preference installation");
    }
    const [dailyAutomation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!dailyAutomation) {
      throw new Error("Expected the Morning Brief Automation");
    }
    const firstWorkflowId = installation.id;
    const agentId = installation.agentId;
    const composer = await accept(
      workflowCollectionClient().composer({
        headers,
        query: { agentId },
      }),
      [200],
    );
    expect(
      composer.body.map((workflow) => {
        return workflow.id;
      }),
    ).not.toContain(firstWorkflowId);
    const manualRuns = [
      await accept(
        workflowClient().run({
          headers,
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: firstWorkflowId },
        }),
        [409],
      ),
      await accept(
        automationClient().run({
          headers,
          params: { id: dailyAutomation.id },
        }),
        [409],
      ),
    ];
    for (const response of manualRuns) {
      expect(response.body.error.message).toBe(
        "Official Workflows can only run through their automatic triggers",
      );
    }
    await accept(
      workflowClient().update({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { displayName: "Forged edit" },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().publish({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().demote({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    const forked = await accept(
      workflowClient().copy({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { toAgentId: agentId },
      }),
      [201],
    );
    expect(forked.body).toMatchObject({
      name: installation.name,
      official: null,
      visibility: "private",
    });
    expect(forked.body.id).not.toBe(firstWorkflowId);
    await accept(
      workflowClient().chatThread({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowClient().delete({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      automationClient().create({
        headers,
        params: { workflowId: firstWorkflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().update({
        headers,
        params: { id: dailyAutomation.id },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().delete({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [409],
    );

    const unchanged = await accept(
      workflowClient().get({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [200],
    );
    expect(unchanged.body).toMatchObject({
      id: firstWorkflowId,
      official: { definitionName: "morning-brief" },
      automations: [{ id: dailyAutomation.id }],
      shadowedBy: expect.objectContaining({ id: forked.body.id }),
    });
  });
});

describe("Official Workflow Run admission", () => {
  it("pins ordinary Workflow publications across a normal revision", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(() => {
      return fixture.api.updateUserModelPreference(
        owned.actor,
        "claude-fable-5-1",
      );
    });
    const published: {
      workflowId: string;
      archive: ReturnType<typeof readPublishedArchive>;
    }[] = [];
    for (const name of ["first", "retained"]) {
      const start = context.mocks.s3.send.mock.calls.length;
      const workflowId = await owned.run(() => {
        return workflowBdd.createWorkflow(owned.actor, {
          agentId: owned.agentId,
          name: `published-${name}-${randomUUID().slice(0, 8)}`,
          instruction: `Read the ${name} publication.`,
        });
      });
      published.push({
        workflowId,
        archive: readPublishedArchive(context, start),
      });
    }
    const firstWorkflow = published[0];
    const retainedWorkflow = published[1];
    if (!firstWorkflow || !retainedWorkflow) {
      throw new Error("Expected two published Workflows");
    }
    const first = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use both original Workflow publications",
    });
    const updateStart = context.mocks.s3.send.mock.calls.length;
    await owned.run(() => {
      return accept(
        workflowClient().update({
          headers: authHeaders(owned.actor),
          params: { workflowId: firstWorkflow.workflowId },
          body: {
            instruction: "Read the revised first publication.",
            files: [],
          },
        }),
        [200],
      );
    });
    const updated = readPublishedArchive(context, updateStart);
    expect(updated.versionId).not.toBe(firstWorkflow.archive.versionId);
    const check = async (runId: string, expected: typeof published) => {
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        runId,
      );
      const mounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return expected.some((workflow) => {
            return (
              mount.name === getCustomSkillStorageName(workflow.workflowId)
            );
          });
        }) ?? [];
      expect(mounts).toHaveLength(2);
      for (const workflow of expected) {
        expect(mounts).toContainEqual(
          expect.objectContaining({
            name: getCustomSkillStorageName(workflow.workflowId),
            versionId: workflow.archive.versionId,
            archiveSize: workflow.archive.archiveSize,
            archiveUrl: expect.any(String),
          }),
        );
      }
      await owned.run(() => {
        return fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Workflow publications inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    };
    await check(first.runId, published);
    const later = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use the updated and retained Workflow publications",
    });
    await check(later.runId, [
      { ...firstWorkflow, archive: updated },
      retainedWorkflow,
    ]);
  });

  it("launches an idle ordinary workflow input with source annotations", async () => {
    const { owned, actor, workflow, source } =
      await ordinaryDelegationScenario();
    const sourceRunId = source.runId;
    const sourceThreadId = source.threadId;
    await owned.run(async () => {
      const launched = await accept(
        workflowClient().run({
          headers: { authorization: `Bearer ${source.token}` },
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: workflow.id },
        }),
        [200],
      );
      expect(launched.body.runId).toBeNull();
      const launchedRunId = await launchedAutomationRunId(
        actor,
        launched.body.chatThreadId,
      );
      if (!launchedRunId) {
        throw new Error(
          "Expected the idle ordinary workflow input to dispatch itself",
        );
      }
      expect(launchedRunId).not.toBe(sourceRunId);
      expect(launched.body.chatThreadId).not.toBe(sourceThreadId);
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        launchedRunId,
      );
      expect(claim.prompt).toBe(`/${workflow.name}`);
      expect(claim.appendSystemPrompt).toContain(
        `SOURCE_RUN_ID: ${sourceRunId}`,
      );
      expect(claim.appendSystemPrompt).toContain(
        `SOURCE_THREAD_ID: ${sourceThreadId}`,
      );
    });
  });
});
