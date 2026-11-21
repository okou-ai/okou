import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { closeS3Clients } from "../../../lib/s3-client";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { createPublicRunnerMemory } from "./helpers/public-runner-memory";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();

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
        "Reuse the published execution URL",
      );
      expect(reused.memory).toStrictEqual(refreshed.memory);
    });
  });

  it("dispatches the captured Memory archive when HEAD changes during chat startup", async () => {
    const fixture = createPublicRunnerMemory(context);
    const chat = createChatEventsFixture(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      fixture.installObjects();
      const first = await fixture.startExecution(agentId, "Create Memory");
      const version = await fixture.publish(first, [
        { path: "MEMORY.md", content: "First version" },
      ]);
      const writer = await fixture.startExecution(agentId, "Update Memory");
      const fileId = randomUUID();
      const filename = "hold.txt";
      const key = buildArtifactKeyV2(fileId, filename);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const original = context.mocks.s3.send.getMockImplementation();
      if (!original) {
        throw new Error("Expected the Memory fixture's storage transport");
      }
      context.mocks.s3.send.mockImplementation(async (request: unknown) => {
        if (request instanceof HeadObjectCommand && request.input.Key === key) {
          entered.resolve(undefined);
          await release.promise;
          return {
            ContentLength: 1,
            ContentType: "text/plain",
            LastModified: new Date(now()),
            Metadata: {
              "artifact-id": fileId,
              "user-id": encodeURIComponent(fixture.actor.userId),
              filename,
            },
          };
        }
        return await original(request);
      });
      const sending = settleIncludingAbort(
        chat.sendChatRun(fixture.actor, {
          model: "claude-fable-5-1",
          prompt: "Use the captured Memory",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "file",
                fileId,
                filenameSnapshot: filename,
                contentType: "text/plain",
              },
              { type: "text", text: "Use the captured Memory" },
            ],
          },
        }),
      );
      onTestFinished(async () => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
        await sending;
      });
      await Promise.race([
        entered.promise,
        sending.then((result) => {
          throw result.ok
            ? new Error("The send finished before reading its attachment")
            : result.error;
        }),
      ]);
      await flushWaitUntilForTest();
      const nextVersion = await fixture.publish(writer, [
        { path: "MEMORY.md", content: "Second version" },
      ]);
      release.resolve(undefined);
      const sent = await sending;
      if (!sent.ok) {
        throw sent.error;
      }
      fixture.registerRun(sent.value.runId);
      const state = await fixture.api.readRun(fixture.actor, sent.value.runId);
      const captured = await fixture.readExecution({
        ...sent.value,
        status: state.status,
        createdAt: state.createdAt,
      });
      expect(captured.memory).toStrictEqual(writer.memory);
      expect(captured.memory.versionId).toBe(version);
      await fixture.cancel(captured);
      const next = await fixture.startExecution(
        agentId,
        "Use the current Memory",
      );
      expect(next.memory.versionId).toBe(nextVersion);
      await fixture.cancel(next);
    });
  });
});
