import { createHash } from "node:crypto";
import { cronCleanupSandboxesContract } from "@okouai/api-contracts/contracts/cron";
import {
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
} from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { server } from "../../../mocks/server";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  chat,
  runs,
  webhooks,
  cronHeaders,
  createChatActor,
  prepareMaintenance,
  prepareSources,
  publication,
  publish,
  completeMaintenance,
  observeMemory,
  publishOrdinaryMemory,
  expectBlocked,
} = createPiMemoryMaintenanceFixture(context);

async function cleanupMaintenance() {
  return await accept(
    setupApp({ context, routes: cronCleanupSandboxesRoutes })(
      cronCleanupSandboxesContract,
    ).cleanup({ headers: cronHeaders() }),
    [200],
  );
}

describe("Pi maintenance cleanup and active publication", () => {
  it("keeps an unpublished live Run's output authority through cleanup", async () => {
    const run = await prepareMaintenance();
    await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      run.headers,
      [200],
    );
    await cleanupMaintenance();
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
    await publish(run);
  });

  it.each(["published", "no-diff"])(
    "retains an active %s result through cleanup with queued owned updates",
    async (outcome) => {
      const run = await prepareMaintenance();
      const first = await publish(
        run,
        outcome === "published" ? "First serial memory.\n" : undefined,
      );
      expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
      await publishOrdinaryMemory(run, "Queued owned update.\n", 1);
      await expectBlocked(run);
      await webhooks.requestAgentHeartbeat(
        { runId: run.runId },
        run.headers,
        [200],
      );
      await cleanupMaintenance();
      expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
      const prepared = await webhooks.requestAgentStoragePrepare(
        first,
        run.headers,
        [200],
      );
      expect(prepared.body).toMatchObject({
        versionId: first.versionId,
        existing: true,
      });
      const replay = await webhooks.requestAgentStorageCommit(
        first,
        run.headers,
        [200],
      );
      expect(replay.body).toMatchObject({
        versionId: first.versionId,
        deduplicated: true,
      });
      await completeMaintenance(
        run,
        run.maintenance.claimedBaseVersionId,
        true,
      );
      await expect(runs.readRun(run.actor, run.runId)).resolves.toMatchObject({
        status: "completed",
        result: { storageOutputs: [{ version: first.versionId }] },
      });
    },
  );

  it("closes a published Run's output authority only after the real heartbeat timeout transition", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run, "Accepted before heartbeat silence.\n");
    await publishOrdinaryMemory(
      run,
      "Owned memory queued behind the silent Run.\n",
      1,
    );
    await expectBlocked(run);
    await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      run.headers,
      [200],
    );
    mockNow(now() + 2 * 60 * 1000 + 1000);
    await cleanupMaintenance();
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("timeout");
    const late = await completeMaintenance(run, first.versionId);
    expect(late.response.body).toMatchObject({ status: "failed" });
  });

  it("preserves new maintenance output when a timed-out publisher completes late", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run, "Accepted before heartbeat silence.\n");
    await publishOrdinaryMemory(
      run,
      "Owned memory queued behind the silent Run.\n",
      1,
    );
    await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      run.headers,
      [200],
    );
    mockNow(now() + 2 * 60 * 1000 + 1000);
    await cleanupMaintenance();
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("timeout");
    const dispatched = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0 });
    const next = await run.claimMaintenance();
    const latest = await publish(next, "Memory after authoritative timeout.\n");
    await completeMaintenance(next, latest.versionId);
    const late = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.runId,
          cliAgentSessionHistoryDisposition: "native_only",
          storageOutputs: [
            {
              name: run.memory.name,
              mountPath: run.memory.mountPath,
              version: first.versionId,
            },
          ],
        },
      },
      run.headers,
      [200],
    );
    expect(late.body).toMatchObject({ success: true, status: "failed" });
    await flushWaitUntilForTest();
    expect(
      (await observeMemory(run, "Memory after authoritative timeout.\n")).memory
        .versionId,
    ).toBe(latest.versionId);
  });

  it.each(["failed", "cancelled"])(
    "waits for actual deletion of an unrecovered %s Run",
    async (status) => {
      const run = await prepareMaintenance();
      const first = await publish(
        run,
        "Accepted before unrecovered terminal failure.\n",
      );
      if (status === "cancelled") {
        await runs.requestCancelRun(run.actor, run.runId, [200]);
      }
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "Runner fallback has no recovery output",
        },
        run.headers,
        [200],
      );
      await flushWaitUntilForTest();
      expect((await runs.readRun(run.actor, run.runId)).status).toBe(status);
      const ordinary = await publishOrdinaryMemory(
        run,
        "Queued owned memory survives terminal cleanup.\n",
      );
      await expectBlocked(run);
      // Use the existing private usage/cleanup lifetime; time alone still cannot
      // admit B. Only the authenticated cleanup's actual Run deletion closes A.
      mockNow(
        now() +
          AGENT_EXECUTION_TIMEOUT_SECONDS * 1000 +
          CANCELLATION_RECOVERY_STALE_AFTER_MS +
          1000,
      );
      await expectBlocked(run);
      await cleanupMaintenance();
      await runs.requestReadRun(run.actor, run.runId, [404]);
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1 },
        run.headers,
        [404],
      );
      await webhooks.requestAgentStorageCommit(first, run.headers, [404]);
      const admitted = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(admitted.body).toMatchObject({ claimed: 1, failed: 0 });
      const next = await run.claimMaintenance();
      expect(next.maintenance.claimedBaseVersionId).toBe(ordinary.versionId);
      const latest = await publish(
        next,
        "Maintenance after actual terminal deletion.\n",
      );
      await completeMaintenance(next, latest.versionId);
      expect(
        (
          await observeMemory(
            run,
            "Maintenance after actual terminal deletion.\n",
          )
        ).memory.versionId,
      ).toBe(latest.versionId);
    },
  );
});

