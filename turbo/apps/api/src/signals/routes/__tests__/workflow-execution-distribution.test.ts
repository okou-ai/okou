import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { instructionsRoutes } from "../instructions";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import {
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { holdDownloadSigning } from "./helpers/hold-download-signing";
import { publicRunOwner } from "./helpers/public-run-owner";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);
const chatFixture = createChatEventsFixture(context);

function headers(actor: ApiTestUser) {
  // This suite exercises member Workflow distribution and visibility.
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
    await chatFixture.configureSubscriptionPiModel(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.CodexExecution]: framework === "codex" },
    );
  }
  const group = await runs.configureRunnerGroup();
  bdd.acceptStorageWrites();
  const s3 = installWorkflowVolumeS3Fixture(context);
  return { actor, group, s3 };
}

function saveInstructions(actor: ApiTestUser, content: string) {
  const client = setupApp({ context, routes: instructionsRoutes })(
    instructionsContract,
  );
  return accept(
    client.update({ headers: headers(actor), body: { content } }),
    [200],
  );
}

async function createWorkflow(
  actor: ApiTestUser,
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
          name: `execution-${randomUUID().slice(0, 8)}`,
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
  { framework: "claude-code" },
  { framework: "codex" },
  { framework: "pi" },
] as const)(
  "pins complete $framework Workflow bundles at dispatch, including Workflows added while queued",
  async ({ framework }) => {
    const { actor, group, s3 } = await fixture(framework);
    await saveInstructions(actor, "Dispatch-time personal Instructions");
    const workflow = await createWorkflow(actor, {
      files: [{ path: "reference.md", content: "old attachment" }],
    });
    const queued = await chatFixture.queueChatRun(actor, {
      prompt: "Use the available workflows",
    });
    await accept(
      detailClient().update({
        headers: headers(actor),
        params: { workflowId: workflow.id },
        body: {
          instruction: "execution-selected body",
          files: [
            { path: "reference.md", content: "new attachment" },
            { path: "资料/说明.md", content: "附件内容" },
          ],
        },
      }),
      [200],
    );
    const second = await createWorkflow(actor, {
      instruction: "newly available",
    });
    context.mocks.s3.send.mockClear();
    const run = await queued.launch();
    await runs.heartbeatRunner(group);
    const execution = await runs.executionInput(run.runId);
    expect(execution.cliAgentType).toBe(framework);
    expect(context.mocks.s3.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: expect.stringMatching(/^bundles\/v1\//u),
        }),
      }),
    );
    const skill = execution.startupInputs.contentBundles.skills.find(
      (entry) => {
        return entry.name === workflow.name;
      },
    )!;
    expect(
      readExecutionContentBundle(
        s3.objects,
        execution.startupInputs.contentBundles.instructions!,
      )
        .get("instructions.md")
        ?.toString(),
    ).toBe("Dispatch-time personal Instructions");
    expect(Object.keys(skill).sort()).toStrictEqual(["bundle", "name"]);
    const selected = readExecutionContentBundle(s3.objects, skill.bundle);
    expect(selected.get("SKILL.md")?.toString()).toContain(
      "execution-selected body",
    );
    expect(selected.get("reference.md")?.toString()).toBe("new attachment");
    expect(selected.get("资料/说明.md")?.toString()).toBe("附件内容");
    const added = execution.startupInputs.contentBundles.skills.find(
      (entry) => {
        return entry.name === second.name;
      },
    )!;
    expect(
      readExecutionContentBundle(s3.objects, added.bundle)
        .get("SKILL.md")
        ?.toString(),
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
    expect(readExecutionContentBundle(s3.objects, skill.bundle)).toStrictEqual(
      selected,
    );
    await finish(run.runId, execution.sandboxToken);
    const next = await runs.createThreadRun(actor, {
      prompt: "Use the next published version",
    });
    const subsequent = await runs.executionInput(next.runId);
    const later = subsequent.startupInputs.contentBundles.skills.find(
      (entry) => {
        return entry.name === workflow.name;
      },
    )!;
    expect(later.bundle.sha256).not.toBe(skill.bundle.sha256);
    const laterFiles = readExecutionContentBundle(s3.objects, later.bundle);
    expect(laterFiles.get("SKILL.md")?.toString()).toContain("later body");
    expect(laterFiles.get("reference.md")?.toString()).toBe("later attachment");
    expect(laterFiles.has("资料/说明.md")).toBeFalsy();
    await finish(next.runId, subsequent.sandboxToken);
  },
);

