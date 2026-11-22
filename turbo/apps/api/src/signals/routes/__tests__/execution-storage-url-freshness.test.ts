import { randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { closeS3Clients } from "../../../lib/s3-client";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { createPublicRunnerMemory } from "./helpers/public-runner-memory";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const cacheRefreshAfterMs = (48 - 4) * 60 * 60 * 1000;

describe("Execution Storage URL freshness", () => {
  it("refreshes a queued mount across the cache margin and publishes the winning URL", async () => {
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(clearMockNow);
    // Presigning credentials give this clock-controlled case its own cache namespace.
    mockEnv("R2_SECRET_ACCESS_KEY", `execution-storage-${randomUUID()}`);
    closeS3Clients();
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      await fixture.initializeNative();
      fixture.installObjects();
      const writer = await fixture.startExecution("Publish nonempty Memory");
      expect(writer.memory.empty).toBeTruthy();
      const versionId = await fixture.publish(writer, [
        { path: "MEMORY.md", content: "A pinned Memory fact" },
      ]);
      const cached = await fixture.startExecution(
        "Cache the accepted version URL",
      );
      expect(cached.memory).toMatchObject({ versionId, writeback: true });
      expect(cached.memory.archiveSize).toBeGreaterThan(0);
      expect(cached.memory.archiveUrl).toBeDefined();
      await fixture.cancel(cached);

      // A settled Run ages the two-day cache. Only two minutes pass while queued.
      mockNow(startedAt + cacheRefreshAfterMs - 60_000);
      await fixture.api.configureRunnerGroup();
      const queued = await createChatEventsFixture(context).queueChatRun(
        fixture.actor,
        {
          prompt: "Cross the URL cache margin",
          model: "claude-fable-5-1",
        },
        (blocker) => {
          fixture.registerExecution(blocker.runId, blocker.sandboxToken);
          fixture.registerQueuedThread(blocker.threadId);
        },
      );
      mockNow(startedAt + cacheRefreshAfterMs + 60_000);
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
        "Reuse the published execution URL",
      );
      expect(reused.memory).toStrictEqual(refreshed.memory);
    });
  });

  it("dispatches the picked Memory archive when HEAD changes during signing", async () => {
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(clearMockNow);
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      await fixture.initializeNative();
      fixture.installObjects();
      const first = await fixture.startExecution("Create Memory");
      const version = await fixture.publish(first, [
        { path: "MEMORY.md", content: "First version" },
      ]);
      const cached = await fixture.startExecution("Cache Memory");
      await fixture.cancel(cached);
      // The writer gets a fresh execution token while the cached URL is still usable.
      mockNow(startedAt + cacheRefreshAfterMs - 60_000);
      await fixture.api.configureRunnerGroup();
      const writer = await fixture.startExecution("Update Memory");
      expect(writer.memory).toStrictEqual(cached.memory);

      mockNow(startedAt + cacheRefreshAfterMs + 60_000);
      await fixture.api.configureRunnerGroup();
      const archiveSuffix = `/${writer.memory.storageId}/${version}/archive.tar.gz`;
      const entered = createDeferredPromise<string>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const original = context.mocks.s3.getSignedUrl.getMockImplementation();
      if (!original) {
        throw new Error("Expected the Memory fixture's URL signer");
      }
      context.mocks.s3.getSignedUrl.mockImplementation(
        async (client, request, options) => {
          if (
            request instanceof GetObjectCommand &&
            request.input.Key?.endsWith(archiveSuffix) &&
            !entered.settled()
          ) {
            entered.resolve(request.input.Key);
            await release.promise;
          }
          return await original(client, request, options);
        },
      );
      const sending = settleIncludingAbort(
        fixture.startExecution("Use the picked Memory"),
      );
      onTestFinished(async () => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
        await sending;
      });
      const archiveKey = await Promise.race([
        entered.promise,
        sending.then((result) => {
          throw result.ok
            ? new Error("The Run started before its Memory URL was signed")
            : result.error;
        }),
      ]);
      const nextVersion = await fixture.publish(writer, [
        { path: "MEMORY.md", content: "Second version" },
      ]);
      release.resolve(undefined);
      const sent = await sending;
      if (!sent.ok) {
        throw sent.error;
      }
      const captured = sent.value;
      expect(captured.memory).toStrictEqual({
        ...writer.memory,
        archiveUrl: captured.memory.archiveUrl,
      });
      expect(captured.memory.versionId).toBe(version);
      expect(captured.memory.archiveUrl).not.toBe(writer.memory.archiveUrl);
      expect(captured.memory.archiveUrl).toContain(
        encodeURIComponent(archiveKey),
      );
      await fixture.cancel(captured);
      const next = await fixture.startExecution("Use the current Memory");
      expect(next.memory.versionId).toBe(nextVersion);
      await fixture.cancel(next);
    });
  });
});
