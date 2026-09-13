import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  testSystemStoragePresignedUrlCacheStateContract,
  type TestSystemStoragePresignedUrlCacheStateActionBody,
} from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowAutomationsContract,
  workflowVisibilityContract,
  type WorkflowCreateRequest,
  type WorkflowUpdateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  readWorkflowAutomationAutonomyFixture,
  setRunAutonomyBudgetFixture,
  setWorkflowAutomationAutonomyBudgetFixture,
} from "./helpers/runtime-state";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
  mockGoogleFormsConnectorOAuth,
  mockStripeConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { chatThreadRoutes } from "../chat-threads";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const miscApi = createMiscRoutesApi(context);
const mocks = createRouteMocks(context);
const api = createRunsApi(context);
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

function storageStateClient() {
  return setupApp({
    context,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  })(testSystemStoragePresignedUrlCacheStateContract);
}

async function storageStateAction(
  body: TestSystemStoragePresignedUrlCacheStateActionBody,
) {
  return await accept(storageStateClient().action({ body }), [200]);
}

async function readWorkflowStorageState(
  actor: ApiTestUser,
  workflowId: string,
) {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped workflow actor");
  }
  const response = await storageStateAction({
    action: "read-storage-state",
    org_id: actor.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: getCustomSkillStorageName(workflowId),
  });
  return response.body.storage_state ?? null;
}

async function readWorkflowStorageVersion(
  actor: ApiTestUser,
  workflowId: string,
  versionId: string,
) {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped workflow actor");
  }
  const response = await storageStateAction({
    action: "read-storage-version",
    org_id: actor.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: getCustomSkillStorageName(workflowId),
    version_id: versionId,
  });
  return response.body.storage_version ?? null;
}

