import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { closeS3Clients } from "../../../lib/s3-client";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createPublicRunnerMemory } from "./helpers/public-runner-memory";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { chatEventsRoutes } from "../chat-events";

const context = testContext();

describe("Claim Storage URL freshness", () => {
  it("refreshes a queued mount across the cache margin and publishes the winning URL", async () => {
    await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
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
      const writer = await fixture.startExecution(
        agentId,
        "Publish nonempty Memory",
      );
      expect(writer.memory.empty).toBeTruthy();
      const versionId = await fixture.publish(writer, [
        { path: "MEMORY.md", content: "A pinned Memory fact" },
      ]);
      const cached = await fixture.startExecution(
        agentId,
        "Cache the accepted version URL",
      );
      expect(cached.memory).toMatchObject({ versionId, writeback: true });
      expect(cached.memory.archiveSize).toBeGreaterThan(0);
      expect(cached.memory.archiveUrl).toBeDefined();
      await fixture.cancel(cached);

      // A settled Run ages the two-day cache. Only two minutes pass while queued.
      mockNow(startedAt + (48 - 4) * 60 * 60 * 1000 - 60_000);
      await fixture.api.configureRunnerGroup();
      const queued = await createChatEventsFixture(context).queueChatRun(
        fixture.actor,
        {
          agentId,
          prompt: "Cross the URL cache margin",
          model: "claude-fable-5-1",
        },
        (blocker) => {
          fixture.registerExecution(blocker.runId, blocker.sandboxToken);
          fixture.registerQueuedThread(blocker.threadId);
        },
      );
      mockNow(startedAt + (48 - 4) * 60 * 60 * 1000 + 60_000);
      await fixture.api.configureRunnerGroup();
      const launched = await queued.launch();
      const state = await fixture.api.readRun(fixture.actor, launched.runId);
      const refreshed = await fixture.readExecution({
        ...launched,
        status: state.status,
        createdAt: state.createdAt,
      });
      expect(refreshed.memory).toStrictEqual({
        ...cached.memory,
        archiveUrl: refreshed.memory.archiveUrl,
      });
      expect(refreshed.memory.archiveUrl).toBeDefined();
      expect(refreshed.memory.archiveUrl).not.toBe(cached.memory.archiveUrl);
      await fixture.cancel(refreshed);
      const reused = await fixture.startExecution(
        agentId,
        "Reuse the winning Claim URL",
      );
      expect(reused.memory).toStrictEqual(refreshed.memory);
    });
  });
});