test("shares a complete package hash across distinct Workflow owners", async () => {
  const { actor, group, s3 } = await fixture();
  const other = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
  await bdd.completeOnboarding(other);
  await runs.ensurePersonalSubscriptionModel(other, {
    model: "claude-fable-5-1",
  });
  const name = `shared-${randomUUID().slice(0, 8)}`;
  const body = {
    name,
    instruction: "Identical runtime content",
    files: [{ path: "notes.md", content: "Identical attachment" }],
  };
  await createWorkflow(actor, body);
  await createWorkflow(other, body);
  await runs.heartbeatRunner(group);
  const references = [];
  for (const member of [actor, other]) {
    const run = await runs.createThreadRun(member, {
      prompt: "Use the shared package",
    });
    const execution = await runs.executionInput(run.runId);
    const skill = execution.startupInputs.contentBundles.skills[0]!;
    expect(
      readExecutionContentBundle(s3.objects, skill.bundle)
        .get("notes.md")
        ?.toString(),
    ).toBe("Identical attachment");
    references.push(skill);
    await finish(run.runId, execution.sandboxToken);
  }
  expect(references[0]!.bundle.sha256).toBe(references[1]!.bundle.sha256);
  expect(references[0]!.bundle.archiveBytes).toBe(
    references[1]!.bundle.archiveBytes,
  );
});

test("re-evaluates private/public precedence without exposing another member's private Workflow", async () => {
  const { actor, group, s3 } = await fixture();
  const name = `precedence-${randomUUID().slice(0, 8)}`;
  await createWorkflow(actor, {
    name,
    visibility: "public",
    instruction: "public body",
  });
  const other = bdd.user({ orgId: actor.orgId });
  await createWorkflow(other, {
    instruction: "foreign private body",
  });
  const queued = await chatFixture.queueChatRun(actor, {
    prompt: "Use the available workflows",
  });
  const privateWorkflow = await createWorkflow(actor, {
    name,
    instruction: "private body",
  });
  const run = await queued.launch();
  await runs.heartbeatRunner(group);
  const execution = await runs.executionInput(run.runId);
  expect(
    execution.startupInputs.contentBundles.skills.map((entry) => {
      return entry.name;
    }),
  ).toStrictEqual([privateWorkflow.name, ...BUILT_IN_SKILLS]);
  expect(
    readExecutionContentBundle(
      s3.objects,
      execution.startupInputs.contentBundles.skills[0]!.bundle,
    )
      .get("SKILL.md")
      ?.toString(),
  ).toContain("private body");
  await finish(run.runId, execution.sandboxToken);
});

