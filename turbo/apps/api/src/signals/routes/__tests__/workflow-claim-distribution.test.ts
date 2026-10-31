import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readClaimedContentBundle } from "./helpers/claimed-content-bundle";
import {
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

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

async function fixture(
  framework: "claude-code" | "codex" | "pi" = "claude-code",
) {
  const actor = bdd.user({ orgRole: "org:admin" });
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  if (framework !== "claude-code") {
    await createChatEventsFixture(context).configureSubscriptionPiModel(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.CodexExecution]: framework === "codex" },
    );
  }
  const group = runs.configureRunnerGroup();
  bdd.acceptAgentStorageWrites();
  const s3 = installWorkflowVolumeS3Fixture(context);
  const agent = await bdd.createAgent(actor, {
    displayName: "Workflow claim owner",
    visibility: "public",
  });
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

test.each([
  { framework: "claude-code", root: "/home/user/.claude/skills" },
  { framework: "codex", root: "/home/user/.codex/skills" },
  { framework: "pi", root: "/home/user/.pi/agent/skills" },
] as const)(
  "pins complete $framework Workflow bundles at claim, including Workflows added while queued",
  async ({ framework, root }) => {
    const { actor, agent, group, s3 } = await fixture(framework);
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
          files: [
            { path: "reference.md", content: "new attachment" },
            { path: "资料/说明.md", content: "附件内容" },
          ],
        },
      }),
      [200],
    );
    const second = await createWorkflow(actor, agent.agentId, {
      instruction: "newly available",
    });
    await runs.heartbeatRunner(group);
    context.mocks.s3.send.mockClear();
    const claim = await runs.claimRunnerJob(run.runId);
    expect(claim.cliAgentType).toBe(framework);
    expect(context.mocks.s3.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: expect.stringMatching(/^bundles\/v1\//u),
        }),
      }),
    );
    const skill = claim.contentBundles.skills.find((entry) => {
      return entry.mountPath.endsWith(`/${workflow.name}`);
    })!;
    expect(skill.mountPath).toBe(`${root}/${workflow.name}`);
    expect(
      readClaimedContentBundle(
        s3.objects,
        claim.contentBundles.instructions!,
      ).get("instructions.md")?.length,
    ).toBe(0);
    expect(Object.keys(skill).sort()).toStrictEqual([
      "archiveBytes",
      "downloadUrl",
      "mountPath",
      "sha256",
    ]);
    const selected = readClaimedContentBundle(s3.objects, skill);
    expect(selected.get("SKILL.md")?.toString()).toContain(
      "claim-selected body",
    );
    expect(selected.get("reference.md")?.toString()).toBe("new attachment");
    expect(selected.get("资料/说明.md")?.toString()).toBe("附件内容");
    const added = claim.contentBundles.skills.find((entry) => {
      return entry.mountPath.endsWith(`/${second.name}`);
    })!;
    expect(
      readClaimedContentBundle(s3.objects, added).get("SKILL.md")?.toString(),
    ).toContain("newly available");
    await accept(
      detailClient().update({
        headers: headers(actor),
        params: { workflowId: workflow.id },
        body: {
          instruction: "later body",
          files: [{ path: "reference.md", content: "later attachment" }],
        },
      }),
      [200],
    );
    expect(readClaimedContentBundle(s3.objects, skill)).toStrictEqual(selected);
    await finish(run.runId, claim.sandboxToken);
    const next = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the next published version",
    });
    const subsequent = await runs.claimRunnerJob(next.runId);
    const later = subsequent.contentBundles.skills.find((entry) => {
      return entry.mountPath.endsWith(`/${workflow.name}`);
    })!;
    expect(later.sha256).not.toBe(skill.sha256);
    const laterFiles = readClaimedContentBundle(s3.objects, later);
    expect(laterFiles.get("SKILL.md")?.toString()).toContain("later body");
    expect(laterFiles.get("reference.md")?.toString()).toBe("later attachment");
    expect(laterFiles.has("资料/说明.md")).toBeFalsy();
    await finish(next.runId, subsequent.sandboxToken);
  },
);

test("shares a complete package hash across distinct Workflow owners", async () => {
  const { actor, agent, group, s3 } = await fixture();
  const other = await bdd.createAgent(actor, {
    displayName: "Second bundle owner",
  });
  const name = `shared-${randomUUID().slice(0, 8)}`;
  const body = {
    name,
    instruction: "Identical runtime content",
    files: [{ path: "notes.md", content: "Identical attachment" }],
  };
  await createWorkflow(actor, agent.agentId, body);
  await createWorkflow(actor, other.agentId, body);
  await runs.heartbeatRunner(group);
  const references = [];
  for (const agentId of [agent.agentId, other.agentId]) {
    const run = await runs.createThreadRun(actor, {
      agentId,
      prompt: "Use the shared package",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const skill = claim.contentBundles.skills[0]!;
    expect(
      readClaimedContentBundle(s3.objects, skill).get("notes.md")?.toString(),
    ).toBe("Identical attachment");
    references.push(skill);
    await finish(run.runId, claim.sandboxToken);
  }
  expect(references[0]!.sha256).toBe(references[1]!.sha256);
  expect(references[0]!.archiveBytes).toBe(references[1]!.archiveBytes);
});

test("re-evaluates private/public precedence without exposing another member's private Workflow", async () => {
  const { actor, agent, group, s3 } = await fixture();
  const name = `precedence-${randomUUID().slice(0, 8)}`;
  await createWorkflow(actor, agent.agentId, {
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
    claim.contentBundles.skills.map((entry) => {
      return entry.mountPath.split("/").at(-1);
    }),
  ).toStrictEqual([privateWorkflow.name]);
  expect(
    readClaimedContentBundle(s3.objects, claim.contentBundles.skills[0]!)
      .get("SKILL.md")
      ?.toString(),
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
  expect(claim.contentBundles.skills).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        mountPath: expect.stringMatching(new RegExp(`/${renamed}$`, "u")),
      }),
      expect.objectContaining({
        mountPath: expect.stringMatching(
          new RegExp(`/${replacement.name}$`, "u"),
        ),
      }),
    ]),
  );
  await finish(fresh.runId, claim.sandboxToken);
});

test("keeps a large non-ASCII Workflow in its complete package without truncation", async () => {
  const { actor, agent, group, s3 } = await fixture();
  const instruction = "指令\n".repeat(800_000);
  const workflow = await createWorkflow(actor, agent.agentId, { instruction });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  const claim = await runs.claimRunnerJob(run.runId);
  expect(
    Buffer.byteLength(JSON.stringify(claim.contentBundles.skills)),
  ).toBeLessThan(2048);
  const skill = claim.contentBundles.skills.find((entry) => {
    return entry.mountPath.endsWith(`/${workflow.name}`);
  })!;
  const skillMd = readClaimedContentBundle(s3.objects, skill)
    .get("SKILL.md")!
    .toString();
  expect(skillMd.endsWith(`${instruction.trim()}\n`)).toBeTruthy();
  expect(Buffer.byteLength(skillMd)).toBeGreaterThan(4.5 * 1024 * 1024);
  await finish(run.runId, claim.sandboxToken);
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
