import { createPublicAutomationResultEmailApi } from "./helpers/public-automation-result-email";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  scopedReviewContract,
  scopedReviewRoutes,
} from "../test-get-started-rewards";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readGetStartedStatus } from "./helpers/get-started";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
  type WorkflowCreateRequest,
  type WorkflowUpdateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { chatThreadRoutes } from "../chat-threads";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
  mockGoogleFormsConnectorOAuth,
  mockStripeConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { extractFilesFromTarGz } from "../../../lib/tar";
import {
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import {
  readWorkflowAutomationAutonomyFixture,
  setRunAutonomyBudgetFixture,
  setWorkflowAutomationAutonomyBudgetFixture,
} from "./helpers/runtime-state";

const context = testContext({ connectorCatalog: true });
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const miscApi = createMiscRoutesApi(context);
const mocks = createRouteMocks(context);
const api = createRunsApi(context);
const publicResults = createPublicAutomationResultEmailApi(context);
const connectorApi = createConnectorBddApi(context);
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

type StaffFixture =
  | {
      readonly kind: "workflow";
      readonly actor: ApiTestUser;
      readonly workflowId: string;
    }
  | {
      readonly kind: "agent";
      readonly actor: ApiTestUser;
      readonly agentId: string;
    };

async function cleanupStaffFixture(fixture: StaffFixture): Promise<void> {
  switch (fixture.kind) {
    case "workflow": {
      await miscApi.deleteWorkflow(fixture.actor, fixture.workflowId, [204]);
      return;
    }
    case "agent": {
      await bdd.deleteAgent(fixture.actor, fixture.agentId);
      return;
    }
  }
}

const trackStaffFixture =
  createFixtureTracker<StaffFixture>(cleanupStaffFixture);

function registerStaffFixture(fixture: StaffFixture): Promise<StaffFixture> {
  return trackStaffFixture(Promise.resolve(fixture));
}

function user(options: ApiTestUserOptions = {}): ApiTestUser {
  return bdd.user(options);
}

function authHeaders(actor: ApiTestUser): { readonly authorization: string } {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function collectionClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

/**
 * Runs read back from a workflow thread. A workflow run only enqueues its
 * slash command; background picks bind launched inputs to their runs.
 */
async function readLaunchedWorkflowRunIds(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<readonly string[]> {
  await flushWaitUntilForTest();
  const { events } = await chat.listThreadEvents(actor, chatThreadId);
  return [
    ...new Set(
      events.flatMap((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined
          ? [event.runId]
          : [];
      }),
    ),
  ];
}

async function runWorkflowAndLaunch(
  actor: ApiTestUser,
  workflowId: string,
): Promise<{ readonly chatThreadId: string; readonly runId: string }> {
  const sent = await accept(
    detailClient().run({
      headers: authHeaders(actor),
      params: { workflowId },
    }),
    [200],
  );
  expect(sent.body.runId).toBeNull();
  const runIds = await readLaunchedWorkflowRunIds(
    actor,
    sent.body.chatThreadId,
  );
  const runId = runIds.at(-1);
  if (runId === undefined) {
    throw new Error("Expected the workflow run to launch");
  }
  return { chatThreadId: sent.body.chatThreadId, runId };
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

function installVolumeS3Fixture() {
  const objects = new Map<string, Buffer>();
  const writes: { readonly key: string; readonly body: Buffer }[] = [];
  let beforeNextArchiveWrite:
    | ((key: string, body: Buffer) => void | Promise<void>)
    | undefined;

  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = s3BodyBuffer(command.input.Body);
      if (key.endsWith("/archive.tar.gz") && beforeNextArchiveWrite) {
        const callback = beforeNextArchiveWrite;
        beforeNextArchiveWrite = undefined;
        await callback(key, body);
      }
      objects.set(key, body);
      writes.push({ key, body });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = objects.get(key);
      if (!body) {
        throw missingS3Object(key);
      }
      return { ContentLength: body.length };
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = objects.get(key);
      if (!body) {
        throw missingS3Object(key);
      }
      return { Body: Readable.from([body]), ContentLength: body.length };
    }
    return {};
  });

  return {
    objects,
    writes,
    clearWrites(): void {
      writes.length = 0;
    },
    beforeNextArchiveWrite(
      callback: (key: string, body: Buffer) => void | Promise<void>,
    ): void {
      beforeNextArchiveWrite = callback;
    },
  };
}

function visibilityClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowVisibilityContract,
  );
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

async function createAgent(
  actor: ApiTestUser,
  body: Parameters<typeof bdd.createAgent>[1] = {},
) {
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, body);
  if (actor.orgId === STAFF_ORG_ID) {
    await registerStaffFixture({
      kind: "agent",
      actor,
      agentId: agent.agentId,
    });
  }
  return agent;
}

async function createWorkflow(actor: ApiTestUser, body: WorkflowCreateRequest) {
  const workflow = await accept(
    collectionClient().create({
      headers: authHeaders(actor),
      body,
    }),
    [201],
  );
  if (actor.orgId === STAFF_ORG_ID) {
    await registerStaffFixture({
      kind: "workflow",
      actor,
      workflowId: workflow.body.id,
    });
  }
  return workflow;
}

async function enableWorkflowRuns(actor: ApiTestUser): Promise<void> {
  await api.grantProEntitlement(actor);
  // Fable keeps workflow runs on the claimable native Runner route.
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  api.configureRunnerGroup();
}

async function connectGoogleCalendarAccount(
  actor: ApiTestUser,
  agentId: string,
  args: {
    readonly accessToken: string;
    readonly email: string;
    readonly subject: string;
    readonly account?: { readonly intent: "add"; readonly displayName: string };
  },
) {
  mockGoogleCalendarConnectorOAuth({
    accessToken: args.accessToken,
    email: args.email,
    subject: args.subject,
  });
  const start = await connectorApi.startOauth(
    actor,
    "google-calendar",
    "oauth",
    agentId,
    args.account,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Calendar OAuth state");
  }
  await connectorApi.completeOauthCallback("google-calendar", {
    code: `google-calendar-copy-${randomUUID()}`,
    state,
  });
  const accounts = await connectorApi.listBuiltinConnectorAccounts(
    actor,
    "google-calendar",
  );
  const account = accounts.find((candidate) => {
    return candidate.externalEmail === args.email;
  });
  if (!account) {
    throw new Error(`Expected Google Calendar account ${args.email}`);
  }
  return account;
}

async function requestCreateWorkflow<
  TStatus extends 400 | 401 | 403 | 404 | 409,
>(
  actor: ApiTestUser,
  body: WorkflowCreateRequest,
  statuses: readonly TStatus[],
) {
  return await accept(
    collectionClient().create({
      headers: authHeaders(actor),
      body,
    }),
    statuses,
  );
}

async function updateWorkflow(
  actor: ApiTestUser,
  workflowId: string,
  body: WorkflowUpdateRequest,
) {
  return await accept(
    detailClient().update({
      headers: authHeaders(actor),
      params: { workflowId },
      body,
    }),
    [200],
  );
}

async function requestUpdateWorkflow<
  TStatus extends 400 | 401 | 403 | 404 | 409,
>(
  actor: ApiTestUser,
  workflowId: string,
  body: WorkflowUpdateRequest,
  statuses: readonly TStatus[],
) {
  return await accept(
    detailClient().update({
      headers: authHeaders(actor),
      params: { workflowId },
      body,
    }),
    statuses,
  );
}

function names(workflows: readonly { readonly name: string }[]): string[] {
  return workflows.map((workflow) => {
    return workflow.name;
  });
}

