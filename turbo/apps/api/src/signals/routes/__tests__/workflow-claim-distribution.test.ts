import { createHash, randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
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
  mockEnv("WORKFLOW_ATTACHMENT_CLEANUP_ENABLED", "true");
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

async function sweep() {
  mockEnv("CRON_SECRET", "workflow-cleanup-test");
  return await accept(
    setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
      cronProcessBackgroundJobsContract,
    ).process({ headers: { authorization: "Bearer workflow-cleanup-test" } }),
    [200],
  );
}

async function finish(runId: string, sandboxToken: string) {
  await webhooks.requestAgentComplete(
    { runId, exitCode: 1, error: "Fixture Runner finished" },
    { authorization: `Bearer ${sandboxToken}` },
    [200],
  );
}

test("selects a coherent current body and attachment at claim, including Workflows added while queued", async () => {
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
  const expectedArchive = s3.writes.at(-1)!.body;
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  const skill = claim.storageManifest?.workflowSkills?.find((entry) => {
    return entry.workflowId === workflow.id;
  });
  expect(skill?.skillMd).toContain("claim-selected body");
  expect(skill?.attachments?.archiveSha256).toBe(
    createHash("sha256").update(expectedArchive).digest("hex"),
  );
  expect(
    claim.storageManifest?.workflowSkills?.find((entry) => {
      return entry.workflowId === second.id;
    })?.skillMd,
  ).toContain("newly available");
  const captured = skill?.skillMd;
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { instruction: "later body" },
    }),
    [200],
  );
  expect(skill?.skillMd).toBe(captured);
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
  await createWorkflow(other, agent.agentId, {
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

test("leaves a job pending for a preceding Runner and lets the document reader claim it", async () => {
  const { actor, agent, group } = await fixture();
  await createWorkflow(actor, agent.agentId);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  await accept(
    setupApp({ context, routes: runnersRoutes })(runnersJobClaimContract).claim(
      {
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        params: { id: run.runId },
        body: {
          runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 1 },
          capabilities: { piModelConfigGenerations: [2, 3, 5] },
        },
      },
    ),
    [404],
  );
  expect((await runs.readRun(actor, run.runId)).status).toBe("pending");
  const claim = await runs.claimRunnerJob(run.runId);
  expect(claim.storageManifest?.workflowSkills).toHaveLength(1);
  await finish(run.runId, claim.sandboxToken);
});

test("delivers a large non-ASCII instruction without truncating the claim document", async () => {
  const { actor, agent, group } = await fixture();
  const instruction = "指令\n".repeat(800_000);
  await createWorkflow(actor, agent.agentId, { instruction });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  const skill = claim.storageManifest?.workflowSkills?.[0];
  expect(skill?.skillMd.endsWith(`${instruction.trim()}\n`)).toBeTruthy();
  expect(Buffer.byteLength(skill?.skillMd ?? "")).toBeGreaterThan(
    4.5 * 1024 * 1024,
  );
  await finish(run.runId, claim.sandboxToken);
});

test("leaves durable cleanup queued until the deployment cleanup gate is enabled", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, agent, s3 } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId, {
    files: [{ path: "retired.md", content: "retired" }],
  });
  const key = s3.writes[0]!.key;
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { files: [] },
    }),
    [200],
  );
  mockEnv("WORKFLOW_ATTACHMENT_CLEANUP_ENABLED", "false");
  await sweep();
  expect(s3.objects.has(key)).toBeTruthy();
  mockEnv("WORKFLOW_ATTACHMENT_CLEANUP_ENABLED", "true");
  await sweep();
  expect(s3.objects.has(key)).toBeFalsy();
});

test("bounds repeated cleanup provider failures and preserves the undeleted package for investigation", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, agent, s3 } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId, {
    files: [{ path: "retired.md", content: "retired" }],
  });
  const key = s3.writes[0]!.key;
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { files: [] },
    }),
    [200],
  );
  const unavailable = () => {
    s3.beforeNextDelete(unavailable);
    throw new Error("Provider unavailable");
  };
  s3.beforeNextDelete(unavailable);
  mockNow(now() - 86_400_000);
  expect((await sweep()).body.processed).toBe(5);
  expect((await sweep()).body.processed).toBe(0);
  expect(s3.objects.has(key)).toBeTruthy();
});