describe("Pi maintenance publication ownership", () => {
  it.each(["the same organization", "another organization"])(
    "rejects foreign claims, foreign memory and altered launch evidence from %s",
    async (scope) => {
      const run = await prepareMaintenance();
      const peer = await createChatActor(
        run.runnerGroup,
        scope === "the same organization" ? run.actor.orgId : undefined,
        "claude-fable-5-1",
      );
      const ordinary = await chat.sendChatRun(peer.actor, {
        agentId: peer.agentId,
        prompt: "Own another user's memory",
        model: "claude-fable-5-1",
      });
      const claimed = await chat.claimChatRun(peer.runnerGroup, ordinary.runId);
      const foreignMemory = expectCanonicalStorageManifest(
        claimed.claim.storageManifest,
      )?.storageMounts.find((mount) => {
        return mount.name === "memory";
      });
      if (!foreignMemory) {
        throw new Error("Expected the peer's actual memory mount");
      }
      expect(foreignMemory.storageId).not.toBe(run.memory.storageId);
      await runs.requestReadRun(peer.actor, run.runId, [404]);
      const body = publication(run);
      for (const request of [
        webhooks.requestAgentStoragePrepare,
        webhooks.requestAgentStorageCommit,
      ]) {
        await request(body, claimed.sandboxHeaders, [401]);
        await request(
          { ...body, storageId: foreignMemory.storageId },
          run.headers,
          [404],
        );
        await request(
          {
            ...body,
            maintenanceAttestation: {
              ...body.maintenanceAttestation,
              claimedRevision: body.maintenanceAttestation.claimedRevision + 1,
            },
          },
          run.headers,
          [404],
        );
        await request(
          {
            ...body,
            maintenanceAttestation: {
              ...body.maintenanceAttestation,
              selectionDigest: createHash("sha256")
                .update("foreign selection")
                .digest("hex"),
            },
          },
          run.headers,
          [404],
        );
      }
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1 },
        claimed.sandboxHeaders,
        [401],
      );
      const published = await publish(run);
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "pi",
            cliAgentSessionId: ordinary.runId,
            cliAgentSessionHistoryDisposition: "native_only",
            storageOutputs: [
              {
                name: run.memory.name,
                mountPath: run.memory.mountPath,
                version: published.versionId,
              },
            ],
          },
        },
        run.headers,
        [400],
      );
      await completeMaintenance(run, published.versionId);
      await webhooks.requestAgentComplete(
        {
          runId: ordinary.runId,
          exitCode: 1,
          error: "Peer ownership check complete",
        },
        claimed.sandboxHeaders,
        [200],
      );
      expect((await observeMemory(run)).memory.versionId).toBe(
        published.versionId,
      );
    },
  );
});