test.each(["sharing withdrawal", "rename", "deletion"] as const)(
  "keeps the accepted Workflow after %s during startup",
  async (change) => {
    const { actor, s3 } = await fixture();
    const owner = publicRunOwner(context, actor);
    await owner.run(async () => {
      if (change === "rename") {
        await saveInstructions(actor, "Accepted personal Instructions");
      }
      const author = bdd.user({ orgId: actor.orgId });
      const workflow = await createWorkflow(author, {
        visibility: "public",
        instruction: `Content whose sharing can be withdrawn by its author.\n${randomUUID()}`,
      });
      const signing = holdDownloadSigning(context);
      const renamed = `${workflow.name}-renamed`;
      const clientEventId = randomUUID();
      const sent = await chatFixture.chat.requestSendEvent(
        actor,
        {
          prompt: "Use the available workflows",
          clientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the workflow user's prompt to be accepted");
      }
      const revocation = await settleIncludingAbort(async () => {
        await signing.waitForPending();
        const request = {
          headers: headers(author),
          params: { workflowId: workflow.id },
        };
        if (change === "sharing withdrawal") {
          await accept(
            setupApp({ context, routes: workflowsRoutes })(
              workflowVisibilityContract,
            ).demote(request),
            [200],
          );
        } else if (change === "rename") {
          await accept(
            detailClient().update({
              ...request,
              body: {
                name: renamed,
                instruction: "Updated Workflow instructions",
              },
            }),
            [200],
          );
          await saveInstructions(actor, "Updated personal Instructions");
        } else {
          await accept(detailClient().delete(request), [204]);
        }
      });
      signing.release();
      if (!revocation.ok) {
        throw revocation.error;
      }
      await flushWaitUntilForTest();
      const { events } = await chatFixture.chat.listThreadEvents(
        actor,
        sent.body.threadId,
      );
      const runId = events.find((event) => {
        return event.revokesEventId === clientEventId;
      })?.runId;
      if (!runId) {
        throw new Error("Expected the admitted prompt to identify its Run");
      }
      const accepted = await owner.executionInput(runId);
      const mounted = accepted.startupInputs.contentBundles.skills.find(
        (entry) => {
          return entry.name === workflow.name;
        },
      );
      if (!mounted) {
        throw new Error("Expected the accepted Workflow mount");
      }
      expect(
        readExecutionContentBundle(s3.objects, mounted.bundle)
          .get("SKILL.md")
          ?.toString(),
      ).toContain("Content whose sharing can be withdrawn by its author");
      if (change === "rename") {
        const instructions = accepted.startupInputs.contentBundles.instructions;
        if (!instructions) {
          throw new Error("Expected the accepted Instructions bundle");
        }
        expect(
          readExecutionContentBundle(s3.objects, instructions)
            .get("instructions.md")
            ?.toString(),
        ).toBe("Accepted personal Instructions");
      }
      await finish(runId, accepted.sandboxToken);

      const next = await runs.createThreadRun(actor, {
        threadId: sent.body.threadId,
        prompt: "Continue with the remaining authorized workflows",
      });
      const execution = await owner.executionInput(next.runId);
      expect(
        execution.startupInputs.contentBundles.skills.some((skill) => {
          return skill.name === workflow.name;
        }),
      ).toBeFalsy();
      if (change === "rename") {
        const instructions =
          execution.startupInputs.contentBundles.instructions;
        if (!instructions) {
          throw new Error("Expected the updated Instructions bundle");
        }
        expect(
          readExecutionContentBundle(s3.objects, instructions)
            .get("instructions.md")
            ?.toString(),
        ).toBe("Updated personal Instructions");
        const nextMount = execution.startupInputs.contentBundles.skills.find(
          (entry) => {
            return entry.name === renamed;
          },
        );
        if (!nextMount) {
          throw new Error("Expected the latest Workflow mount");
        }
        expect(
          readExecutionContentBundle(s3.objects, nextMount.bundle)
            .get("SKILL.md")
            ?.toString(),
        ).toContain("Updated Workflow instructions");
      }
      await finish(next.runId, execution.sandboxToken);
    });
  },
);

test("invokes the caller's Private Workflow when Public and foreign Private Workflows share its slug", async () => {
  const { actor, group, s3 } = await fixture();
  const name = `invoked-${randomUUID().slice(0, 8)}`;
  await createWorkflow(actor, {
    name,
    visibility: "public",
    instruction: "public body",
  });
  await createWorkflow(bdd.user({ orgId: actor.orgId }), {
    name,
    instruction: "foreign private body",
  });
  await createWorkflow(actor, {
    name,
    instruction: "private body",
  });
  const run = await runs.createThreadRun(actor, {
    prompt: `/${name} summarize today`,
  });
  await runs.heartbeatRunner(group);
  // Execution preparation mounts this slug's current winner.
  const execution = await runs.executionInput(run.runId);
  const skill = execution.startupInputs.contentBundles.skills.find((entry) => {
    return entry.name === name;
  })!;
  expect(
    readExecutionContentBundle(s3.objects, skill.bundle)
      .get("SKILL.md")
      ?.toString(),
  ).toContain("private body");
  await finish(run.runId, execution.sandboxToken);
});

test("an ordinary Automation invokes the name of its bound Workflow package", async () => {
  const { actor, s3 } = await fixture();
  const owner = publicRunOwner(context, actor);
  await owner.run(async () => {
    const author = bdd.user({ orgId: actor.orgId });
    const shared = await createWorkflow(author, {
      visibility: "public",
      name: "morning-brief",
      instruction: "Shared Automation workflow",
    });
    const shadow = await createWorkflow(actor, {
      visibility: "private",
      name: shared.name,
      instruction: "Caller's private Workflow with the same name",
    });
    const automation = chatFixture.threadPiAutomationsClient();
    const created = await accept(
      automation.create({
        headers: headers(actor),
        params: { workflowId: shared.id },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const launch = async () => {
      return (
        await accept(
          automation.run({
            headers: headers(actor),
            params: { id: created.body.id },
          }),
          [201],
        )
      ).body.chatThreadId;
    };
    const threadId = await launch();
    await flushWaitUntilForTest();
    const rejected = await chatFixture.chat.listThreadEvents(actor, threadId);
    expect(rejected.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        error: "conflict",
      }),
    );
    expect(rejected.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        content: "The Automation's Workflow package is unavailable",
      }),
    );

    await accept(
      detailClient().update({
        headers: headers(actor),
        params: { workflowId: shadow.id },
        body: { name: `${shadow.name}-private` },
      }),
      [200],
    );
    await expect(launch()).resolves.toBe(threadId);
    const runId = await chatFixture.lastThreadPiAutomationRun(actor, threadId);
    const execution = await owner.executionInput(runId);
    expect(execution.prompt.split("\n", 1)[0]).toBe("/morning-brief");
    const mounted = execution.startupInputs.contentBundles.skills.find(
      (bundle) => {
        return bundle.name === shared.name;
      },
    );
    if (!mounted) {
      throw new Error("Expected the Automation's selected Workflow mount");
    }
    expect(
      readExecutionContentBundle(s3.objects, mounted.bundle)
        .get("SKILL.md")
        ?.toString(),
    ).toContain("Shared Automation workflow");

    await expect(launch()).resolves.toBe(threadId);
    const renamed = `${shared.name}-new`;
    await accept(
      detailClient().update({
        headers: headers(author),
        params: { workflowId: shared.id },
        body: { name: renamed, instruction: "Renamed Automation Workflow" },
      }),
      [200],
    );
    await finish(runId, execution.sandboxToken);
    const queuedRunId = await chatFixture.lastThreadPiAutomationRun(
      actor,
      threadId,
    );
    expect(queuedRunId).not.toBe(runId);
    const queuedExecution = await owner.executionInput(queuedRunId);
    expect(queuedExecution.prompt.split("\n", 1)[0]).toBe(`/${renamed}`);
    const renamedPackage =
      queuedExecution.startupInputs.contentBundles.skills.find((bundle) => {
        return bundle.name === renamed;
      });
    if (!renamedPackage) {
      throw new Error("Expected the renamed Workflow mount");
    }
    expect(
      readExecutionContentBundle(s3.objects, renamedPackage.bundle)
        .get("SKILL.md")
        ?.toString(),
    ).toContain("Renamed Automation Workflow");
    await finish(queuedRunId, queuedExecution.sandboxToken);
  });
});