test("retains retired packages for a pending claim, then binds only its selected current package", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, agent, group, s3 } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId, {
    files: [{ path: "old.md", content: "old" }],
  });
  const oldKey = s3.writes[0]!.key;
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Claim the current workflow",
  });
  await accept(
    detailClient().update({
      headers: headers(actor),
      params: { workflowId: workflow.id },
      body: { files: [{ path: "new.md", content: "new" }] },
    }),
    [200],
  );
  const currentKey = s3.writes.at(-1)!.key;
  const clock = now();
  mockNow(clock - 86_400_000);
  await sweep();
  mockNow(clock);
  expect(s3.objects.has(oldKey)).toBeTruthy();
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  const selected = claim.storageManifest?.workflowSkills?.find((entry) => {
    return entry.workflowId === workflow.id;
  });
  expect(selected?.attachments?.archiveSha256).toBe(
    createHash("sha256").update(s3.objects.get(currentKey)!).digest("hex"),
  );
  await sweep();
  expect(s3.objects.has(oldKey)).toBeFalsy();
  expect(s3.objects.has(currentKey)).toBeTruthy();
  await finish(run.runId, claim.sandboxToken);
});

test("retains claimed attachments through cancellation and clock skew until authenticated Runner completion", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, agent, group, s3 } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId, {
    files: [{ path: "keep.md", content: "claimed attachment" }],
  });
  const oldKey = s3.writes[0]!.key;
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
  await runs.requestCancelRun(actor, run.runId, [200]);
  const clock = now();
  mockNow(clock - 86_400_000);
  await sweep();
  expect(s3.objects.has(oldKey)).toBeTruthy();
  mockNow(clock);
  await bdd.requestDeleteAgent(actor, agent.agentId, [409]);
  await finish(run.runId, claim.sandboxToken);
  await sweep();
  expect(s3.objects.has(oldKey)).toBeFalsy();
  await bdd.deleteAgent(actor, agent.agentId);
});

test("cleans only the exact attachments returned by parent Agent deletion", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, agent, s3 } = await fixture();
  await createWorkflow(actor, agent.agentId, {
    files: [{ path: "remove.md", content: "remove" }],
  });
  const removedKey = s3.writes[0]!.key;
  bdd.acceptAgentStorageWrites();
  const otherAgent = await bdd.createAgent(actor, {
    displayName: "Surviving owner",
  });
  installWorkflowVolumeS3Fixture(context, s3.objects);
  const survivor = await createWorkflow(actor, otherAgent.agentId, {
    files: [{ path: "keep.md", content: "keep" }],
  });
  await bdd.deleteAgent(actor, agent.agentId);
  await sweep();
  expect(s3.objects.has(removedKey)).toBeFalsy();
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

test("cannot publish a candidate after cleanup has started and a provider failure has rescheduled it", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, agent, s3 } = await fixture();
  const workflow = await createWorkflow(actor, agent.agentId);
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  s3.afterNextArchiveWrite(async () => {
    entered.resolve();
    await released.promise;
  });
  const update = detailClient().update({
    headers: headers(actor),
    params: { workflowId: workflow.id },
    body: {
      instruction: "must not publish",
      files: [{ path: "late.md", content: "late bytes" }],
    },
  });
  onTestFinished(async () => {
    if (!released.settled()) {
      released.resolve();
    }
    await update;
  });
  await entered.promise;
  const key = s3.writes.at(-1)!.key;
  s3.beforeNextDelete(() => {
    throw new Error("Injected provider outage");
  });
  const clock = now();
  mockNow(clock - 86_400_000);
  await sweep();
  mockNow(clock);
  released.resolve();
  await accept(update, [409]);
  const read = await accept(
    detailClient().get({
      headers: headers(actor),
      params: { workflowId: workflow.id },
    }),
    [200],
  );
  expect(read.body).toMatchObject({ instruction: "original body", files: [] });
  await sweep();
  expect(s3.objects.has(key)).toBeFalsy();
  expect(
    context.mocks.s3.send.mock.calls.some(([request]) => {
      return (
        request instanceof DeleteObjectsCommand &&
        request.input.Delete?.Objects?.some((object) => {
          return object.Key === key;
        })
      );
    }),
  ).toBeTruthy();
});