async function setWorkflowStorageVersionArchiveSize(
  actor: ApiTestUser,
  workflowId: string,
  versionId: string,
  archiveSize: number,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped workflow actor");
  }
  await storageStateAction({
    action: "set-storage-version-archive-size",
    org_id: actor.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: getCustomSkillStorageName(workflowId),
    version_id: versionId,
    archive_size: archiveSize,
  });
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
  await api.ensureOrgModelProvider(actor);
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
        model: "gpt-5.6-terra",
        isDefault: true,
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

    const run = await accept(
      detailClient().run({
        headers: authHeaders(actor),
        params: { workflowId: created.body.id },
      }),
      [200],
    );

    expect(run.body.chatThreadId).toStrictEqual(expect.any(String));
    expect(run.body.runId).toStrictEqual(expect.any(String));
    if (!run.body.runId) {
      throw new Error("Expected an idle workflow invocation to create a run");
    }
    expect(run.body.chatThreadId).toBe(prepared.body.chatThreadId);

    const queued = await accept(
      detailClient().run({
        headers: authHeaders(actor),
        params: { workflowId: created.body.id },
      }),
      [200],
    );
    expect(queued.body).toStrictEqual({
      chatThreadId: run.body.chatThreadId,
      runId: null,
    });

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.body.runId);
    expect(claim.cliAgentType).toBe("codex");
    expect(claim.environment?.OPENAI_MODEL).toBe("gpt-5.6-terra");
    expect(claim.environment?.ANTHROPIC_MODEL).toBeUndefined();
    await api.requestCancelRun(actor, run.body.runId, [200]);
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
    const runIds = [
      ...new Set(
        runs.flatMap((run) => {
          return run.body.runId ? [run.body.runId] : [];
        }),
      ),
    ];
    expect(runIds.length).toBeGreaterThan(0);
    for (const runId of runIds) {
      await api.requestCancelRun(actor, runId, [200]);
    }
  });

  it("runs public workflows for members and hides workflows on private agents", async () => {
    const owner = user({ orgRole: "org:admin" });
    const member = user({ orgId: owner.orgId, orgRole: "org:member" });
    await enableWorkflowRuns(owner);
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

    const publicRun = await accept(
      detailClient().run({
        headers: authHeaders(member),
        params: { workflowId: publicWorkflow.body.id },
      }),
      [200],
    );
    if (!publicRun.body.runId) {
      throw new Error("Expected the public workflow to create a run");
    }

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

    await api.requestCancelRun(member, publicRun.body.runId, [200]);
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
    await setWorkflowAutomationAutonomyBudgetFixture(
      context,
      automation.body.id,
      4,
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, automation.body.id),
    ).resolves.toMatchObject({
      officialBlueprintKey: null,
      officialResultEmailEnabled: null,
    });
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
    await expect(
      readWorkflowAutomationAutonomyFixture(context, copiedSchedule.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      officialBlueprintKey: null,
      officialResultEmailEnabled: null,
    });
    expect(
      copiedAutomations.body.some((copiedAutomation) => {
        return (
          copiedAutomation.kind === "event" &&
          copiedAutomation.eventType === "webhook-received"
        );
      }),
    ).toBeTruthy();
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
    const sourceRun = await accept(
      detailClient().run({
        headers: authHeaders(actor),
        params: { workflowId: workflow.body.id },
      }),
      [200],
    );
    if (!sourceRun.body.runId) {
      throw new Error("Expected the source workflow run to start");
    }
    const sourceToken = api.okouTokenForRunWithCapabilities(
      actor,
      sourceRun.body.runId,
      ["agent:write"],
    );

    await setRunAutonomyBudgetFixture(context, sourceRun.body.runId, 10);
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
    ).resolves.toMatchObject({ autonomyBudget: 9 });

    await setRunAutonomyBudgetFixture(context, sourceRun.body.runId, 0);
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
    await api.requestCancelRun(actor, sourceRun.body.runId, [200]);
  });

  it("reuses and repairs immutable workflow volume versions without moving HEAD during preparation", async () => {
    const actor = user();
    const agent = await createAgent(actor, {
      displayName: "Immutable Volume Agent",
      visibility: "private",
    });
    const s3 = installVolumeS3Fixture();
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

    const firstState = await readWorkflowStorageState(actor, workflow.body.id);
    if (!firstState?.head_version_id) {
      throw new Error("Expected the first workflow volume version");
    }
    const firstVersionId = firstState.head_version_id;
    const firstArchiveKey = `${firstState.s3_prefix}/${firstVersionId}/archive.tar.gz`;
    const firstArchive = s3.objects.get(firstArchiveKey);
    if (!firstArchive) {
      throw new Error("Expected the first workflow archive");
    }
    const firstVersion = await readWorkflowStorageVersion(
      actor,
      workflow.body.id,
      firstVersionId,
    );
    const firstSkillMd = synthesizeWorkflowSkillMd({
      name,
      description,
      instruction: firstInstruction,
    });
    const firstSize = [
      firstSkillMd,
      ...firstFiles.map((file) => {
        return file.content;
      }),
    ]
      .map((content) => {
        return Buffer.byteLength(content, "utf8");
      })
      .reduce((sum, size) => {
        return sum + size;
      }, 0);
    expect(firstVersion).toStrictEqual({
      version_id: firstVersionId,
      s3_key: `${firstState.s3_prefix}/${firstVersionId}`,
      size: firstSize,
      archive_size: firstArchive.length,
      file_count: 3,
      message: null,
      created_by: "user",
    });

    const tar = gunzipSync(firstArchive);
    const encodedMtime = tar
      .subarray(136, 148)
      .toString("ascii")
      .replaceAll("\0", "")
      .trim();
    expect(Number.parseInt(encodedMtime, 8)).toBe(0);

    const secondInstruction = "# immutable volume two";
    const secondFiles = [
      { path: "alpha.txt", content: "alpha two" },
      { path: "zeta.txt", content: "zeta two" },
    ];
    await updateWorkflow(actor, workflow.body.id, {
      instruction: secondInstruction,
      files: secondFiles,
    });
    const secondState = await readWorkflowStorageState(actor, workflow.body.id);
    if (!secondState?.head_version_id) {
      throw new Error("Expected the second workflow volume version");
    }
    const secondVersionId = secondState.head_version_id;
    expect(secondVersionId).not.toBe(firstVersionId);

    s3.clearWrites();
    await updateWorkflow(actor, workflow.body.id, {
      instruction: firstInstruction,
      files: [...firstFiles].reverse(),
    });
    expect(s3.writes).toHaveLength(0);
    expect(
      (await readWorkflowStorageState(actor, workflow.body.id))
        ?.head_version_id,
    ).toBe(firstVersionId);

    await updateWorkflow(actor, workflow.body.id, {
      instruction: secondInstruction,
      files: secondFiles,
    });
    expect(s3.writes).toHaveLength(0);
    expect(
      (await readWorkflowStorageState(actor, workflow.body.id))
        ?.head_version_id,
    ).toBe(secondVersionId);

    await setWorkflowStorageVersionArchiveSize(
      actor,
      workflow.body.id,
      firstVersionId,
      firstArchive.length + 1,
    );
    s3.objects.delete(firstArchiveKey);
    s3.clearWrites();
    let observedRepairPreparation = false;
    s3.beforeNextArchiveWrite(async (key, body) => {
      expect(key).toBe(firstArchiveKey);
      expect(body).toStrictEqual(firstArchive);
      expect(
        (await readWorkflowStorageState(actor, workflow.body.id))
          ?.head_version_id,
      ).toBe(secondVersionId);
      observedRepairPreparation = true;
    });

    await updateWorkflow(actor, workflow.body.id, {
      instruction: firstInstruction,
      files: firstFiles,
    });
    expect(observedRepairPreparation).toBeTruthy();
    expect(
      s3.writes.map((write) => {
        return write.key;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        firstArchiveKey,
        `${firstState.s3_prefix}/${firstVersionId}/manifest.json`,
      ]),
    );
    expect(
      s3.writes.find((write) => {
        return write.key === firstArchiveKey;
      })?.body,
    ).toStrictEqual(firstArchive);
    expect(
      (await readWorkflowStorageState(actor, workflow.body.id))
        ?.head_version_id,
    ).toBe(firstVersionId);
    await expect(
      readWorkflowStorageVersion(actor, workflow.body.id, firstVersionId),
    ).resolves.toMatchObject({ archive_size: firstArchive.length });
  });

  it("repairs workflow archives deterministically across path order and umask", async () => {
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

    const initialState = await readWorkflowStorageState(
      actor,
      workflow.body.id,
    );
    if (!initialState?.head_version_id) {
      throw new Error("Expected the duplicate-path workflow volume version");
    }
    const archiveKey = `${initialState.s3_prefix}/${initialState.head_version_id}/archive.tar.gz`;
    const initialArchive = s3.objects.get(archiveKey);
    if (!initialArchive) {
      throw new Error("Expected the duplicate-path workflow archive");
    }

    s3.objects.delete(archiveKey);
    let observedRepair = false;
    s3.beforeNextArchiveWrite((key, body) => {
      expect(key).toBe(archiveKey);
      expect(body).toStrictEqual(initialArchive);
      observedRepair = true;
    });

    process.umask(0o077);
    await updateWorkflow(actor, workflow.body.id, {
      files: [...duplicateFiles].reverse(),
    });
    process.umask(originalUmask);

    expect(observedRepair).toBeTruthy();
    expect(
      (await readWorkflowStorageState(actor, workflow.body.id))
        ?.head_version_id,
    ).toBe(initialState.head_version_id);
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
      // The detail endpoint resolves the owner to a display name so the UI does
      // not fall back to rendering the raw Clerk `ownerUserId`.
      ownerUserDisplayName: "BDD User",
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