// Only the external extraction provider is controlled; construction and observations
// use the same authenticated cron, chat, Runner and storage protocols as production.
function extractionResponse(
  options: {
    readonly status?: number;
    readonly noOutput?: boolean;
    readonly beforeResponse?: () => void | Promise<void>;
  } = {},
) {
  server.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", async () => {
      await options.beforeResponse?.();
      if (options.status) {
        return HttpResponse.json(
          { error: { message: "Provider rejected extraction" } },
          { status: options.status },
        );
      }
      const content = JSON.stringify({
        raw_memory: options.noOutput
          ? ""
          : "This user prefers focused public API tests.",
        rollout_summary: options.noOutput
          ? ""
          : "The user asked for focused public API coverage.",
        rollout_slug: options.noOutput ? null : "public-api-tests",
      });
      const chunks = [
        {
          id: "chatcmpl_reconciliation",
          object: "chat.completion.chunk",
          model: "@preset/memory",
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        },
        {
          id: "chatcmpl_reconciliation",
          object: "chat.completion.chunk",
          model: "@preset/memory",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        },
      ];
      return new HttpResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const body =
              chunks
                .map((chunk) => {
                  return `data: ${JSON.stringify(chunk)}\n\n`;
                })
                .join("") + "data: [DONE]\n\n";
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
}