test("runs a queued explicit invocation without its deleted Workflow", async () => {
  const { actor, group } = await fixture();
  const workflow = await createWorkflow(actor);
  const queued = await chatFixture.queueChatRun(actor, {
    prompt: `/${workflow.name}`,
  });
  await accept(
    detailClient().delete({
      headers: headers(actor),
      params: { workflowId: workflow.id },
    }),
    [204],
  );
  const run = await queued.launch();
  await runs.heartbeatRunner(group);
  const execution = await runs.executionInput(run.runId);
  expect(
    execution.startupInputs.contentBundles.skills.map((entry) => {
      return entry.name;
    }),
  ).toStrictEqual([...BUILT_IN_SKILLS]);
  await finish(run.runId, execution.sandboxToken);
});

test("mounts the current winner for a queued invocation whose slug is reused", async () => {
  const { actor, group, s3 } = await fixture();
  const workflow = await createWorkflow(actor);
  const queued = await chatFixture.queueChatRun(actor, {
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
  await createWorkflow(actor, {
    name: workflow.name,
    instruction: "different invocation target",
  });
  const run = await queued.launch();
  await runs.heartbeatRunner(group);
  const execution = await runs.executionInput(run.runId);
  const invoked = execution.startupInputs.contentBundles.skills.find(
    (entry) => {
      return entry.name === workflow.name;
    },
  )!;
  expect(
    readExecutionContentBundle(s3.objects, invoked.bundle)
      .get("SKILL.md")
      ?.toString(),
  ).toContain("different invocation target");
  expect(execution.startupInputs.contentBundles.skills).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: renamed,
      }),
    ]),
  );
  await finish(run.runId, execution.sandboxToken);
});

test("keeps a large non-ASCII Workflow in its complete package without truncation", async () => {
  const { actor, group, s3 } = await fixture();
  const instruction = "指令\n".repeat(800_000);
  const workflow = await createWorkflow(actor, { instruction });
  const run = await runs.createThreadRun(actor, {
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  const execution = await runs.executionInput(run.runId);
  const skill = execution.startupInputs.contentBundles.skills.find((entry) => {
    return entry.name === workflow.name;
  })!;
  expect(Buffer.byteLength(JSON.stringify(skill))).toBeLessThan(2048);
  const skillMd = readExecutionContentBundle(s3.objects, skill.bundle)
    .get("SKILL.md")!
    .toString();
  expect(skillMd.endsWith(`${instruction.trim()}\n`)).toBeTruthy();
  expect(Buffer.byteLength(skillMd)).toBeGreaterThan(4.5 * 1024 * 1024);
  await finish(run.runId, execution.sandboxToken);
});

test("preserves a running Agent after rejected completion and accepts cancellation acknowledgement", async () => {
  const { actor, group } = await fixture("claude-code");
  const workflow = await createWorkflow(actor, {
    files: [{ path: "keep.md", content: "execution attachment" }],
  });
  const run = await runs.createThreadRun(actor, {
    prompt: "Use workflows",
  });
  await runs.heartbeatRunner(group);
  const execution = await runs.executionInput(run.runId);
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
    { authorization: `Bearer ${execution.sandboxToken}` },
    [400],
  );
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    status: "running",
  });
  await runs.requestCancelRun(actor, run.runId, [200]);
  await flushWaitUntilForTest();
  await finish(run.runId, execution.sandboxToken);
  await flushWaitUntilForTest();
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    status: "cancelled",
  });
});
