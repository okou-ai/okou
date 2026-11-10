import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { closeS3Clients } from "../../../lib/s3-client";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createPublicRunnerMemory } from "./helpers/public-runner-memory";

const context = testContext();

describe("Claim Storage URL freshness", () => {
  it("refreshes a queued mount across the cache margin and publishes the winning URL", async () => {
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(clearMockNow);
    // Presigning credentials give this clock-controlled case its own cache namespace.
    mockEnv("R2_SECRET_ACCESS_KEY", `claim-storage-${randomUUID()}`);
    closeS3Clients();
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      fixture.installObjects();
      const writer = await fixture.claim(agentId, "Publish nonempty Memory");
      expect(writer.memory.empty).toBeTruthy();
      const versionId = await fixture.publish(writer, [
        { path: "MEMORY.md", content: "A pinned Memory fact" },
      ]);
      const cached = await fixture.claim(
        agentId,
        "Cache the accepted version URL",
      );
      expect(cached.memory).toMatchObject({ versionId, writeback: true });
      expect(cached.memory.archiveSize).toBeGreaterThan(0);
      expect(cached.memory.archiveUrl).toBeDefined();
      await fixture.cancel(cached);

      // A settled Run ages the two-day cache. Only two minutes pass while queued.
      mockNow(startedAt + (48 - 4) * 60 * 60 * 1000 - 60_000);
      const queued = await fixture.enqueue(
        agentId,
        "Cross the URL cache margin",
      );
      mockNow(startedAt + (48 - 4) * 60 * 60 * 1000 + 60_000);
      const refreshed = await fixture.claimQueued(queued);
      expect(refreshed.memory).toStrictEqual({
        ...cached.memory,
        archiveUrl: refreshed.memory.archiveUrl,
      });
      expect(refreshed.memory.archiveUrl).toBeDefined();
      expect(refreshed.memory.archiveUrl).not.toBe(cached.memory.archiveUrl);
      await fixture.cancel(refreshed);
      const reused = await fixture.claim(
        agentId,
        "Reuse the winning Claim URL",
      );
      expect(reused.memory).toStrictEqual(refreshed.memory);
    });
  });
});
