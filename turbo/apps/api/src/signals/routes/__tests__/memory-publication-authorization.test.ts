import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { commitMemoryVersion } from "./helpers/memory";
import {
  createPublicRunnerMemory,
  memoryFilesArchive,
} from "./helpers/public-runner-memory";
import { storageTextFile } from "./helpers/api-bdd-storage-files";

const context = testContext();

describe("Memory publication authorization", () => {
  it("offers the captured base and fresh HEAD only to the active Memory owner", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      fixture.installObjects();
      const initial = await fixture.startExecution(
        agentId,
        "initialize a nonempty base",
      );
      const base = await fixture.publish(initial, [
        { path: "base.md", content: "Original base" },
      ]);
      const writer = await fixture.startExecution(
        agentId,
        "publish concurrently",
      );
      const stale = await fixture.startExecution(
        agentId,
        "merge my Memory changes",
      );
      const head = await fixture.publish(writer, [
        { path: "head.md", content: "Newest HEAD" },
      ]);

      const prepared = await fixture.webhooks.requestAgentStoragePrepare(
        {
          runId: stale.run.runId,
          storageId: stale.memory.storageId,
          // The caller cannot replace the originally captured base with HEAD.
          parentVersionId: head,
          files: [],
          includeMemoryMerge: true,
        },
        stale.headers,
        [200],
      );
      if (prepared.status !== 200) {
        throw new Error("Expected authorized merge inputs");
      }
      expect(prepared.body.memoryMerge).toMatchObject({
        base: {
          versionId: base,
          empty: false,
          manifestUrl: expect.any(String),
          archiveUrl: expect.any(String),
        },
        head: {
          versionId: head,
          empty: false,
          manifestUrl: expect.any(String),
          archiveUrl: expect.any(String),
        },
      });
      const merge = prepared.body.memoryMerge;
      if (!merge?.base.manifestUrl || !merge.head.manifestUrl) {
        throw new Error("Expected manifest downloads");
      }
      const baseManifest = await fetch(merge.base.manifestUrl);
      const headManifest = await fetch(merge.head.manifestUrl);
      await expect(baseManifest.json()).resolves.toMatchObject({
        files: [{ path: "base.md" }],
      });
      await expect(headManifest.json()).resolves.toMatchObject({
        files: [{ path: "head.md" }],
      });

      const mergedFiles = [
        { path: "head.md", content: "Newest HEAD" },
        { path: "ours.md", content: "Concurrent candidate" },
      ];
      const entries = mergedFiles.map((file) => {
        return storageTextFile(file.path, file.content);
      });
      const merged = await fixture.webhooks.requestAgentStoragePrepare(
        {
          runId: stale.run.runId,
          storageId: stale.memory.storageId,
          parentVersionId: head,
          files: entries,
        },
        stale.headers,
        [200],
      );
      if (merged.status !== 200 || !merged.body.uploads) {
        throw new Error("Expected merged upload authorization");
      }
      fixture.objects.set(
        merged.body.uploads.archive.key,
        memoryFilesArchive(mergedFiles),
      );
      fixture.objects.set(
        merged.body.uploads.manifest.key,
        Buffer.from(JSON.stringify({ version: 1, files: entries })),
      );
      await fixture.webhooks.requestAgentStorageCommit(
        {
          runId: stale.run.runId,
          storageId: stale.memory.storageId,
          parentVersionId: head,
          versionId: merged.body.versionId,
          files: entries,
        },
        stale.headers,
        [200],
      );
      await fixture.webhooks.requestAgentComplete(
        {
          runId: stale.run.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `merged-${stale.run.runId}`,
            cliAgentSessionHistoryDisposition: "native_only",
            storageOutputs: [
              {
                name: "memory",
                mountPath: stale.memory.mountPath,
                version: merged.body.versionId,
              },
            ],
          },
        },
        stale.headers,
        [200],
      );
      const next = await fixture.startExecution(
        agentId,
        "read the merged Memory",
      );
      expect(next.memory.versionId).toBe(merged.body.versionId);
      expect(
        (await fixture.api.readRun(fixture.actor, writer.run.runId)).status,
      ).toBe("completed");
      expect(
        (await fixture.api.readRun(fixture.actor, stale.run.runId)).status,
      ).toBe("completed");
      await fixture.webhooks.requestAgentStoragePrepare(
        {
          runId: stale.run.runId,
          storageId: stale.memory.storageId,
          files: [],
          includeMemoryMerge: true,
        },
        stale.headers,
        [404],
      );
    });
  });

  it("describes initialized empty Memory without requiring object downloads", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const claimed = await fixture.startExecution(
        agentId,
        "read my empty Memory merge base",
      );
      const prepared = await fixture.webhooks.requestAgentStoragePrepare(
        {
          runId: claimed.run.runId,
          storageId: claimed.memory.storageId,
          files: [],
          includeMemoryMerge: true,
        },
        claimed.headers,
        [200],
      );
      expect(prepared.body).toMatchObject({
        memoryMerge: {
          base: { versionId: claimed.memory.versionId, empty: true },
          head: { versionId: claimed.memory.versionId, empty: true },
        },
      });
    });
  });

  it("keeps another member's Memory merge inputs private", async () => {
    const owner = createPublicRunnerMemory(context);
    const other = createPublicRunnerMemory(context);
    await owner.run(async () => {
      const ownerAgent = await owner.initializeNative();
      const owned = await owner.startExecution(ownerAgent, "own Memory");
      await other.run(async () => {
        const otherAgent = await other.initializeNative();
        const foreign = await other.startExecution(otherAgent, "other Memory");
        const denied = await owner.webhooks.requestAgentStoragePrepare(
          {
            runId: owned.run.runId,
            storageId: foreign.memory.storageId,
            files: [],
            includeMemoryMerge: true,
          },
          owned.headers,
          [404],
        );
        expect(denied.status).toBe(404);
      });
    });
  });

  it("commits native memory and preserves its version on the next Runner claim", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const claimed = await fixture.startExecution(
        agentId,
        "publish owned memory",
      );
      const baseVersionId = claimed.memory.versionId;
      if (!baseVersionId) {
        throw new Error("Expected the claimed memory version");
      }
      const ordinaryCommit = await fixture.webhooks.requestAgentStorageCommit(
        {
          runId: claimed.run.runId,
          storageId: claimed.memory.storageId,
          versionId: baseVersionId,
          files: [],
        },
        claimed.headers,
        [200],
      );
      expect(ordinaryCommit.body).toMatchObject({
        success: true,
        versionId: baseVersionId,
        deduplicated: true,
      });
      const next = await fixture.startExecution(
        agentId,
        "verify owned memory head",
      );
      expect(next.memory.versionId).toBe(baseVersionId);
    });
  });

  it("publishes memory content and returns its version in the next Runner claim", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const claimed = await fixture.startExecution(
        agentId,
        "publish memory content",
      );
      const committed = await commitMemoryVersion(
        context,
        {
          runId: claimed.run.runId,
          sandboxHeaders: claimed.headers,
          storageManifest: claimed.execution.storageManifest,
        },
        [
          {
            path: "notes.md",
            content: "Published memory survives the next claim.",
          },
        ],
      );
      expect(committed.versionId).not.toBe(claimed.memory.versionId);
      const next = await fixture.startExecution(
        agentId,
        "read published memory",
      );
      expect(next.memory.storageId).toBe(committed.storageId);
      expect(next.memory.versionId).toBe(committed.versionId);
    });
  });
  it("preserves the winning Memory when another claimed Run publishes a stale candidate or no-op", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const first = await fixture.startExecution(agentId, "first writer");
      const stale = await fixture.startExecution(agentId, "concurrent writer");
      expect(stale.memory.versionId).toBe(first.memory.versionId);
      const published = await commitMemoryVersion(
        context,
        {
          runId: first.run.runId,
          sandboxHeaders: first.headers,
          storageManifest: first.execution.storageManifest,
        },
        [{ path: "notes.md", content: "Newest verified fact" }],
      );
      const candidate = await commitMemoryVersion(
        context,
        {
          runId: stale.run.runId,
          sandboxHeaders: stale.headers,
          storageManifest: stale.execution.storageManifest,
        },
        [{ path: "notes.md", content: "Stale competing fact" }],
        409,
      );
      expect(candidate.versionId).not.toBe(published.versionId);
      const baseVersion = stale.memory.versionId;
      if (!baseVersion) {
        throw new Error("Expected captured Memory base");
      }
      await fixture.webhooks.requestAgentStorageCommit(
        {
          runId: stale.run.runId,
          storageId: stale.memory.storageId,
          versionId: baseVersion,
          files: [],
        },
        stale.headers,
        [200],
      );
      await fixture.webhooks.requestAgentComplete(
        { runId: first.run.runId, exitCode: 0 },
        first.headers,
        [200],
      );
      await fixture.webhooks.requestAgentComplete(
        {
          runId: stale.run.runId,
          exitCode: 1,
          error: "Memory publication conflict",
        },
        stale.headers,
        [200],
      );
      const next = await fixture.startExecution(
        agentId,
        "read concurrent winner",
      );
      expect(next.memory.versionId).toBe(published.versionId);
      const reviewed = await commitMemoryVersion(
        context,
        {
          runId: next.run.runId,
          sandboxHeaders: next.headers,
          storageManifest: next.execution.storageManifest,
        },
        [
          {
            path: "notes.md",
            content:
              "Newest verified fact plus a freshly reviewed competing fact",
          },
        ],
      );
      const recovered = await fixture.startExecution(
        agentId,
        "read freshly reviewed consolidation",
      );
      expect(recovered.memory.versionId).toBe(reviewed.versionId);
    });
  });
  it("publishes exactly one winner when two Runs concurrently finalize different Memory candidates", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const left = await fixture.startExecution(
        agentId,
        "concurrent left writer",
      );
      const right = await fixture.startExecution(
        agentId,
        "concurrent right writer",
      );
      const outcomes = await Promise.all(
        [left, right].map((claimed, index) => {
          return commitMemoryVersion(
            context,
            {
              runId: claimed.run.runId,
              sandboxHeaders: claimed.headers,
              storageManifest: claimed.execution.storageManifest,
            },
            [{ path: "notes.md", content: `Verified candidate ${index}` }],
            [200, 409],
          );
        }),
      );
      expect(
        outcomes
          .map((outcome) => {
            return outcome.status;
          })
          .sort(),
      ).toStrictEqual([200, 409]);
      const winner = outcomes.find((outcome) => {
        return outcome.status === 200;
      });
      const next = await fixture.startExecution(
        agentId,
        "read the published concurrent winner",
      );
      expect(next.memory.versionId).toBe(winner?.versionId);
    });
  });
});