describe("workflows", () => {
  it("creates private workflows by default and hides them from other org members", async () => {
    const owner = user();
    const otherMember = user({ orgId: owner.orgId, orgRole: "org:member" });
    const agent = await createAgent(owner, {
      displayName: "Owner Agent",
      visibility: "private",
    });

    const created = await createWorkflow(owner, {
      agentId: agent.agentId,
      name: `owner-workflow-${randomUUID().slice(0, 8)}`,
      displayName: "Owner Workflow",
      instruction: "# owner workflow",
    });

    expect(created.body).toMatchObject({
      displayName: "Owner Workflow",
      visibility: "private",
      ownerUserId: owner.userId,
      agentId: agent.agentId,
      canManage: true,
      canPublish: true,
    });

    const ownerList = await accept(
      collectionClient().list({ headers: authHeaders(owner) }),
      [200],
    );
    expect(names(ownerList.body)).toContain(created.body.name);

    const memberList = await accept(
      collectionClient().list({ headers: authHeaders(otherMember) }),
      [200],
    );
    expect(names(memberList.body)).not.toContain(created.body.name);
  });

  it("allows workflow names removed from the built-in seed set", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Former Seed Skill Agent",
      visibility: "private",
    });

    const created = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: "deep-dive",
      displayName: "Deep Dive",
      instruction: "# custom deep dive workflow",
    });

    expect(created.body).toMatchObject({
      agentId: agent.agentId,
      name: "deep-dive",
      displayName: "Deep Dive",
      ownerUserId: actor.userId,
    });
  });

  it("runs a workflow slash command with workflow timing attribution", async () => {
    const actor = user({ orgRole: "org:admin" });
    await api.grantProEntitlement(actor);
    const provider = await miscApi.upsertOrgModelProvider(
      actor,
      { type: "openai-api-key", secret: "workflow-openai-key" },
      [201],
    );
    if (provider.status !== 201) {
      throw new Error("Expected the workflow OpenAI provider to be created");
    }
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        preferred: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: provider.body.provider.id,
      },
    ]);
    const agent = await createAgent(actor, {
      displayName: "Workflow Runner Agent",
      visibility: "private",
    });
    const runnerGroup = api.configureRunnerGroup();

    const created = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `run-attribution-workflow-${randomUUID().slice(0, 8)}`,
      displayName: "Run Attribution Workflow",
      instruction: "# run attribution workflow",
    });
    const prepared = await accept(
      detailClient().chatThread({
        headers: authHeaders(actor),
        params: { workflowId: created.body.id },
      }),
      [200],
    );

    const run = await runWorkflowAndLaunch(actor, created.body.id);
    expect(run.chatThreadId).toBe(prepared.body.chatThreadId);

    const queued = await accept(
      detailClient().run({
        headers: authHeaders(actor),
        params: { workflowId: created.body.id },
      }),
      [200],
    );
    expect(queued.body).toStrictEqual({
      chatThreadId: run.chatThreadId,
      runId: null,
    });
    // The busy thread keeps the second invocation queued behind the first run.
    await expect(
      readLaunchedWorkflowRunIds(actor, run.chatThreadId),
    ).resolves.toStrictEqual([run.runId]);

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    expect(claim.cliAgentType).toBe("codex");
    expect(claim.environment?.OPENAI_MODEL).toBe("gpt-6-astra");
    expect(claim.environment?.ANTHROPIC_MODEL).toBeUndefined();
    await api.requestCancelRun(actor, run.runId, [200]);
  });

  it("resolves concurrent first workflow runs to one automation thread", async () => {
    const actor = user({ orgRole: "org:admin" });
    await enableWorkflowRuns(actor);
    const agent = await createAgent(actor, {
      displayName: "Concurrent Workflow Agent",
      visibility: "private",
    });
    const created = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `concurrent-run-workflow-${randomUUID().slice(0, 8)}`,
      displayName: "Concurrent Run Workflow",
      instruction: "# concurrent run workflow",
    });
    const client = detailClient();
    const headers = authHeaders(actor);

    const runs = await Promise.all([
      accept(
        client.run({
          headers,
          params: { workflowId: created.body.id },
        }),
        [200],
      ),
      accept(
        client.run({
          headers,
          params: { workflowId: created.body.id },
        }),
        [200],
      ),
    ]);

    expect(
      new Set(
        runs.map((run) => {
          return run.body.chatThreadId;
        }),
      ).size,
    ).toBe(1);
    const [firstRun] = runs;
    const runIds = await readLaunchedWorkflowRunIds(
      actor,
      firstRun.body.chatThreadId,
    );
    // The shared thread launches one run; the other invocation queues behind it.
    expect(runIds).toHaveLength(1);
    for (const runId of runIds) {
      await api.requestCancelRun(actor, runId, [200]);
    }
  });

  it("runs public workflows for members and hides workflows on private agents", async () => {
    const owner = user({ orgRole: "org:admin" });
    const member = user({ orgId: owner.orgId, orgRole: "org:member" });
    await bdd.completeOnboarding(member);
    await enableWorkflowRuns(owner);
    if (!owner.orgId) {
      throw new Error("Expected a workflow owner organization");
    }
    // A member's workflow thread starts from their own model preference.
    await chat.updateUserModelPreference(member, "claude-fable-5-1");

    const publicAgent = await createAgent(owner, {
      displayName: "Public Workflow Agent",
      visibility: "public",
    });
    const publicWorkflow = await createWorkflow(owner, {
      agentId: publicAgent.agentId,
      name: `public-run-workflow-${randomUUID().slice(0, 8)}`,
      visibility: "public",
      instruction: "# public run workflow",
    });

    const publicRun = await runWorkflowAndLaunch(
      member,
      publicWorkflow.body.id,
    );

    const privateAgent = await createAgent(owner, {
      displayName: "Hidden Private Workflow Agent",
      visibility: "private",
    });
    const privateWorkflow = await createWorkflow(owner, {
      agentId: privateAgent.agentId,
      name: `private-run-workflow-${randomUUID().slice(0, 8)}`,
      visibility: "public",
      instruction: "# private run workflow",
    });
    const hidden = await accept(
      detailClient().run({
        headers: authHeaders(member),
        params: { workflowId: privateWorkflow.body.id },
      }),
      [404],
    );
    expect(hidden.body.error.code).toBe("NOT_FOUND");

    await api.requestCancelRun(member, publicRun.runId, [200]);
  });

  it("requires agent write-permission to create public workflows under an agent", async () => {
    const owner = user();
    const member = user({ orgId: owner.orgId, orgRole: "org:member" });
    const agent = await createAgent(owner, {
      displayName: "Public Agent",
      visibility: "public",
    });
    const workflowName = `public-workflow-${randomUUID().slice(0, 8)}`;

    const rejected = await requestCreateWorkflow(
      member,
      {
        agentId: agent.agentId,
        name: workflowName,
        visibility: "public",
        instruction: "# public workflow",
      },
      [403],
    );
    expect(rejected.body).toStrictEqual({
      error: {
        message:
          "Only the agent owner or org admin can create workflows on this agent",
        code: "FORBIDDEN",
      },
    });

    const created = await createWorkflow(owner, {
      agentId: agent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# public workflow",
    });
    expect(created.body).toMatchObject({
      name: workflowName,
      visibility: "public",
      canManage: true,
      canPublish: false,
    });

    const memberList = await accept(
      collectionClient().list({ headers: authHeaders(member) }),
      [200],
    );
    expect(memberList.body).toContainEqual(
      expect.objectContaining({
        name: workflowName,
        visibility: "public",
        canManage: false,
        canPublish: false,
      }),
    );
  });

  it("allows members to create private workflows under visible public agents", async () => {
    const agentOwner = user();
    const member = user({
      orgId: agentOwner.orgId,
      orgRole: "org:member",
    });
    const otherMember = user({
      orgId: agentOwner.orgId,
      orgRole: "org:member",
    });
    const agent = await createAgent(agentOwner, {
      displayName: "Shared Agent",
      visibility: "public",
    });
    const workflowName = `member-private-workflow-${randomUUID().slice(0, 8)}`;

    const created = await createWorkflow(member, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Member Private Workflow",
      instruction: "# member private workflow",
    });

    expect(created.body).toMatchObject({
      agentId: agent.agentId,
      name: workflowName,
      visibility: "private",
      ownerUserId: member.userId,
      canManage: true,
      canPublish: false,
    });

    const updated = await updateWorkflow(member, created.body.id, {
      displayName: "Updated Member Private Workflow",
    });
    expect(updated.body).toMatchObject({
      id: created.body.id,
      displayName: "Updated Member Private Workflow",
      canManage: true,
    });

    await requestUpdateWorkflow(
      agentOwner,
      created.body.id,
      { displayName: "Agent Owner Update" },
      [404],
    );

    const memberList = await accept(
      collectionClient().list({ headers: authHeaders(member) }),
      [200],
    );
    expect(memberList.body).toContainEqual(
      expect.objectContaining({
        id: created.body.id,
        name: workflowName,
        canManage: true,
      }),
    );

    const agentOwnerList = await accept(
      collectionClient().list({ headers: authHeaders(agentOwner) }),
      [200],
    );
    expect(names(agentOwnerList.body)).not.toContain(workflowName);

    const otherMemberList = await accept(
      collectionClient().list({ headers: authHeaders(otherMember) }),
      [200],
    );
    expect(names(otherMemberList.body)).not.toContain(workflowName);
  });

  it("binds a newly created workflow only to a current matching agent chat thread", async () => {
    const actor = user();
    const sourceAgent = await createAgent(actor, {
      displayName: "Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Target Agent",
      visibility: "private",
    });
    const sourceThread = await chat.createThread(actor, {
      agentId: sourceAgent.agentId,
      title: "Source chat",
    });

    context.mocks.ably.publish.mockClear();
    const sourceWorkflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      chatThreadId: sourceThread.id,
      name: `source-workflow-${randomUUID().slice(0, 8)}`,
      instruction: "# source workflow",
    });
    const preparedSource = await accept(
      detailClient().chatThread({
        headers: authHeaders(actor),
        params: { workflowId: sourceWorkflow.body.id },
      }),
      [200],
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadWorkflowsChanged:${sourceThread.id}`,
      null,
    );
    expect(preparedSource.body.chatThreadId).toBe(sourceThread.id);
    expect(preparedSource.body.prompt).toBe(
      `help me refine the workflow /${sourceWorkflow.body.name}`,
    );

    context.mocks.ably.publish.mockClear();
    const targetWorkflow = await createWorkflow(actor, {
      agentId: targetAgent.agentId,
      chatThreadId: sourceThread.id,
      name: `target-workflow-${randomUUID().slice(0, 8)}`,
      instruction: "# target workflow",
    });
    const preparedTarget = await accept(
      detailClient().chatThread({
        headers: authHeaders(actor),
        params: { workflowId: targetWorkflow.body.id },
      }),
      [200],
    );
    expect(preparedTarget.body.chatThreadId).not.toBe(sourceThread.id);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadWorkflowsChanged:${sourceThread.id}`,
      null,
    );
  });

  it("creates a workflow when its chat thread notification fails", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Realtime Failure Agent",
      visibility: "private",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Realtime failure chat",
    });

    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("Ably unavailable"),
    );

    const created = await createWorkflow(actor, {
      agentId: agent.agentId,
      chatThreadId: thread.id,
      name: `realtime-failure-workflow-${randomUUID().slice(0, 8)}`,
      instruction: "# realtime failure workflow",
    });

    expect(created.body.agentId).toBe(agent.agentId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadWorkflowsChanged:${thread.id}`,
      null,
    );
  });

  it("protects public workflow slugs while allowing private overrides", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Unique Slug Agent",
      visibility: "public",
    });
    const otherAgent = await createAgent(actor, {
      displayName: "Other Unique Slug Agent",
      visibility: "public",
    });
    const workflowName = `shared-workflow-${randomUUID().slice(0, 8)}`;

    const publicWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Public Workflow",
      visibility: "public",
      instruction: "# shared workflow",
    });
    const privateWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Private Workflow",
      instruction: "# private override",
    });
    await createWorkflow(actor, {
      agentId: otherAgent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# other agent workflow",
    });

    const duplicate = await requestCreateWorkflow(
      actor,
      {
        agentId: agent.agentId,
        name: workflowName,
        visibility: "public",
        instruction: "# duplicate public workflow",
      },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `/${workflowName}" already exists on this agent`,
    );

    const scopedList = await accept(
      collectionClient().list({
        headers: authHeaders(actor),
        query: { agentId: agent.agentId },
      }),
      [200],
    );
    expect(scopedList.body).toContainEqual(
      expect.objectContaining({
        id: publicWorkflow.body.id,
        shadowedBy: {
          id: privateWorkflow.body.id,
          name: workflowName,
          displayName: "Private Workflow",
        },
      }),
    );
    expect(scopedList.body).toContainEqual(
      expect.objectContaining({
        id: privateWorkflow.body.id,
        shadowedBy: null,
      }),
    );
  });

  it("lists only the agent's unshadowed workflows with composer fields", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Composer Workflow Agent",
      visibility: "public",
    });
    const otherAgent = await createAgent(actor, {
      displayName: "Other Composer Workflow Agent",
      visibility: "public",
    });
    const workflowName = `composer-workflow-${randomUUID().slice(0, 8)}`;

    const publicWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Public Workflow",
      visibility: "public",
      instruction: "# shared workflow",
    });
    const privateWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      displayName: "Private Workflow",
      description: "Private override",
      instruction: "# private override",
    });
    const otherAgentWorkflow = await createWorkflow(actor, {
      agentId: otherAgent.agentId,
      name: `other-${workflowName}`,
      instruction: "# other agent workflow",
    });

    const composerList = await accept(
      collectionClient().composer({
        headers: authHeaders(actor),
        query: { agentId: agent.agentId },
      }),
      [200],
    );

    expect(composerList.body).toContainEqual({
      id: privateWorkflow.body.id,
      name: workflowName,
      displayName: "Private Workflow",
      description: "Private override",
    });
    const listedIds = composerList.body.map((workflow) => {
      return workflow.id;
    });
    expect(listedIds).not.toContain(publicWorkflow.body.id);
    expect(listedIds).not.toContain(otherAgentWorkflow.body.id);
  });

  it("rejects same-owner private workflow slugs while allowing other-owner private slugs", async () => {
    const actor = user();
    const other = user({ orgId: actor.orgId, orgRole: "org:member" });
    const agent = await createAgent(actor, {
      displayName: "Private Slug Agent",
      visibility: "public",
    });
    const workflowName = `private-workflow-${randomUUID().slice(0, 8)}`;

    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# private workflow",
    });

    const duplicate = await requestCreateWorkflow(
      actor,
      {
        agentId: agent.agentId,
        name: workflowName,
        instruction: "# duplicate private workflow",
      },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${workflowName}"`,
    );

    const otherPrivate = await createWorkflow(other, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# other user private workflow",
    });
    expect(otherPrivate.body).toMatchObject({
      agentId: agent.agentId,
      name: workflowName,
      ownerUserId: other.userId,
      visibility: "private",
    });
  });

  it("renames workflow slugs through metadata update and rejects duplicate public slugs", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Rename Agent",
      visibility: "public",
    });
    const existingName = `existing-workflow-${randomUUID().slice(0, 8)}`;
    const renamedName = `renamed-workflow-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: existingName,
      visibility: "public",
      instruction: "# existing workflow",
    });
    const source = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `rename-source-${randomUUID().slice(0, 8)}`,
      visibility: "public",
      displayName: "Rename Source",
      description: "Original description",
      instruction: "# rename source",
    });

    const renamed = await updateWorkflow(actor, source.body.id, {
      name: renamedName,
      displayName: "Renamed Workflow",
      description: "Use when workflow metadata needs a new slug.",
    });
    expect(renamed.body).toMatchObject({
      name: renamedName,
      displayName: "Renamed Workflow",
      description: "Use when workflow metadata needs a new slug.",
    });

    const duplicate = await requestUpdateWorkflow(
      actor,
      source.body.id,
      { name: existingName },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `/${existingName}" already exists on this agent`,
    );
  });

  it("rejects renaming a private workflow to another same-owner private slug", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Private Rename Agent",
      visibility: "public",
    });
    const existingName = `private-existing-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: existingName,
      instruction: "# existing private workflow",
    });
    const source = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `private-rename-source-${randomUUID().slice(0, 8)}`,
      instruction: "# source private workflow",
    });

    const duplicate = await requestUpdateWorkflow(
      actor,
      source.body.id,
      { name: existingName },
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${existingName}"`,
    );
  });

  it("rejects publishing a private workflow when the public slug is already taken", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Publish Conflict Agent",
      visibility: "public",
    });
    const workflowName = `publish-conflict-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# public workflow",
    });
    const privateWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# private workflow",
    });

    const response = await accept(
      visibilityClient().publish({
        headers: authHeaders(actor),
        params: { workflowId: privateWorkflow.body.id },
      }),
      [409],
    );
    expect(response.body.error.message).toContain(
      `/${workflowName}" already exists on this agent`,
    );
  });

  it("rejects publication while the current private-scope volume update is unfinished", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Pending Publication Agent",
      visibility: "public",
    });
    const s3 = installVolumeS3Fixture();
    const workflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `pending-publication-${randomUUID().slice(0, 8)}`,
      instruction: "# original private workflow",
    });
    const signal = AbortSignal.timeout(10_000);
    const uploadEntered = createDeferredPromise<void>(signal);
    const uploadReleased = createDeferredPromise<void>(signal);
    s3.beforeNextArchiveWrite(async () => {
      uploadEntered.resolve();
      await uploadReleased.promise;
    });

    const update = updateWorkflow(actor, workflow.body.id, {
      instruction: "# metadata committed before this volume",
    });
    await uploadEntered.promise;
    const blocked = await accept(
      visibilityClient().publish({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [409],
    );
    expect(blocked.body.error.message).toBe(
      "Workflow changed during publish; retry the request",
    );

    uploadReleased.resolve();
    await expect(update).resolves.toMatchObject({ status: 200 });
    await expect(
      accept(
        visibilityClient().publish({
          headers: authHeaders(actor),
          params: { workflowId: workflow.body.id },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { visibility: "public" } });
  });

  it("keeps concurrent Workflow instruction updates on the same Agent", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Concurrent Workflow Agent",
      visibility: "public",
    });
    installVolumeS3Fixture();
    const first = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `first-update-${randomUUID().slice(0, 8)}`,
      instruction: "# first original",
    });
    const second = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `second-update-${randomUUID().slice(0, 8)}`,
      instruction: "# second original",
    });

    await Promise.all([
      updateWorkflow(actor, first.body.id, { instruction: "# first updated" }),
      updateWorkflow(actor, second.body.id, {
        instruction: "# second updated",
      }),
    ]);

    for (const [workflowId, instruction] of [
      [first.body.id, "# first updated"],
      [second.body.id, "# second updated"],
    ] as const) {
      const current = await accept(
        detailClient().get({
          headers: authHeaders(actor),
          params: { workflowId },
        }),
        [200],
      );
      expect(current.body).toMatchObject({ instruction });
    }
  });

  it("makes a deleted Agent's Workflow unavailable for reading, editing and publishing", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Deleted Workflow Agent",
      visibility: "public",
    });
    const workflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `deleted-agent-${randomUUID().slice(0, 8)}`,
      instruction: "# removed with its Agent",
    });

    await bdd.deleteAgent(actor, agent.agentId);

    const missing = await accept(
      detailClient().get({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [404],
    );
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    await requestUpdateWorkflow(
      actor,
      workflow.body.id,
      { instruction: "# cannot restore a deleted Workflow" },
      [404],
    );
    await accept(
      visibilityClient().publish({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [404],
    );
  });

  it("rejects copying a workflow when the caller already has that private slug on the target agent", async () => {
    const actor = user();
    const sourceAgent = await createAgent(actor, {
      displayName: "Private Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Private Copy Target Agent",
      visibility: "private",
    });
    const workflowName = `copy-conflict-${randomUUID().slice(0, 8)}`;
    const source = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: workflowName,
      instruction: "# source workflow",
    });
    await createWorkflow(actor, {
      agentId: targetAgent.agentId,
      name: workflowName,
      instruction: "# existing private workflow",
    });

    const duplicate = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: source.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${workflowName}"`,
    );
  });

  it("publishes one complete copy when different source workflows compete for the same private slug", async () => {
    const actor = user();
    const firstSourceAgent = await createAgent(actor, {
      displayName: "First Concurrent Copy Source",
      visibility: "private",
    });
    const secondSourceAgent = await createAgent(actor, {
      displayName: "Second Concurrent Copy Source",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Concurrent Copy Target",
      visibility: "private",
    });
    const workflowName = `concurrent-copy-${randomUUID().slice(0, 8)}`;
    const sources = await Promise.all(
      [firstSourceAgent, secondSourceAgent].map(async (agent, index) => {
        const instruction = `# Source workflow ${index + 1}`;
        const created = await createWorkflow(actor, {
          agentId: agent.agentId,
          name: workflowName,
          visibility: "private",
          instruction,
        });
        return { workflowId: created.body.id, instruction };
      }),
    );

    const copies = await Promise.all(
      sources.map(async (source) => {
        const response = await accept(
          detailClient().copy({
            headers: authHeaders(actor),
            params: { workflowId: source.workflowId },
            body: { toAgentId: targetAgent.agentId },
          }),
          [201, 409],
        );
        return { source, response };
      }),
    );
    expect(
      copies
        .map((copy) => {
          return copy.response.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);
    const winner = copies.find((copy) => {
      return copy.response.status === 201;
    });
    const rejected = copies.find((copy) => {
      return copy.response.status === 409;
    });
    if (winner?.response.status !== 201 || rejected?.response.status !== 409) {
      throw new Error("Expected one successful copy and one name conflict");
    }
    expect(rejected.response.body.error.message).toContain(
      `private workflow named "/${workflowName}"`,
    );

    const targetWorkflows = await accept(
      collectionClient().list({
        headers: authHeaders(actor),
        query: { agentId: targetAgent.agentId },
      }),
      [200],
    );
    expect(targetWorkflows.body).toHaveLength(1);
    expect(targetWorkflows.body[0]).toMatchObject({
      id: winner.response.body.id,
      name: workflowName,
      visibility: "private",
    });
    for (const workflow of [
      ...sources,
      {
        workflowId: winner.response.body.id,
        instruction: winner.source.instruction,
      },
    ]) {
      const current = await accept(
        detailClient().get({
          headers: authHeaders(actor),
          params: { workflowId: workflow.workflowId },
        }),
        [200],
      );
      expect(current.body).toMatchObject({
        name: workflowName,
        instruction: workflow.instruction,
        official: null,
      });
    }
  });

  it("rejects demoting a public workflow when the owner already has that private slug", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Private Demote Agent",
      visibility: "public",
    });
    const workflowName = `demote-conflict-${randomUUID().slice(0, 8)}`;
    await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      instruction: "# existing private workflow",
    });
    const publicWorkflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: workflowName,
      visibility: "public",
      instruction: "# public workflow",
    });

    const duplicate = await accept(
      visibilityClient().demote({
        headers: authHeaders(actor),
        params: { workflowId: publicWorkflow.body.id },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain(
      `private workflow named "/${workflowName}"`,
    );
  });

  it("copies workflows and caller-owned automations through the API", async () => {
    const actor = user();
    if (!actor.orgId) {
      throw new Error("Expected workflow copy actor to belong to an org");
    }
    await api.grantProEntitlement(actor, { tier: "team" });
    // Event Automation creation pins its shared thread model immediately.
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const sourceAgent = await createAgent(actor, {
      displayName: "Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `copy-source-${randomUUID().slice(0, 8)}`,
      instruction: "# copy source",
    });
    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 900 },
        },
      }),
      [201],
    );
    const webhookAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "webhook-received",
        },
      }),
      [201],
    );
    expect(webhookAutomation.body).toMatchObject({
      kind: "event",
      eventType: "webhook-received",
    });
    const runnerGroup = api.configureRunnerGroup();
    api.acceptTelemetryIngest();
    publicResults.configureDelivery(actor);
    onTestFinished(async () => {
      await publicResults.cleanup(actor);
      const cleanupBdd = createBddApi(context);
      cleanupBdd.acceptAgentStorageWrites();
      await cleanupBdd.deleteAgent(actor, sourceAgent.agentId);
      await cleanupBdd.deleteAgent(actor, targetAgent.agentId);
    });
    const sourceRun = await publicResults.start(
      actor,
      automation.body.id,
      runnerGroup,
    );
    await publicResults.complete(actor, sourceRun.runId, runnerGroup, {
      output: "Ordinary source result",
    });
    await publicResults.drain(sourceRun.runId, automation.body.id);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
    const copied = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    expect(copied.body).toMatchObject({
      agentId: targetAgent.agentId,
      name: workflow.body.name,
      ownerUserId: actor.userId,
    });
    expect(copied.body.id).not.toBe(workflow.body.id);

    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    expect(copiedAutomations.body).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        ownerUserId: actor.userId,
        enabled: automation.body.enabled,
      }),
    );
    const copiedSchedule = copiedAutomations.body.find((copiedAutomation) => {
      return copiedAutomation.kind === "schedule";
    });
    if (!copiedSchedule) {
      throw new Error("Expected the copied schedule automation");
    }
    expect(
      copiedAutomations.body.some((copiedAutomation) => {
        return (
          copiedAutomation.kind === "event" &&
          copiedAutomation.eventType === "webhook-received"
        );
      }),
    ).toBeTruthy();
    const copiedRun = await publicResults.start(
      actor,
      copiedSchedule.id,
      runnerGroup,
    );
    await publicResults.complete(actor, copiedRun.runId, runnerGroup, {
      output: "Ordinary copied result",
    });
    await publicResults.drain(copiedRun.runId, copiedSchedule.id);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("copies schedule-only workflows without binding a chat thread", async () => {
    const actor = user();
    const sourceAgent = await createAgent(actor, {
      displayName: "Schedule Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Schedule Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `schedule-copy-${randomUUID().slice(0, 8)}`,
      instruction: "# schedule copy source",
    });
    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 900 },
        },
      }),
      [201],
    );
    expect(automation.body.chatThreadId).toBeNull();

    const copied = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );

    expect(copiedAutomations.body).toHaveLength(1);
    expect(copiedAutomations.body[0]).toMatchObject({
      kind: "schedule",
      chatThreadId: null,
    });
  });

  it("rebinds copied Gmail automations to the target thread default account", async () => {
    const actor = user();
    if (!actor.orgId) {
      throw new Error("Expected Gmail workflow copy actor to belong to an org");
    }
    await api.grantProEntitlement(actor, { tier: "team" });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {},
    );
    const sourceAgent = await createAgent(actor, {
      displayName: "Gmail Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Gmail Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `gmail-copy-${randomUUID().slice(0, 8)}`,
      instruction: "# Gmail copy source",
    });

    mockOptionalEnv(
      "GMAIL_PUBSUB_TOPIC_NAME",
      "projects/vm0-ai-488909/topics/gmail-events",
    );
    const watchedTokens: string[] = [];
    server.use(
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        ({ request }) => {
          const authorization = request.headers.get("authorization");
          if (!authorization) {
            throw new Error("Expected Gmail watch authorization");
          }
          watchedTokens.push(authorization);
          return HttpResponse.json({
            historyId: String(watchedTokens.length),
            expiration: "4102444800000",
          });
        },
      ),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const firstEmail = `gmail-copy-first-${randomUUID()}@example.test`;
    mockGmailConnectorOAuth({
      accessToken: "gmail-copy-first-token",
      email: firstEmail,
      subject: `gmail-copy-first-${randomUUID()}`,
    });
    const firstStart = await connectorApi.startOauth(
      actor,
      "gmail",
      "oauth",
      sourceAgent.agentId,
    );
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!firstState) {
      throw new Error("Expected first Gmail OAuth state");
    }
    await connectorApi.completeOauthCallback("gmail", {
      code: "gmail-copy-first-code",
      state: firstState,
    });

    const secondEmail = `gmail-copy-second-${randomUUID()}@example.test`;
    mockGmailConnectorOAuth({
      accessToken: "gmail-copy-second-token",
      email: secondEmail,
      subject: `gmail-copy-second-${randomUUID()}`,
    });
    const secondStart = await connectorApi.startOauth(
      actor,
      "gmail",
      "oauth",
      sourceAgent.agentId,
      { intent: "add", displayName: "Gmail Copy Second" },
    );
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!secondState) {
      throw new Error("Expected second Gmail OAuth state");
    }
    await connectorApi.completeOauthCallback("gmail", {
      code: "gmail-copy-second-code",
      state: secondState,
    });
    const accounts = await connectorApi.listBuiltinConnectorAccounts(
      actor,
      "gmail",
    );
    const secondAccount = accounts.find((account) => {
      return account.externalEmail === secondEmail;
    });
    if (!secondAccount) {
      throw new Error("Expected second Gmail account");
    }

    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    if (automation.body.kind !== "event" || !automation.body.chatThreadId) {
      throw new Error("Expected Gmail automation thread");
    }
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: automation.body.chatThreadId },
        body: {
          connectionId: secondAccount.id,
          target: { kind: "builtin", connectorSlug: "gmail" },
        },
      }),
      [200],
    );
    expect(watchedTokens).toStrictEqual([
      "Bearer gmail-copy-first-token",
      "Bearer gmail-copy-second-token",
    ]);

    await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    expect(watchedTokens).toStrictEqual([
      "Bearer gmail-copy-first-token",
      "Bearer gmail-copy-second-token",
      "Bearer gmail-copy-first-token",
    ]);
  });

  it("rebinds copied Calendar automations to the target thread default account", async () => {
    const actor = user();
    if (!actor.orgId) {
      throw new Error(
        "Expected Calendar workflow copy actor to belong to an org",
      );
    }
    await api.grantProEntitlement(actor, { tier: "team" });
    const sourceAgent = await createAgent(actor, {
      displayName: "Calendar Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Calendar Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `calendar-copy-${randomUUID().slice(0, 8)}`,
      instruction: "# Calendar copy source",
    });

    const watchedTokens: string[] = [];
    server.use(
      http.get(
        "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
        () => {
          return HttpResponse.json({
            items: [],
            nextSyncToken: `calendar-copy-sync-${watchedTokens.length}`,
          });
        },
      ),
      http.post(
        "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
        async ({ request }) => {
          const authorization = request.headers.get("authorization");
          if (!authorization) {
            throw new Error("Expected Calendar watch authorization");
          }
          watchedTokens.push(authorization);
          const body = (await request.json()) as { readonly id?: string };
          if (!body.id) {
            throw new Error("Expected Calendar watch channel id");
          }
          return HttpResponse.json({
            id: body.id,
            resourceId: `calendar-copy-resource-${watchedTokens.length}`,
            resourceUri:
              "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            expiration: "4102444800000",
          });
        },
      ),
      http.post("https://www.googleapis.com/calendar/v3/channels/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await connectGoogleCalendarAccount(actor, sourceAgent.agentId, {
      accessToken: "calendar-copy-first-token",
      email: `calendar-copy-first-${randomUUID()}@example.test`,
      subject: `calendar-copy-first-${randomUUID()}`,
    });
    const secondAccount = await connectGoogleCalendarAccount(
      actor,
      sourceAgent.agentId,
      {
        accessToken: "calendar-copy-second-token",
        email: `calendar-copy-second-${randomUUID()}@example.test`,
        subject: `calendar-copy-second-${randomUUID()}`,
        account: { intent: "add", displayName: "Calendar Copy Second" },
      },
    );
    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    if (automation.body.kind !== "event" || !automation.body.chatThreadId) {
      throw new Error("Expected Calendar automation thread");
    }
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: automation.body.chatThreadId },
        body: {
          connectionId: secondAccount.id,
          target: { kind: "builtin", connectorSlug: "google-calendar" },
        },
      }),
      [200],
    );
    expect(watchedTokens).toStrictEqual([
      "Bearer calendar-copy-first-token",
      "Bearer calendar-copy-second-token",
    ]);

    await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    expect(watchedTokens).toStrictEqual([
      "Bearer calendar-copy-first-token",
      "Bearer calendar-copy-second-token",
      "Bearer calendar-copy-first-token",
    ]);
  });

  it("rebinds copied Notion automations before exposing the destination workflow", async () => {
    const actor = user();
    if (!actor.orgId) {
      throw new Error(
        "Expected Notion workflow copy actor to belong to an org",
      );
    }
    await api.grantProEntitlement(actor, { tier: "team" });
    const sourceAgent = await createAgent(actor, {
      displayName: "Notion Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Notion Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `notion-copy-${randomUUID().slice(0, 8)}`,
      instruction: "# Notion copy source",
    });

    const parentPageId = randomUUID();
    const parentPageUrl = `https://www.notion.so/Roadmap-${parentPageId.replaceAll("-", "")}`;
    server.use(
      http.get(
        `https://api.notion.com/v1/pages/${parentPageId}`,
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer notion-copy-default-token",
          );
          return HttpResponse.json({
            object: "page",
            id: parentPageId,
            created_time: "2026-09-01T00:00:00.000Z",
            last_edited_time: "2026-09-01T00:00:00.000Z",
            archived: false,
            in_trash: false,
            url: parentPageUrl,
            parent: { type: "workspace" },
            properties: {
              title: {
                id: "title",
                type: "title",
                title: [{ type: "text", plain_text: "Roadmap" }],
              },
            },
          });
        },
      ),
    );

    mockNotionConnectorOAuth({
      accessToken: "notion-copy-default-token",
      ownerId: "notion-copy-default-user",
      ownerName: "Notion Copy Default",
    });
    const defaultStart = await connectorApi.startOauth(
      actor,
      "notion",
      "oauth",
      sourceAgent.agentId,
    );
    const defaultState = new URL(
      defaultStart.authorizationUrl,
    ).searchParams.get("state");
    if (!defaultState) {
      throw new Error("Expected default Notion OAuth state");
    }
    await connectorApi.completeOauthCallback("notion", {
      code: "notion-copy-default-code",
      state: defaultState,
    });

    mockNotionConnectorOAuth({
      accessToken: "notion-copy-selected-token",
      ownerId: "notion-copy-selected-user",
      ownerName: "Notion Copy Selected",
    });
    const selectedStart = await connectorApi.startOauth(
      actor,
      "notion",
      "oauth",
      sourceAgent.agentId,
      { intent: "add", displayName: "Notion Copy Selected" },
    );
    const selectedState = new URL(
      selectedStart.authorizationUrl,
    ).searchParams.get("state");
    if (!selectedState) {
      throw new Error("Expected selected Notion OAuth state");
    }
    await connectorApi.completeOauthCallback("notion", {
      code: "notion-copy-selected-code",
      state: selectedState,
    });
    const accounts = await connectorApi.listBuiltinConnectorAccounts(
      actor,
      "notion",
    );
    const defaultAccount = accounts.find((account) => {
      return account.externalId === "notion-copy-default-user";
    });
    const selectedAccount = accounts.find((account) => {
      return account.externalId === "notion-copy-selected-user";
    });
    if (!defaultAccount || !selectedAccount) {
      throw new Error("Expected both Notion accounts");
    }

    const sourceAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl,
          },
        },
      }),
      [201],
    );
    if (
      sourceAutomation.body.kind !== "event" ||
      sourceAutomation.body.eventType !== "notion-child-page-created" ||
      !sourceAutomation.body.chatThreadId
    ) {
      throw new Error("Expected a source Notion automation thread");
    }
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: sourceAutomation.body.chatThreadId },
        body: {
          connectionId: selectedAccount.id,
          target: { kind: "builtin", connectorSlug: "notion" },
        },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, sourceAutomation.body.id),
    ).resolves.toMatchObject({ eventConnectorId: selectedAccount.id });

    const copied = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    const copiedAutomation = copiedAutomations.body.find((automation) => {
      return (
        automation.kind === "event" &&
        automation.eventType === "notion-child-page-created"
      );
    });
    if (
      !copiedAutomation ||
      copiedAutomation.kind !== "event" ||
      copiedAutomation.eventType !== "notion-child-page-created" ||
      !copiedAutomation.chatThreadId
    ) {
      throw new Error("Expected the copied Notion automation");
    }
    expect(copiedAutomation).toMatchObject({
      enabled: true,
      eventConfig: { connectorId: defaultAccount.id },
    });
    await expect(
      readWorkflowAutomationAutonomyFixture(context, copiedAutomation.id),
    ).resolves.toMatchObject({
      enabled: true,
      eventConnectorId: defaultAccount.id,
    });
    const copiedSelections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(actor),
        params: { id: copiedAutomation.chatThreadId },
      }),
      [200],
    );
    expect(copiedSelections.body.selections).toStrictEqual([]);

    const sourceAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );
    expect(sourceAutomations.body).toContainEqual(
      expect.objectContaining({
        id: sourceAutomation.body.id,
        eventConfig: expect.objectContaining({
          connectorId: selectedAccount.id,
        }),
      }),
    );
  });

  it("rebinds copied Stripe automations to the target thread default account", async () => {
    const actor = user();
    if (!actor.orgId) {
      throw new Error(
        "Expected Stripe workflow copy actor to belong to an org",
      );
    }
    await api.grantProEntitlement(actor, { tier: "team" });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: true,
      },
    );
    const sourceAgent = await createAgent(actor, {
      displayName: "Stripe Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Stripe Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `stripe-copy-${randomUUID().slice(0, 8)}`,
      instruction: "# Stripe copy source",
    });

    const defaultAccountId = `acct_stripe_copy_default_${randomUUID()}`;
    mockStripeConnectorOAuth({ accountId: defaultAccountId, livemode: true });
    const defaultStart = await connectorApi.startOauth(
      actor,
      "stripe",
      "oauth",
      sourceAgent.agentId,
    );
    const defaultState = new URL(
      defaultStart.authorizationUrl,
    ).searchParams.get("state");
    if (!defaultState) {
      throw new Error("Expected default Stripe OAuth state");
    }
    await connectorApi.completeOauthCallback("stripe", {
      code: "stripe-copy-default-code",
      state: defaultState,
    });
    const defaultAccount = await connectorApi.readConnectorBySlug(
      actor,
      "stripe",
    );

    const selectedAccountId = `acct_stripe_copy_selected_${randomUUID()}`;
    mockStripeConnectorOAuth({ accountId: selectedAccountId, livemode: true });
    const selectedStart = await connectorApi.startOauth(
      actor,
      "stripe",
      "oauth",
      sourceAgent.agentId,
      { intent: "add", displayName: "Stripe Copy Selected" },
    );
    const selectedState = new URL(
      selectedStart.authorizationUrl,
    ).searchParams.get("state");
    if (!selectedState) {
      throw new Error("Expected selected Stripe OAuth state");
    }
    await connectorApi.completeOauthCallback("stripe", {
      code: "stripe-copy-selected-code",
      state: selectedState,
    });
    const accounts = await connectorApi.listBuiltinConnectorAccounts(
      actor,
      "stripe",
    );
    const selectedAccount = accounts.find((account) => {
      return account.externalId === selectedAccountId;
    });
    if (!selectedAccount) {
      throw new Error("Expected selected Stripe account");
    }

    const sourceAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "stripe-invoice-paid",
          eventConfig: { provider: "stripe", event: "invoice_paid" },
        },
      }),
      [201],
    );
    if (
      sourceAutomation.body.kind !== "event" ||
      sourceAutomation.body.eventType !== "stripe-invoice-paid" ||
      !sourceAutomation.body.chatThreadId
    ) {
      throw new Error("Expected source Stripe automation thread");
    }
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: sourceAutomation.body.chatThreadId },
        body: {
          connectionId: selectedAccount.id,
          target: { kind: "builtin", connectorSlug: "stripe" },
        },
      }),
      [200],
    );

    const copied = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    expect(copiedAutomations.body).toContainEqual(
      expect.objectContaining({
        eventType: "stripe-invoice-paid",
        eventConfig: expect.objectContaining({
          connectorId: defaultAccount.id,
          stripeAccountId: defaultAccountId,
          mode: "live",
        }),
      }),
    );
  });

  it("rebinds copied Google Forms automations to the target thread default account", async () => {
    const actor = user();
    if (!actor.orgId) {
      throw new Error(
        "Expected Google Forms workflow copy actor to belong to an org",
      );
    }
    await api.grantProEntitlement(actor, { tier: "team" });
    const sourceAgent = await createAgent(actor, {
      displayName: "Google Forms Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Google Forms Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `google-forms-copy-${randomUUID().slice(0, 8)}`,
      instruction: "# Google Forms copy source",
    });
    const formId = `googleFormsCopy${randomUUID().replaceAll("-", "")}`;
    const topicName = "projects/vm0-ai-488909/topics/forms-copy-events";
    mockOptionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME", topicName);
    mockOptionalEnv(
      "GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE",
      "https://api.okou.ai/api/webhooks/google-forms",
    );
    mockOptionalEnv(
      "GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
      "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com",
    );
    const watchedTokens: string[] = [];
    server.use(
      http.get(
        "https://forms.googleapis.com/v1/forms/:formId",
        ({ params }) => {
          expect(params.formId).toBe(formId);
          return HttpResponse.json({
            formId,
            info: { title: "Copy form" },
            publishSettings: {
              publishState: {
                isPublished: true,
                isAcceptingResponses: true,
              },
            },
          });
        },
      ),
      http.get(
        "https://forms.googleapis.com/v1/forms/:formId/responses",
        ({ params }) => {
          expect(params.formId).toBe(formId);
          return HttpResponse.json({ responses: [] });
        },
      ),
      http.post(
        "https://forms.googleapis.com/v1/forms/:formId/watches",
        ({ request, params }) => {
          expect(params.formId).toBe(formId);
          const authorization = request.headers.get("authorization");
          if (!authorization) {
            throw new Error("Expected Google Forms watch authorization");
          }
          watchedTokens.push(authorization);
          return HttpResponse.json({
            id: `forms-copy-watch-${randomUUID()}`,
            createTime: "2026-09-01T10:00:00Z",
            expireTime: "2099-09-01T10:00:00Z",
            eventType: "RESPONSES",
            target: { topic: { topicName } },
          });
        },
      ),
      http.delete(
        "https://forms.googleapis.com/v1/forms/:formId/watches/:watchId",
        () => {
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    mockGoogleFormsConnectorOAuth({
      accessToken: "google-forms-copy-first-token",
      email: "google-forms-copy-first@example.test",
      subject: `google-forms-copy-first-${randomUUID()}`,
    });
    const firstStart = await connectorApi.startOauth(
      actor,
      "google-forms",
      "oauth",
      sourceAgent.agentId,
    );
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!firstState) {
      throw new Error("Expected first Google Forms OAuth state");
    }
    await connectorApi.completeOauthCallback("google-forms", {
      code: "google-forms-copy-first-code",
      state: firstState,
    });
    const firstAccount = await connectorApi.readConnectorBySlug(
      actor,
      "google-forms",
    );

    mockGoogleFormsConnectorOAuth({
      accessToken: "google-forms-copy-second-token",
      email: "google-forms-copy-second@example.test",
      subject: `google-forms-copy-second-${randomUUID()}`,
    });
    const secondStart = await connectorApi.startOauth(
      actor,
      "google-forms",
      "oauth",
      sourceAgent.agentId,
      { intent: "add", displayName: "Google Forms Copy Second" },
    );
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!secondState) {
      throw new Error("Expected second Google Forms OAuth state");
    }
    await connectorApi.completeOauthCallback("google-forms", {
      code: "google-forms-copy-second-code",
      state: secondState,
    });
    const accounts = await connectorApi.listBuiltinConnectorAccounts(
      actor,
      "google-forms",
    );
    const secondAccount = accounts.find((account) => {
      return account.externalEmail === "google-forms-copy-second@example.test";
    });
    if (!secondAccount) {
      throw new Error("Expected second Google Forms account");
    }

    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: `https://docs.google.com/forms/d/${formId}/edit`,
          },
        },
      }),
      [201],
    );
    if (automation.body.kind !== "event" || !automation.body.chatThreadId) {
      throw new Error("Expected Google Forms automation thread");
    }
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: automation.body.chatThreadId },
        body: {
          connectionId: secondAccount.id,
          target: { kind: "builtin", connectorSlug: "google-forms" },
        },
      }),
      [200],
    );
    expect(watchedTokens).toStrictEqual([
      "Bearer google-forms-copy-first-token",
      "Bearer google-forms-copy-second-token",
    ]);

    const copied = await accept(
      detailClient().copy({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    expect(watchedTokens).toStrictEqual([
      "Bearer google-forms-copy-first-token",
      "Bearer google-forms-copy-second-token",
      "Bearer google-forms-copy-first-token",
    ]);
    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    const copiedAutomation = copiedAutomations.body.find((candidate) => {
      return (
        candidate.kind === "event" &&
        candidate.eventType === "google-forms-response-submitted"
      );
    });
    if (
      !copiedAutomation ||
      copiedAutomation.kind !== "event" ||
      copiedAutomation.eventType !== "google-forms-response-submitted"
    ) {
      throw new Error("Expected copied Google Forms automation");
    }
    expect(copiedAutomation.eventConfig.connectorId).toBe(firstAccount.id);
  });

  it("inherits copied automation budgets from agent callers and rejects exhausted runs", async () => {
    const actor = user({ orgRole: "org:admin" });
    await enableWorkflowRuns(actor);
    const sourceAgent = await createAgent(actor, {
      displayName: "Budgeted Copy Source Agent",
      visibility: "private",
    });
    const targetAgent = await createAgent(actor, {
      displayName: "Budgeted Copy Target Agent",
      visibility: "private",
    });
    const workflow = await createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: `budgeted-copy-${randomUUID().slice(0, 8)}`,
      instruction: "# budgeted copy source",
    });
    const sourceAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 900 },
        },
      }),
      [201],
    );
    await setWorkflowAutomationAutonomyBudgetFixture(
      context,
      sourceAutomation.body.id,
      2,
    );
    const sourceRun = await runWorkflowAndLaunch(actor, workflow.body.id);
    const sourceToken = api.okouTokenForRunWithCapabilities(
      actor,
      sourceRun.runId,
      ["agent:write"],
    );

    await setRunAutonomyBudgetFixture(context, sourceRun.runId, 32);
    const copied = await accept(
      detailClient().copy({
        headers: { authorization: `Bearer ${sourceToken}` },
        params: { workflowId: workflow.body.id },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    const [copiedAutomation] = copiedAutomations.body;
    if (!copiedAutomation) {
      throw new Error("Expected the copied workflow automation");
    }
    await expect(
      readWorkflowAutomationAutonomyFixture(context, copiedAutomation.id),
    ).resolves.toMatchObject({ autonomyBudget: 31 });

    await setRunAutonomyBudgetFixture(context, sourceRun.runId, 0);
    const blockedTargetAgent = await createAgent(actor, {
      displayName: "Exhausted Copy Target Agent",
      visibility: "private",
    });
    const blocked = await accept(
      detailClient().copy({
        headers: { authorization: `Bearer ${sourceToken}` },
        params: { workflowId: workflow.body.id },
        body: { toAgentId: blockedTargetAgent.agentId },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("AUTONOMY_BUDGET_EXHAUSTED");

    const blockedTargetWorkflows = await accept(
      collectionClient().list({
        headers: authHeaders(actor),
        query: { agentId: blockedTargetAgent.agentId },
      }),
      [200],
    );
    expect(names(blockedTargetWorkflows.body)).not.toContain(
      workflow.body.name,
    );
    await api.requestCancelRun(actor, sourceRun.runId, [200]);
  });

  it("reuses registered workflow volumes without uploading or reconciling archive size", async () => {
    const actor = user();
    await api.grantProEntitlement(actor);
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const runnerGroup = api.configureRunnerGroup();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const s3 = installVolumeS3Fixture();
    const sendS3 = context.mocks.s3.send.getMockImplementation()!;
    const agent = await bdd.createAgent(actor, {
      displayName: "Immutable Volume Agent",
      visibility: "private",
    });
    const activeRuns = new Set<string>();
    const ownedWorkflows = new Set<string>();
    onTestFinished(async () => {
      // Global teardown resets external mocks before this owned cleanup.
      context.mocks.s3.send.mockImplementation(sendS3);
      for (const runId of activeRuns) {
        await api.requestCancelRun(actor, runId, [200]);
        await flushWaitUntilForTest();
      }
      for (const workflowId of ownedWorkflows) {
        await miscApi.deleteWorkflow(actor, workflowId, [204]);
      }
      await bdd.deleteAgent(actor, agent.agentId);
    });
    s3.clearWrites();
    const name = `immutable-volume-${randomUUID().slice(0, 8)}`;
    const description = "Exercises immutable workflow volume publication.";
    const firstInstruction = "# immutable volume one";
    const firstFiles = [
      { path: "zeta.txt", content: "zeta one" },
      { path: "alpha.txt", content: "alpha one" },
    ];
    const workflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name,
      description,
      instruction: firstInstruction,
      files: firstFiles,
    });
    ownedWorkflows.add(workflow.body.id);

    const firstArchiveWrites = s3.writes.filter(({ key }) => {
      return key.endsWith("/archive.tar.gz");
    });
    expect(firstArchiveWrites).toHaveLength(1);
    const firstArchiveKey = firstArchiveWrites[0]!.key;
    const firstVersionId = firstArchiveKey.split("/").at(-2);
    expect(firstVersionId).toMatch(/^[0-9a-f]{64}$/u);
    const firstArchive = s3.objects.get(firstArchiveKey);
    if (!firstArchive) {
      throw new Error("Expected the first workflow archive");
    }
    const firstSkillMd = synthesizeWorkflowSkillMd({
      name,
      description,
      instruction: firstInstruction,
    });
    const firstArchiveFiles = [
      { path: "SKILL.md", content: firstSkillMd },
      ...firstFiles,
    ].sort((left, right) => {
      return left.path.localeCompare(right.path);
    });
    const firstSize = firstArchiveFiles.reduce((sum, file) => {
      return sum + Buffer.byteLength(file.content, "utf8");
    }, 0);
    const firstManifestKey = firstArchiveKey.replace(
      /archive\.tar\.gz$/u,
      "manifest.json",
    );
    const firstManifest = s3.objects.get(firstManifestKey);
    if (!firstManifest) {
      throw new Error("Expected the first workflow manifest");
    }
    expect(JSON.parse(firstManifest.toString("utf8"))).toMatchObject({
      version: firstVersionId,
      totalSize: firstSize,
      fileCount: 3,
      files: expect.arrayContaining(
        firstArchiveFiles.map((file) => {
          return {
            path: file.path,
            size: Buffer.byteLength(file.content, "utf8"),
            hash: createHash("sha256").update(file.content).digest("hex"),
          };
        }),
      ),
    });
    expect(
      [...extractFilesFromTarGz(firstArchive)].sort((left, right) => {
        return left.path.localeCompare(right.path);
      }),
    ).toStrictEqual(firstArchiveFiles);

    const tar = gunzipSync(firstArchive);
    const encodedMtime = tar
      .subarray(136, 148)
      .toString("ascii")
      .replaceAll("\0", "")
      .trim();
    expect(Number.parseInt(encodedMtime, 8)).toBe(0);

    const claimCurrentArchive = async () => {
      const run = await runWorkflowAndLaunch(actor, workflow.body.id);
      activeRuns.add(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.claimRunnerJob(run.runId);
      const mount = expectCanonicalStorageManifest(
        claim.storageManifest,
      )?.storageMounts.find((candidate) => {
        return candidate.name === getCustomSkillStorageName(workflow.body.id);
      });
      if (!mount?.archiveUrl) {
        throw new Error("Expected the selected workflow archive mount");
      }
      await api.requestCancelRun(actor, run.runId, [200]);
      // A claimed Run keeps the thread slot until its Runner acknowledges
      // cancellation; finish that protocol before launching this Workflow again.
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId: run.runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${claim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      activeRuns.delete(run.runId);
      return mount;
    };
    await expect(claimCurrentArchive()).resolves.toMatchObject({
      versionId: firstVersionId,
      archiveSize: firstArchive.length,
    });

    const readCurrentArchive = async (
      instruction: string,
      files: readonly { readonly path: string; readonly content: string }[],
      archiveKey: string,
    ) => {
      const firstCall = context.mocks.s3.send.mock.calls.length;
      const detail = await accept(
        detailClient().get({
          headers: authHeaders(actor),
          params: { workflowId: workflow.body.id },
        }),
        [200],
      );
      expect(detail.body.instruction).toBe(instruction);
      expect(detail.body.fileContents).toStrictEqual(
        [...files].sort((left, right) => {
          return left.path.localeCompare(right.path);
        }),
      );
      expect(
        context.mocks.s3.send.mock.calls
          .slice(firstCall)
          .flatMap(([command]) => {
            return command instanceof GetObjectCommand &&
              command.input.Key?.endsWith("/archive.tar.gz")
              ? [command.input.Key]
              : [];
          }),
      ).toStrictEqual([archiveKey]);
    };

    const secondInstruction = "# immutable volume two";
    const secondFiles = [
      { path: "alpha.txt", content: "alpha two" },
      { path: "zeta.txt", content: "zeta two" },
    ];
    s3.clearWrites();
    await updateWorkflow(actor, workflow.body.id, {
      instruction: secondInstruction,
      files: secondFiles,
    });
    const secondArchiveWrites = s3.writes.filter(({ key }) => {
      return key.endsWith("/archive.tar.gz");
    });
    expect(secondArchiveWrites).toHaveLength(1);
    const secondArchiveKey = secondArchiveWrites[0]!.key;
    const secondVersionId = secondArchiveKey.split("/").at(-2);
    expect(secondVersionId).not.toBe(firstVersionId);
    await expect(claimCurrentArchive()).resolves.toMatchObject({
      versionId: secondVersionId,
    });

    s3.clearWrites();
    await updateWorkflow(actor, workflow.body.id, {
      instruction: firstInstruction,
      files: [...firstFiles].reverse(),
    });
    expect(s3.writes).toHaveLength(0);
    await readCurrentArchive(firstInstruction, firstFiles, firstArchiveKey);

    await updateWorkflow(actor, workflow.body.id, {
      instruction: secondInstruction,
      files: secondFiles,
    });
    expect(s3.writes).toHaveLength(0);
    await readCurrentArchive(secondInstruction, secondFiles, secondArchiveKey);

    // The synthetic archive_size corruption branch was explicitly retired in
    // #37440. Reuse still exercises immutable metadata validation through the
    // public update and reads the exact selected archive through public detail.
    s3.clearWrites();
    context.mocks.s3.send.mockClear();
    await updateWorkflow(actor, workflow.body.id, {
      instruction: firstInstruction,
      files: firstFiles,
    });
    expect(s3.writes).toHaveLength(0);
    await readCurrentArchive(firstInstruction, firstFiles, firstArchiveKey);
    // Detail reads may GET the manifest on a cache miss. Registered-version
    // reuse must not probe or PUT the archive/manifest again.
    const registeredKeys = new Set([firstArchiveKey, firstManifestKey]);
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        return (
          (command instanceof HeadObjectCommand ||
            command instanceof PutObjectCommand) &&
          command.input.Key !== undefined &&
          registeredKeys.has(command.input.Key)
        );
      }),
    ).toHaveLength(0);
  });

  it("reuses an existing workflow archive across path order and umask", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Duplicate Path Volume Agent",
      visibility: "private",
    });
    const s3 = installVolumeS3Fixture();
    const duplicateFiles = [
      { path: "duplicate.txt", content: "first duplicate" },
      { path: "duplicate.txt", content: "second duplicate" },
    ];
    const originalUmask = process.umask(0o022);
    onTestFinished(() => {
      process.umask(originalUmask);
    });
    const workflow = await createWorkflow(actor, {
      agentId: agent.agentId,
      name: `duplicate-volume-${randomUUID().slice(0, 8)}`,
      description: "Exercises deterministic duplicate-path archives.",
      instruction: "# duplicate path volume",
      files: duplicateFiles,
    });

    const archiveWrites = s3.writes.filter(({ key }) => {
      return key.endsWith("/archive.tar.gz");
    });
    expect(archiveWrites).toHaveLength(1);
    const archiveKey = archiveWrites[0]!.key;
    const initialArchive = s3.objects.get(archiveKey);
    if (!initialArchive) {
      throw new Error("Expected the duplicate-path workflow archive");
    }
    const initial = await accept(
      detailClient().get({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );
    expect(initial.body.instruction).toBe("# duplicate path volume");
    // Public detail preserves both archive entries. Packaging reads the final
    // contents of the repeated path for each entry.
    expect(initial.body.fileContents).toStrictEqual([
      { path: "duplicate.txt", content: "second duplicate" },
      { path: "duplicate.txt", content: "second duplicate" },
    ]);

    s3.clearWrites();
    context.mocks.s3.send.mockClear();
    process.umask(0o077);
    await updateWorkflow(actor, workflow.body.id, {
      files: [...duplicateFiles].reverse(),
    });
    process.umask(originalUmask);

    expect(s3.writes).toHaveLength(0);
    expect(s3.objects.get(archiveKey)).toStrictEqual(initialArchive);
    context.mocks.s3.send.mockClear();
    const updated = await accept(
      detailClient().get({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );
    expect(updated.body.instruction).toBe(initial.body.instruction);
    expect(updated.body.fileContents).toStrictEqual(initial.body.fileContents);
    expect(
      context.mocks.s3.send.mock.calls
        .map(([command]) => {
          return command instanceof GetObjectCommand
            ? command.input.Key
            : undefined;
        })
        .filter((key) => {
          return key?.endsWith("/archive.tar.gz");
        }),
    ).toStrictEqual([archiveKey]);
  });

  it("reads and updates workflow content, audit metadata, and deletion through API responses", async () => {
    const creator = user();
    const updater = user({ orgId: creator.orgId, orgRole: "org:admin" });
    const agent = await createAgent(creator, {
      displayName: "Audit Agent",
      visibility: "public",
    });
    const workflow = await createWorkflow(creator, {
      agentId: agent.agentId,
      name: `audit-workflow-${randomUUID().slice(0, 8)}`,
      displayName: "Audit Workflow",
      instruction: "# audit workflow",
      files: [{ path: "notes.md", content: "initial notes" }],
      visibility: "public",
    });

    const initial = await accept(
      detailClient().get({
        headers: authHeaders(creator),
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );
    expect(initial.body).toMatchObject({
      createdByUserId: creator.userId,
      updatedByUserId: creator.userId,
      instruction: "# audit workflow",
      ownerUserId: creator.userId,
    });
    expect(typeof initial.body.createdAt).toBe("string");
    expect(typeof initial.body.updatedAt).toBe("string");

    const updated = await updateWorkflow(updater, workflow.body.id, {
      displayName: "Updated Audit Workflow",
      instruction: "# updated workflow",
      files: [{ path: "notes.md", content: "updated notes" }],
    });
    expect(updated.body).toMatchObject({
      createdByUserId: creator.userId,
      updatedByUserId: updater.userId,
      displayName: "Updated Audit Workflow",
      instruction: "# updated workflow",
    });

    await accept(
      detailClient().delete({
        headers: authHeaders(updater),
        params: { workflowId: workflow.body.id },
      }),
      [204],
    );
    const missing = await accept(
      detailClient().get({
        headers: authHeaders(creator),
        params: { workflowId: workflow.body.id },
      }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});

class WorkflowProfileClerkError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly retryAfter = 1;
  constructor(readonly status: number) {
    super(`Clerk profile request failed: ${status}`);
  }
}

function ownerProfileUser(ownerUserId: string) {
  return {
    id: ownerUserId,
    firstName: "Workflow",
    lastName: "Author",
    imageUrl: "https://example.com/author.png",
    primaryEmailAddressId: "primary",
    emailAddresses: [{ id: "primary", emailAddress: "author@example.com" }],
  };
}

async function ownerProfileFixture(
  visibility: "public" | "private" = "public",
) {
  const owner = user();
  const agent = await createAgent(owner, { visibility: "public" });
  const workflow = await createWorkflow(owner, {
    agentId: agent.agentId,
    name: `profile-${randomUUID().slice(0, 8)}`,
    visibility,
  });
  return { owner, agent, workflow: workflow.body };
}

function readOwnerProfile(actor: ApiTestUser, workflowId: string) {
  return detailClient().ownerProfile({
    headers: authHeaders(actor),
    params: { workflowId },
  });
}

describe("workflow owner profiles", () => {
  it("keeps ordinary list, detail and mutation responses independent of profile enrichment", async () => {
    const { owner, workflow } = await ownerProfileFixture();
    mockNow(now() + 16 * 60 * 1000);
    context.mocks.clerk.users.getUserList.mockClear();
    context.mocks.clerk.users.getUser.mockRejectedValue(
      new Error("Profiles are offline"),
    );
    const listed = await accept(
      collectionClient().list({ headers: authHeaders(owner) }),
      [200],
    );
    const detail = await accept(
      detailClient().get({
        headers: authHeaders(owner),
        params: { workflowId: workflow.id },
      }),
      [200],
    );
    const updated = await updateWorkflow(owner, workflow.id, {
      displayName: "Profile-independent update",
    });
    for (const response of [
      listed.body.find((row) => {
        return row.id === workflow.id;
      }),
      detail.body,
      updated.body,
    ]) {
      expect(response).toMatchObject({ ownerUserId: owner.userId });
      expect(response).not.toHaveProperty("ownerUserDisplayName");
      expect(response).not.toHaveProperty("ownerUserImageUrl");
    }
    expect(context.mocks.clerk.users.getUser).not.toHaveBeenCalled();
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("authorizes each profile read including warm-cache private and cross-org misses", async () => {
    const { owner, workflow } = await ownerProfileFixture("private");
    mockNow(now() + 16 * 60 * 1000);
    context.mocks.clerk.users.getUser.mockResolvedValue(
      ownerProfileUser(owner.userId),
    );
    const profile = await accept(readOwnerProfile(owner, workflow.id), [200]);
    expect(profile.body).toStrictEqual({
      displayName: "Workflow Author",
      imageUrl: "https://example.com/author.png",
    });
    context.mocks.clerk.users.getUser.mockClear();
    const other = user({ orgId: owner.orgId, orgRole: "org:admin" });
    await accept(readOwnerProfile(other, workflow.id), [404]);
    await accept(readOwnerProfile(user(), workflow.id), [404]);
    await accept(readOwnerProfile(owner, randomUUID()), [404]);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await accept(
      detailClient().ownerProfile({ params: { workflowId: workflow.id } }),
      [401],
    );
    expect(context.mocks.clerk.users.getUser).not.toHaveBeenCalled();
  });

  it("does not disclose a public workflow after its agent becomes private", async () => {
    const { owner, workflow, agent } = await ownerProfileFixture();
    const other = user({ orgId: owner.orgId, orgRole: "org:member" });
    mockNow(now() + 16 * 60 * 1000);
    context.mocks.clerk.users.getUser.mockResolvedValue(
      ownerProfileUser(owner.userId),
    );
    await accept(readOwnerProfile(other, workflow.id), [200]);
    await bdd.updateAgent(owner, agent.agentId, { visibility: "private" });
    context.mocks.clerk.users.getUser.mockClear();
    await accept(readOwnerProfile(other, workflow.id), [404]);
    expect(context.mocks.clerk.users.getUser).not.toHaveBeenCalled();
  });

  it("reuses positive profiles and refreshes them after fifteen minutes", async () => {
    const { owner, workflow } = await ownerProfileFixture();
    mockNow(now() + 16 * 60 * 1000);
    context.mocks.clerk.users.getUser.mockResolvedValue(
      ownerProfileUser(owner.userId),
    );
    await accept(readOwnerProfile(owner, workflow.id), [200]);
    context.mocks.clerk.users.getUser.mockResolvedValue({
      ...ownerProfileUser(owner.userId),
      firstName: "Updated",
    });
    expect(
      (await accept(readOwnerProfile(owner, workflow.id), [200])).body
        .displayName,
    ).toBe("Workflow Author");
    mockNow(now() + 15 * 60 * 1000);
    expect(
      (await accept(readOwnerProfile(owner, workflow.id), [200])).body
        .displayName,
    ).toBe("Updated Author");
  });

  it("bounds missing profiles to sixty seconds and never serves stale identity after authoritative absence", async () => {
    const { owner, workflow } = await ownerProfileFixture();
    mockNow(now() + 16 * 60 * 1000);
    context.mocks.clerk.users.getUser.mockResolvedValue(
      ownerProfileUser(owner.userId),
    );
    await accept(readOwnerProfile(owner, workflow.id), [200]);
    mockNow(now() + 15 * 60 * 1000);
    context.mocks.clerk.users.getUser.mockRejectedValue(
      new WorkflowProfileClerkError(404),
    );
    expect(
      (await accept(readOwnerProfile(owner, workflow.id), [200])).body,
    ).toStrictEqual({ displayName: null, imageUrl: null });
    context.mocks.clerk.users.getUser.mockResolvedValue(
      ownerProfileUser(owner.userId),
    );
    expect(
      (await accept(readOwnerProfile(owner, workflow.id), [200])).body
        .displayName,
    ).toBeNull();
    mockNow(now() + 60 * 1000);
    expect(
      (await accept(readOwnerProfile(owner, workflow.id), [200])).body
        .displayName,
    ).toBe("Workflow Author");
  });

  it.each([429, 503, "network"] as const)(
    "keeps %s profile failures retryable",
    async (failure) => {
      const { owner, workflow } = await ownerProfileFixture();
      mockNow(now() + 16 * 60 * 1000);
      context.mocks.clerk.users.getUser.mockRejectedValue(
        failure === "network"
          ? new Error("Connection reset")
          : new WorkflowProfileClerkError(failure),
      );
      await accept(readOwnerProfile(owner, workflow.id), [
        failure === 429 ? 429 : failure === 503 ? 503 : 500,
      ]);
      context.mocks.clerk.users.getUser.mockResolvedValue(
        ownerProfileUser(owner.userId),
      );
      expect(
        (await accept(readOwnerProfile(owner, workflow.id), [200])).body
          .displayName,
      ).toBe("Workflow Author");
    },
  );

  it("coalesces concurrent requests without reading workflow storage", async () => {
    const { owner, workflow } = await ownerProfileFixture();
    mockNow(now() + 16 * 60 * 1000);
    const started = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<ReturnType<typeof ownerProfileUser>>(
      context.signal,
    );
    context.mocks.clerk.users.getUser.mockImplementation(() => {
      started.resolve(undefined);
      return response.promise;
    });
    context.mocks.s3.send.mockClear();
    const first = readOwnerProfile(owner, workflow.id);
    await started.promise;
    const second = readOwnerProfile(owner, workflow.id);
    response.resolve(ownerProfileUser(owner.userId));
    const results = await Promise.all([
      accept(first, [200]),
      accept(second, [200]),
    ]);
    expect(
      results.map((result) => {
        return result.body.displayName;
      }),
    ).toStrictEqual(["Workflow Author", "Workflow Author"]);
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(1);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("returns a real user's name without inventing a cache email", async () => {
    const { owner, workflow } = await ownerProfileFixture();
    mockNow(now() + 16 * 60 * 1000);
    context.mocks.clerk.users.getUser.mockResolvedValue({
      ...ownerProfileUser(owner.userId),
      emailAddresses: [],
      primaryEmailAddressId: null,
    });
    expect(
      (await accept(readOwnerProfile(owner, workflow.id), [200])).body
        .displayName,
    ).toBe("Workflow Author");
  });
});

describe("workflow owner profile cancellation", () => {
  it("retries after cancellation and ignores a late missing result", async () => {
    const { owner, workflow } = await ownerProfileFixture();
    mockNow(now() + 16 * 60 * 1000);
    const controller = new AbortController();
    const started = createDeferredPromise<void>(context.signal);
    const missing = createDeferredPromise<void>(context.signal);
    context.mocks.clerk.users.getUser.mockImplementation(async () => {
      started.resolve(undefined);
      await missing.promise;
      throw new WorkflowProfileClerkError(404);
    });
    const pending = setupApp({
      context,
      routes: workflowsRoutes,
      signal: controller.signal,
    })(workflowsDetailContract).ownerProfile({
      headers: authHeaders(owner),
      params: { workflowId: workflow.id },
    });
    await started.promise;
    controller.abort(
      new DOMException("Owner profile request cancelled", "AbortError"),
    );
    await accept(pending, [500]);
    missing.resolve(undefined);
    context.mocks.clerk.users.getUser.mockResolvedValue(
      ownerProfileUser(owner.userId),
    );
    expect(
      (await accept(readOwnerProfile(owner, workflow.id), [200])).body
        .displayName,
    ).toBe("Workflow Author");
  });
});

test("awards the workflow creator only after a queued user workflow really succeeds", async () => {
  const actor = user({ orgRole: "org:admin" });
  await enableWorkflowRuns(actor);
  const agent = await createAgent(actor, {
    displayName: "Reward Workflow Agent",
    visibility: "private",
  });
  const workflow = await createWorkflow(actor, {
    agentId: agent.agentId,
    name: `reward-${randomUUID().slice(0, 8)}`,
    instruction: "Produce a short summary",
  });
  if (!actor.orgId) {
    throw new Error("Expected workflow org");
  }
  const review = () => {
    return accept(
      setupApp({ context, routes: scopedReviewRoutes })(
        scopedReviewContract,
      ).process({ body: { orgId: actor.orgId ?? "" } }),
      [200],
    );
  };
  const rewards = async () => {
    return (await readGetStartedStatus(context, actor)).quests.find((q) => {
      return q.key === "workflow";
    });
  };
  await expect(rewards()).resolves.toMatchObject({ claimedCount: 0 });
  const first = await runWorkflowAndLaunch(actor, workflow.body.id);
  const queued = await accept(
    detailClient().run({
      headers: authHeaders(actor),
      params: { workflowId: workflow.body.id },
    }),
    [200],
  );
  expect(queued.body.runId).toBeNull();
  const webhooks = createWebhookCallbackApi(context);
  await webhooks.requestAgentComplete(
    { runId: first.runId, exitCode: 1, error: "Synthetic failure" },
    {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, first.runId)}`,
    },
    [200],
  );
  await flushWaitUntilForTest();
  const events = await chat.listThreadEvents(actor, first.chatThreadId);
  const next = events.events.find((event) => {
    return event.runId && event.runId !== first.runId;
  });
  if (!next?.runId) {
    throw new Error("Expected the queued workflow to start after failure");
  }
  await review();
  await expect(rewards()).resolves.toMatchObject({ claimedCount: 0 });
  await webhooks.requestAgentComplete(
    {
      runId: next.runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: next.runId,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`workflow reward ${next.runId}`)
          .digest("hex"),
      },
    },
    { authorization: `Bearer ${api.sandboxTokenForRun(actor, next.runId)}` },
    [200],
  );
  // The next worker attempt is due later; use the test-owned clock, not a sleep.
  mockNow(now() + 60_001);
  await review();
  await expect(rewards()).resolves.toMatchObject({
    claimedCount: 1,
    earnedCredits: 1000,
    canEarnMore: false,
  });
  await miscApi.deleteWorkflow(actor, workflow.body.id, [204]);
  await review();
  await expect(rewards()).resolves.toMatchObject({
    claimedCount: 1,
    earnedCredits: 1000,
  });
});
