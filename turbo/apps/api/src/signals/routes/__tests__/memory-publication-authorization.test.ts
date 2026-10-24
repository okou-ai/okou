import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { commitMemoryVersion } from "./helpers/memory";
import { createPublicRunnerMemory } from "./helpers/public-runner-memory";

const context = testContext();

describe("Memory publication authorization", () => {
  it("commits native memory and preserves its version on the next Runner claim", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const claimed = await fixture.claim(agentId, "publish owned memory");
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
      const next = await fixture.claim(agentId, "verify owned memory head");
      expect(next.memory.versionId).toBe(baseVersionId);
    });
  });

  it("publishes memory content and returns its version in the next Runner claim", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const claimed = await fixture.claim(agentId, "publish memory content");
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
      const next = await fixture.claim(agentId, "read published memory");
      expect(next.memory.storageId).toBe(committed.storageId);
      expect(next.memory.versionId).toBe(committed.versionId);
    });
  });
  it("preserves the winning Memory when another claimed Run publishes a stale candidate or no-op", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const first = await fixture.claim(agentId, "first writer");
      const stale = await fixture.claim(agentId, "concurrent writer");
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
      const next = await fixture.claim(agentId, "read concurrent winner");
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
      const recovered = await fixture.claim(
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
      const left = await fixture.claim(agentId, "concurrent left writer");
      const right = await fixture.claim(agentId, "concurrent right writer");
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
      const next = await fixture.claim(
        agentId,
        "read the published concurrent winner",
      );
      expect(next.memory.versionId).toBe(winner?.versionId);
    });
  });
});
