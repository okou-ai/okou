import { randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext, type TestContext } from "../../../__tests__/test-context";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { publicRunOwner } from "./helpers/public-run-owner";

function s3NotFoundError(): Error {
  return Object.assign(new Error("NotFound"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function capturePublishedBundles(context: TestContext): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand && command.input.Key) {
      const body = command.input.Body;
      const buffer =
        typeof body === "string"
          ? Buffer.from(body, "utf8")
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : Buffer.alloc(0);
      objects.set(command.input.Key, buffer);
      return Promise.resolve({ ETag: "fixture-etag" });
    }
    if (
      command instanceof HeadObjectCommand &&
      command.input.Key?.startsWith("bundles/v1/")
    ) {
      const stored = objects.get(command.input.Key);
      return stored
        ? Promise.resolve({ ContentLength: stored.byteLength })
        : Promise.reject(s3NotFoundError());
    }
    return fallback ? fallback(command) : Promise.resolve({});
  });
  return objects;
}

describe("Published member instructions in direct Runs", () => {
  const context = testContext();

  it(
    "runners-member-instructions-001 keeps each Run's published instruction bytes across later edits",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      const firstDispatchArrived = createDeferredPromise<string>(
        context.signal,
      );
      const releaseFirstDispatch = createDeferredPromise<void>(context.signal);
      let firstDispatchReleased = false;
      const releaseFirst = () => {
        if (!firstDispatchReleased) {
          firstDispatchReleased = true;
          releaseFirstDispatch.resolve();
        }
      };
      onTestFinished(releaseFirst);

      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      const objects = capturePublishedBundles(context);

      const runnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 1,
      };
      let firstDispatchSeen = false;
      await fixture.api.configureRunnerGroup({
        runnerIdentity,
        reply: async (envelope) => {
          if (!firstDispatchSeen) {
            firstDispatchSeen = true;
            firstDispatchArrived.resolve(envelope.executionContext.runId);
            await releaseFirstDispatch.promise;
          }
          return HttpResponse.json({
            ...runnerIdentity,
            runId: envelope.executionContext.runId,
            disposition: "accepted",
          });
        },
      });

      await owner.run(() => {
        return fixture.api.grantProEntitlement(actor);
      });

      const instructionsA = "Member instructions A: concise engineering notes.";
      const instructionsB =
        "\uFEFF  Leading spaces\r\n日本語・中文・한국어\r\nTrailing spaces  ";
      const instructionsC = "Member instructions C: final release guidance.";

      await owner.run(() => {
        return bdd.updatePersonalInstructions(actor, instructionsA);
      });

      const firstSent = await owner.run(() => {
        return fixture.chat.requestSendEvent(
          actor,
          {
            prompt: "Run one with instructions A",
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      expect(firstSent.status).toBe(201);

      const firstRunId = await firstDispatchArrived.promise;
      await owner.run(() => {
        return bdd.updatePersonalInstructions(actor, instructionsB);
      });
      releaseFirst();

      const firstExecution = await owner.executionInput(firstRunId);
      const firstBundleRef =
        firstExecution.startupInputs.contentBundles.instructions;
      if (!firstBundleRef) {
        throw new Error("Expected first Run instructions bundle");
      }

      const firstFilesBeforeC = readExecutionContentBundle(
        objects,
        firstBundleRef,
      );
      expect(firstFilesBeforeC.get("instructions.md")?.toString("utf8")).toBe(
        instructionsA,
      );

      await owner.run(() => {
        return bdd.updatePersonalInstructions(actor, instructionsC);
      });

      const firstFilesAfterC = readExecutionContentBundle(
        objects,
        firstBundleRef,
      );
      expect(firstFilesAfterC.get("instructions.md")?.toString("utf8")).toBe(
        instructionsA,
      );

      const secondRun = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Run two with instructions C",
        });
      });
      const secondExecution = await owner.executionInput(secondRun.runId);
      const secondBundleRef =
        secondExecution.startupInputs.contentBundles.instructions;
      if (!secondBundleRef) {
        throw new Error("Expected second Run instructions bundle");
      }

      expect(secondBundleRef.sha256).not.toBe(firstBundleRef.sha256);
      const secondFiles = readExecutionContentBundle(objects, secondBundleRef);
      expect(secondFiles.get("instructions.md")?.toString("utf8")).toBe(
        instructionsC,
      );

      await expect(
        fixture.api.readRun(actor, firstRunId),
      ).resolves.toMatchObject({
        status: "running",
      });
    },
  );
});
