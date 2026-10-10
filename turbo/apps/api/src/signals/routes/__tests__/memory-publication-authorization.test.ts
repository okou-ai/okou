import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createPublicRunnerMemory } from "./helpers/public-runner-memory";

const context = testContext();

describe("Memory publication authorization", () => {
  it("rejects forged maintenance results on an ordinary Runner claim", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const claimed = await fixture.claim(agentId, "publish owned memory");
      const baseVersionId = claimed.memory.versionId;
      if (!baseVersionId) {
        throw new Error("Expected the claimed memory version");
      }
      const body = {
        runId: claimed.run.runId,
        storageId: claimed.memory.storageId,
        parentVersionId: baseVersionId,
        files: [],
        maintenanceAttestation: {
          schemaVersion: 2 as const,
          leaseToken: randomUUID(),
          claimedRevision: 1,
          claimedBaseVersionId: baseVersionId,
          selectionDigest: "a".repeat(64),
          validatedVersionId: baseVersionId,
        },
      };
      const preparation = await fixture.webhooks.requestAgentStoragePrepare(
        body,
        claimed.headers,
        [400],
      );
      const commit = await fixture.webhooks.requestAgentStorageCommit(
        { ...body, versionId: baseVersionId },
        claimed.headers,
        [400],
      );
      for (const rejected of [preparation, commit]) {
        expect(rejected.body).toMatchObject({
          error: {
            code: "BAD_REQUEST",
            message: "Unexpected maintenance publication attestation",
          },
        });
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
});
