import { createHash, randomUUID } from "node:crypto";
import { runnersWorkflowDownloadContract } from "@okouai/api-contracts/contracts/runners";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { runnersRoutes } from "../runners";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

async function fixture() {
  const actor = bdd.user({ orgRole: "org:admin" });
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const group = runs.configureRunnerGroup();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Workflow claim owner",
    visibility: "public",
  });
  const s3 = installWorkflowVolumeS3Fixture(context);
  return { actor, agent, group, s3 };
}

async function createWorkflow(
  actor: ApiTestUser,
  agentId: string,
  body: {
    readonly instruction?: string;
    readonly files?: { path: string; content: string }[];
    readonly name?: string;
    readonly visibility?: "private" | "public";
  } = {},
) {
  return (
    await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsCollectionContract,
      ).create({
        headers: headers(actor),
        body: {
          agentId,
          name: `claim-${randomUUID().slice(0, 8)}`,
          instruction: "original body",
          ...body,
        },
      }),
      [201],
    )
  ).body;
}

async function finish(runId: string, sandboxToken: string) {
  await webhooks.requestAgentComplete(
    { runId, exitCode: 1, error: "Fixture Runner finished" },
    { authorization: `Bearer ${sandboxToken}` },
    [200],
  );
}

test("claims identities and reads current content later, including Workflows added while queued", async () => {
  const { actor, agent, group, s3 } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId, {
    files: [{ path: "reference.md", content: "old attachment" }],
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use the available workflows",
  });
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: {
        instruction: "claim-selected body",
        files: [{ path: "reference.md", content: "new attachment" }],
      },
    }),
    [200],
  );
  const second = await createWorkflow(actor, agent.agentId, {
    instruction: "newly available",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  const skill = claim.storageManifest?.workflowSkills?.find((entry) => {
    return entry.workflowId === workflow.id;
  });
  expect(skill).toStrictEqual({
    workflowId: workflow.id,
    mountPath: expect.stringContaining("/skills/"),
  });
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: {
        instruction: "download-selected body",
        files: [
          { path: "reference.md", content: "download-selected attachment" },
        ],
      },
    }),
    [200],
  );
  const expectedArchive = [...s3.writes].reverse().find((write) => {
    return write.key.startsWith("workflow-attachments/");
  })!.body;
  const downloaded = await runs.downloadWorkflow(
    run.runId,
    workflow.id,
    claim.sandboxToken,
  );
  expect(downloaded.skillMd).toContain("download-selected body");
  expect(downloaded.attachments?.archiveSha256).toBe(
    createHash("sha256").update(expectedArchive).digest("hex"),
  );
  expect(
    (await runs.downloadWorkflow(run.runId, second.id, claim.sandboxToken))
      .skillMd,
  ).toContain("newly available");
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { instruction: "later body" },
    }),
    [200],
  );
  expect(
    (await runs.downloadWorkflow(run.runId, workflow.id, claim.sandboxToken))
      .skillMd,
  ).toContain("later body");
  await finish(run.runId, claim.sandboxToken);
});

