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
});
