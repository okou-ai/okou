import { claimPublicToolRun } from "./helpers/public-tool-actor";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { commitMemoryVersion } from "./helpers/memory";
import {
  expectCanonicalStorageManifest,
  createRunsApi,
} from "./helpers/api-bdd-runs";
import { afterEach, describe, expect, it } from "vitest";

import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentInstructionsRoutes } from "../agent-instructions";

import { clearMockNow, mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";

import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";

const context = testContext();

afterEach(() => {
  clearMockNow();
});

describe("OPS-01: user data export", () => {
  it("rejects unauthenticated and org-less export requests", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const expectedError = {
      error: { code: "UNAUTHORIZED", message: "Not authenticated" },
    };

    const getUnauthenticated = await api.requestGetUserExport(null, [401]);
    expect(getUnauthenticated.body).toStrictEqual(expectedError);

    const postUnauthenticated = await api.requestPostUserExport(null, [401]);
    expect(postUnauthenticated.body).toStrictEqual(expectedError);

    const orgless = await api.requestPostUserExport(
      bdd.user({ orgId: null }),
      [401],
    );
    expect(orgless.body).toStrictEqual(expectedError);
  });

  it("admits one active export and isolates its public status by owner", async () => {
    const api = createOpsLogsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    installDurableUserExportStorage(context);
    const exportStartAt = Date.UTC(2026, 4, 12, 5);

    mockNow(exportStartAt);
    await expect(api.requestGetUserExport(actor, [200])).resolves.toMatchObject(
      {
        body: { job: null, canExport: true, nextExportAt: null },
      },
    );

    const started = await api.requestPostUserExport(actor, [202]);
    expect(started.body.status).toBe("pending");

    const reposted = await api.requestPostUserExport(actor, [202]);
    expect(reposted.body.jobId).toBe(started.body.jobId);
    expect(["pending", "running"]).toContain(reposted.body.status);

    const active = await api.requestGetUserExport(actor, [200]);
    expect(active.body.job?.id).toBe(started.body.jobId);
    expect(["pending", "running"]).toContain(active.body.job?.status);
    expect(active.body.job?.downloadUrl).toBeNull();
    expect(active.body.canExport).toBeFalsy();

    await flushWaitUntilForTest();
    const peer = bdd.user();
    await expect(api.requestGetUserExport(peer, [200])).resolves.toMatchObject({
      body: { job: null, canExport: true, nextExportAt: null },
    });
  });

  it("keeps public export-source resources and current memory separate from a peer", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const chat = createChatFilesBddApi(context);
    const misc = createMiscRoutesApi(context);
    const runs = createRunsApi(context);
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    installDurableUserExportStorage(context, { prefixes: [""] });
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization for the export actor");
    }
    const runCleanups: (() => Promise<void>)[] = [];
    const fixture = createPublicUnfundedProFixture(context, actor, {
      beforeOrganizationCleanup: async () => {
        for (const cleanup of runCleanups) {
          await cleanup();
        }
      },
    });
    await fixture.initialize();
    await fixture.run(async () => {
      await runs.ensurePersonalSubscriptionModel(actor, {
        model: "claude-fable-5-1",
      });
      const agent = await bdd.createAgent(actor, {
        displayName: "BDD Export Agent",
        visibility: "private",
      });
      await bdd.updateAgentInstructions(
        actor,
        agent.agentId,
        "Use the exported agent instructions.",
      );
      const workflow = await misc.createWorkflow(
        actor,
        agent.agentId,
        "bdd-export-workflow",
        { content: "Use the exported workflow instructions." },
        [201],
      );
      if (!("id" in workflow.body)) {
        throw new Error("Expected workflow creation to return an id");
      }
      const thread = await chat.createThread(actor, {
        agentId: agent.agentId,
        title: "An empty thread worth keeping",
      });
      await chat.pinThread(actor, thread.id, { pinOrder: "a0" });

      const peer = bdd.user({ orgId: actor.orgId });
      const peerOnboarding = await bdd.readOnboardingStatus(peer);
      if (!peerOnboarding.defaultAgentId) {
        throw new Error("Expected the paid organization to onboard the peer");
      }
      const peerOnboarded = await bdd.completeOnboarding(peer);
      if (peerOnboarded.status !== 200) {
        throw new Error("Expected peer onboarding to complete");
      }
      const peerAgent = await bdd.createAgent(peer, { visibility: "private" });
      const peerThread = await chat.createThread(peer, {
        agentId: peerAgent.agentId,
        title: "Another user's private thread",
      });

      const ownThread = await createChatEventsFixture(
        context,
      ).readThreadProjection(actor, thread.id);
      expect(ownThread).toMatchObject({
        id: thread.id,
        title: thread.title,
        agentId: agent.agentId,
        pinOrder: "a0",
      });
      await chat.requestReadThread(actor, peerThread.id, [404]);
      createRouteMocks(context).clerk.session(
        actor.userId,
        actor.orgId,
        actor.orgRole,
      );
      const instructions = await accept(
        setupApp({ context, routes: agentInstructionsRoutes })(
          agentInstructionsContract,
        ).get({
          params: { id: agent.agentId },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(instructions.body).toMatchObject({
        content: "Use the exported agent instructions.",
      });
      const currentWorkflow = await misc.readWorkflow(
        actor,
        workflow.body.id,
        [200],
      );
      expect(currentWorkflow.body).toMatchObject({
        id: workflow.body.id,
        instruction: "Use the exported workflow instructions.",
      });
      const registerRunCleanup = (cleanup: () => Promise<void>) => {
        runCleanups.push(cleanup);
      };
      const oldRun = await claimPublicToolRun(
        context,
        actor,
        registerRunCleanup,
      );
      const oldMemory = await commitMemoryVersion(
        context,
        {
          runId: oldRun.runId,
          sandboxHeaders: {
            authorization: `Bearer ${oldRun.claim.sandboxToken}`,
          },
          storageManifest: oldRun.claim.storageManifest,
        },
        [{ path: "removed.md", content: "An old memory version" }],
      );
      await oldRun.cleanup();
      const currentRun = await claimPublicToolRun(
        context,
        actor,
        registerRunCleanup,
      );
      const memory = await commitMemoryVersion(
        context,
        {
          runId: currentRun.runId,
          sandboxHeaders: {
            authorization: `Bearer ${currentRun.claim.sandboxToken}`,
          },
          storageManifest: currentRun.claim.storageManifest,
        },
        [
          { path: "MEMORY.md", content: "# Exported memory" },
          {
            path: "notes/data.bin",
            content: Buffer.from([0, 255, 254, 128, 10, 13, 0, 1, 2]),
          },
        ],
      );
      expect(memory.storageId).toBe(oldMemory.storageId);
      expect(memory.versionId).not.toBe(oldMemory.versionId);
      await currentRun.cleanup();
      const peerRun = await claimPublicToolRun(
        context,
        peer,
        registerRunCleanup,
      );
      const peerMemory = await commitMemoryVersion(
        context,
        {
          runId: peerRun.runId,
          sandboxHeaders: {
            authorization: `Bearer ${peerRun.claim.sandboxToken}`,
          },
          storageManifest: peerRun.claim.storageManifest,
        },
        [{ path: "peer-secret.md", content: "Another user's memory" }],
      );
      expect(peerMemory.storageId).not.toBe(memory.storageId);
      await peerRun.cleanup();
      const reader = await claimPublicToolRun(
        context,
        actor,
        registerRunCleanup,
      );
      expect(
        expectCanonicalStorageManifest(reader.claim.storageManifest)
          ?.storageMounts,
      ).toContainEqual(
        expect.objectContaining({
          name: "memory",
          storageId: memory.storageId,
          versionId: memory.versionId,
        }),
      );
      await reader.cleanup();
      await bdd.deleteAgent(peer, peerAgent.agentId);
      await bdd.deleteAgent(actor, agent.agentId);
      await flushWaitUntilForTest();
    });
  });
});