test("re-evaluates private/public precedence without exposing another member's private Workflow", async () => {
  const { actor, agent, group } = await fixture();
  const name = `precedence-${randomUUID().slice(0, 8)}`;
  const publicWorkflow = await createWorkflow(actor, agent.agentId, {
    name,
    visibility: "public",
    instruction: "public body",
  });
  const other = bdd.user({ orgId: actor.orgId });
  const foreignPrivate = await createWorkflow(other, agent.agentId, {
    instruction: "foreign private body",
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use the available workflows",
  });
  const privateWorkflow = await createWorkflow(actor, agent.agentId, {
    name,
    instruction: "private body",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  expect(
    claim.storageManifest?.workflowSkills?.map((entry) => {
      return entry.workflowId;
    }),
  ).toStrictEqual([privateWorkflow.id]);
  expect(
    claim.storageManifest?.workflowSkills?.some((entry) => {
      return entry.workflowId === publicWorkflow.id;
    }),
  ).toBeFalsy();
  const denied = await accept(
    setupApp({ context, routes: runnersRoutes })(
      runnersWorkflowDownloadContract,
    ).get({
      params: { runId: run.runId, workflowId: foreignPrivate.id },
      headers: { authorization: `Bearer ${claim.sandboxToken}` },
    }),
    [404],
  );
  expect(denied.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(
    (
      await runs.downloadWorkflow(
        run.runId,
        privateWorkflow.id,
        claim.sandboxToken,
      )
    ).skillMd,
  ).toContain("private body");
  await finish(run.runId, claim.sandboxToken);
});

test("keeps a queued explicit invocation unavailable after its Workflow is deleted", async () => {
  const { actor, agent, group } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: `/${workflow.name}`,
  });
  await accept(
    detailClient().delete({
      headers: headers(actor),
      params: { workflowId: workflow.id },
    }),
    [204],
  );
  await runs.heartbeatRunner(group);
  const rejected = await runs.requestClaimRunnerJob(true, run.runId, [404]);
  expect(rejected.status).toBe(404);
  expect((await runs.readRun(actor, run.runId)).status).toBe("pending");
  await runs.requestCancelRun(actor, run.runId, [200]);
});

test("does not redirect a queued invocation when its renamed Workflow slug is reused", async () => {
  const { actor, agent, group } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: `/${workflow.name}`,
  });
  const renamed = `${workflow.name}-renamed`;
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { name: renamed },
    }),
    [200],
  );
  const replacement = await createWorkflow(actor, agent.agentId, {
    name: workflow.name,
    instruction: "different invocation target",
  });
  await runs.heartbeatRunner(group);
  await runs.requestClaimRunnerJob(true, run.runId, [404]);
  expect((await runs.readRun(actor, run.runId)).status).toBe("pending");
  await runs.requestCancelRun(actor, run.runId, [200]);

  const fresh = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: `/${renamed}`,
  });
  const claim = await runs.claimRunnerJob(fresh.runId);
  expect(claim.storageManifest?.workflowSkills).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        workflowId: workflow.id,
        mountPath: expect.stringMatching(new RegExp(`/${renamed}$`, "u")),
      }),
      expect.objectContaining({ workflowId: replacement.id }),
    ]),
  );
  await finish(fresh.runId, claim.sandboxToken);
});

test("keeps a large non-ASCII instruction out of claim and downloads it without truncation", async () => {
  const { actor, agent, group } = await fixture();
  const instruction = "指令\n".repeat(800_000);
  const workflow = await createWorkflow(actor, agent.agentId, { instruction });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  expect(
    Buffer.byteLength(JSON.stringify(claim.storageManifest?.workflowSkills)),
  ).toBeLessThan(256);
  const skill = await runs.downloadWorkflow(
    run.runId,
    workflow.id,
    claim.sandboxToken,
  );
  expect(skill.skillMd.endsWith(`${instruction.trim()}\n`)).toBeTruthy();
  expect(Buffer.byteLength(skill.skillMd)).toBeGreaterThan(4.5 * 1024 * 1024);
  await finish(run.runId, claim.sandboxToken);
});