describe("Stage 1 result publication", () => {
  it.each([false, true])(
    "settles admitted output across midnight (no output: %s) and rejects replay",
    async (noOutput) => {
      const beforeMidnight = new Date(now());
      beforeMidnight.setUTCHours(23, 58, 0, 0);
      mockNow(beforeMidnight);
      const source = await prepareSources();
      extractionResponse({
        noOutput,
        beforeResponse: () => {
          mockNow(now() + 3 * 60 * 1000);
        },
      });
      const settled = await accept(
        source.stage1.extract({ headers: cronHeaders() }),
        [200],
      );
      expect(settled.body).toMatchObject({
        succeeded: noOutput ? 0 : 1,
        succeededNoOutput: noOutput ? 1 : 0,
        staleDiscarded: 0,
        terminalFailure: 0,
        retryableFailure: 0,
      });
      const dispatched = await accept(
        source.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(dispatched.body).toMatchObject({
        claimed: 1,
        // The existing Phase 2 credential boundary declines an empty selection.
        failed: noOutput ? 1 : 0,
        stale: 0,
      });
      if (noOutput) {
        expect((await runs.pollRunner(source.runnerGroup)).body.job).toBeNull();
        const initialMemory = expectCanonicalStorageManifest(
          source.sourceClaim.claim.storageManifest,
        )?.storageMounts.find((mount) => {
          return mount.name === "memory";
        });
        if (!initialMemory) {
          throw new Error("Expected the source Run's actual memory mount");
        }
        expect((await observeMemory(source)).memory.versionId).toBe(
          initialMemory.versionId,
        );
      } else {
        const run = { ...source, ...(await source.claimMaintenance()) };
        const published = await publish(
          run,
          "Memory from admitted output across midnight.\n",
        );
        await completeMaintenance(run, published.versionId);
        expect(
          (
            await observeMemory(
              run,
              "Memory from admitted output across midnight.\n",
            )
          ).memory.versionId,
        ).toBe(published.versionId);
      }
      const replay = await accept(
        source.stage1.extract({ headers: cronHeaders() }),
        [200],
      );
      expect(replay.body).toMatchObject({
        claimed: 0,
        succeeded: 0,
        succeededNoOutput: 0,
      });
      const repeated = await accept(
        source.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(repeated.body).toMatchObject({ claimed: 0, noWork: 1 });
    },
  );

  it("retries a provider failure only after its ordinary retry deadline, then publishes once", async () => {
    // A future UTC noon keeps auth valid and the retry in the admitted day.
    const daytime = new Date(now() + 24 * 60 * 60 * 1000);
    daytime.setUTCHours(12, 0, 0, 0);
    mockNow(daytime);
    const source = await prepareSources();
    extractionResponse({ status: 400 });
    const failed = await accept(
      source.stage1.extract({ headers: cronHeaders() }),
      [200],
    );
    expect(failed.body).toMatchObject({
      retryableFailure: 1,
      succeeded: 0,
      terminalFailure: 0,
      staleDiscarded: 0,
    });
    expect(
      (
        await accept(
          source.stage2.consolidate({ headers: cronHeaders() }),
          [200],
        )
      ).body,
    ).toMatchObject({ claimed: 0, noWork: 1 });
    expect(
      (await accept(source.stage1.extract({ headers: cronHeaders() }), [200]))
        .body,
    ).toMatchObject({ claimed: 0 });
    extractionResponse();
    mockNow(now() + 60 * 60 * 1000);
    expect(
      (await accept(source.stage1.extract({ headers: cronHeaders() }), [200]))
        .body,
    ).toMatchObject({ succeeded: 1, retryableFailure: 0, staleDiscarded: 0 });
    expect(
      (
        await accept(
          source.stage2.consolidate({ headers: cronHeaders() }),
          [200],
        )
      ).body,
    ).toMatchObject({ claimed: 1, failed: 0 });
    const run = { ...source, ...(await source.claimMaintenance()) };
    const published = await publish(
      run,
      "Memory after a finite extraction retry.\n",
    );
    await completeMaintenance(run, published.versionId);
    expect(
      (await observeMemory(run, "Memory after a finite extraction retry.\n"))
        .memory.versionId,
    ).toBe(published.versionId);
  });

  it.each([false, true])(
    "revalidates permanent credential failures against the UTC day (rollover: %s)",
    async (rollover) => {
      const beforeMidnight = new Date(now());
      beforeMidnight.setUTCHours(23, 58, 0, 0);
      mockNow(beforeMidnight);
      const source = await prepareSources();
      extractionResponse({
        status: 401,
        beforeResponse: () => {
          if (rollover) {
            mockNow(now() + 3 * 60 * 1000);
          }
        },
      });
      expect(
        (await accept(source.stage1.extract({ headers: cronHeaders() }), [200]))
          .body,
      ).toMatchObject({
        terminalFailure: rollover ? 0 : 1,
        staleDiscarded: rollover ? 1 : 0,
        succeeded: 0,
        retryableFailure: 0,
      });
      expect(
        (
          await accept(
            source.stage2.consolidate({ headers: cronHeaders() }),
            [200],
          )
        ).body,
      ).toMatchObject({ claimed: 0, noWork: 1 });
      expect((await runs.pollRunner(source.runnerGroup)).body.job).toBeNull();
    },
  );

  it("discards an extraction whose lease expires while the provider is responding, then reclaims it", async () => {
    // A future UTC noon keeps auth valid and lease recovery in the admitted day.
    const daytime = new Date(now() + 24 * 60 * 60 * 1000);
    daytime.setUTCHours(12, 0, 0, 0);
    mockNow(daytime);
    const source = await prepareSources();
    extractionResponse({
      beforeResponse: () => {
        mockNow(now() + 60 * 60 * 1000);
      },
    });
    expect(
      (await accept(source.stage1.extract({ headers: cronHeaders() }), [200]))
        .body,
    ).toMatchObject({ succeeded: 0, staleDiscarded: 1 });
    expect(
      (
        await accept(
          source.stage2.consolidate({ headers: cronHeaders() }),
          [200],
        )
      ).body,
    ).toMatchObject({ claimed: 0, noWork: 1 });
    extractionResponse();
    expect(
      (await accept(source.stage1.extract({ headers: cronHeaders() }), [200]))
        .body,
    ).toMatchObject({ succeeded: 1, staleDiscarded: 0 });
    expect(
      (
        await accept(
          source.stage2.consolidate({ headers: cronHeaders() }),
          [200],
        )
      ).body,
    ).toMatchObject({ claimed: 1, failed: 0 });
    const run = { ...source, ...(await source.claimMaintenance()) };
    const published = await publish(run, "Memory after lease reclamation.\n");
    await completeMaintenance(run, published.versionId);
    expect(
      (await observeMemory(run, "Memory after lease reclamation.\n")).memory
        .versionId,
    ).toBe(published.versionId);
  });

  it.each(["feature", "source"] as const)(
    "revalidates a credential failure after a public %s change",
    async (change) => {
      const source = await prepareSources();
      extractionResponse({
        status: 403,
        beforeResponse: async () => {
          if (change === "feature") {
            await updateFeatureSwitchesForUser(context, source.actor, {
              [FeatureSwitchKey.PiMemory]: false,
            });
          } else {
            const newer = await chat.sendChatRun(source.actor, {
              agentId: source.agentId,
              threadId: source.source.threadId,
              prompt: "New input changes the selected source",
              model: "gpt-6-luna",
            });
            await runs.requestCancelRun(source.actor, newer.runId, [200]);
            await flushWaitUntilForTest();
          }
        },
      });
      expect(
        (await accept(source.stage1.extract({ headers: cronHeaders() }), [200]))
          .body,
      ).toMatchObject({ terminalFailure: 0, succeeded: 0, staleDiscarded: 1 });
      expect(
        (
          await accept(
            source.stage2.consolidate({ headers: cronHeaders() }),
            [200],
          )
        ).body,
      ).toMatchObject({ claimed: 0, noWork: 1 });
      expect((await runs.pollRunner(source.runnerGroup)).body.job).toBeNull();
    },
  );
});