test("reads authoritative empty text and denies foreign, deleted and ended Run downloads", async () => {
  const { actor, agent, group } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId);
  const otherAgent = await bdd.createAgent(actor, {
    displayName: "Another Workflow owner",
  });
  const foreignWorkflow = await createWorkflow(actor, otherAgent.agentId);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Current download authorization",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  const client = setupApp({ context, routes: runnersRoutes })(
    runnersWorkflowDownloadContract,
  );
  const auth = { authorization: `Bearer ${claim.sandboxToken}` };
  await accept(
    client.get({
      headers: auth,
      params: { runId: run.runId, workflowId: foreignWorkflow.id },
    }),
    [404],
  );
  await accept(
    client.get({
      headers: auth,
      params: { runId: randomUUID(), workflowId: workflow.id },
    }),
    [404],
  );
  await accept(
    client.get({
      headers: {},
      params: { runId: run.runId, workflowId: workflow.id },
    }),
    [401],
  );
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { instruction: "", files: [] },
    }),
    [200],
  );
  const empty = await accept(
    client.get({
      headers: auth,
      params: { runId: run.runId, workflowId: workflow.id },
    }),
    [200],
  );
  expect(empty.body).toStrictEqual({
    workflowId: workflow.id,
    skillMd: `---\nname: ${workflow.name}\ndescription: ${workflow.name}\n---\n`,
    attachments: null,
  });
  await accept(
    detailClient().delete({
      headers: headers(actor),
      params: { workflowId: workflow.id },
    }),
    [204],
  );
  await accept(
    client.get({
      headers: auth,
      params: { runId: run.runId, workflowId: workflow.id },
    }),
    [404],
  );
  const survivingWorkflow = await createWorkflow(actor, agent.agentId);
  await runs.downloadWorkflow(
    run.runId,
    survivingWorkflow.id,
    claim.sandboxToken,
  );
  await finish(run.runId, claim.sandboxToken);
  await accept(
    client.get({
      headers: auth,
      params: { runId: run.runId, workflowId: survivingWorkflow.id },
    }),
    [404],
  );
});

test("downloads authoritative empty attachments after a clear", async () => {
  const { actor, agent, group } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId, {
    files: [{ path: "keep.md", content: "claimed attachment" }],
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  expect(
    (await runs.downloadWorkflow(run.runId, workflow.id, claim.sandboxToken))
      .attachments,
  ).not.toBeNull();
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { files: [] },
    }),
    [200],
  );
  expect(
    (await runs.downloadWorkflow(run.runId, workflow.id, claim.sandboxToken))
      .attachments,
  ).toBeNull();
  await finish(run.runId, claim.sandboxToken);
  await bdd.deleteAgent(actor, agent.agentId);
});

test("preserves a running Agent after rejected completion and accepts cancellation acknowledgement", async () => {
  const { actor, agent, group } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId, {
    files: [{ path: "keep.md", content: "claimed attachment" }],
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { files: [] },
    }),
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: run.runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: randomUUID(),
        cliAgentSessionHistoryDisposition: "native_only",
        storageOutputs: [
          {
            name: "unclaimed-output",
            mountPath: "/unclaimed-output",
            version: "a".repeat(64),
          },
        ],
      },
    },
    { authorization: `Bearer ${claim.sandboxToken}` },
    [400],
  );
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    status: "running",
  });
  const blocked = await bdd.requestDeleteAgent(actor, agent.agentId, [409]);
  expect(blocked.body).toMatchObject({ error: { code: "CONFLICT" } });
  await runs.requestCancelRun(actor, run.runId, [200]);
  await flushWaitUntilForTest();
  await finish(run.runId, claim.sandboxToken);
  await flushWaitUntilForTest();
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    status: "cancelled",
  });
  await bdd.deleteAgent(actor, agent.agentId);
});

test("preserves another Agent's readable Workflow files after parent deletion", async () => {
  const { actor, agent, s3 } = await fixture();
  await createWorkflow(actor, agent.agentId, {
    files: [{ path: "remove.md", content: "remove" }],
  });
  bdd.acceptAgentStorageWrites();
  const otherAgent = await bdd.createAgent(actor, {
    displayName: "Surviving owner",
  });
  installWorkflowVolumeS3Fixture(context, s3.objects);
  const survivor = await createWorkflow(actor, otherAgent.agentId, {
    files: [{ path: "keep.md", content: "keep" }],
  });
  await bdd.deleteAgent(actor, agent.agentId);
  const read = await accept(
    detailClient().get({
      headers: headers(actor),
      params: { workflowId: survivor.id },
    }),
    [200],
  );
  expect(read.body.fileContents).toStrictEqual([
    { path: "keep.md", content: "keep" },
  ]);
});
