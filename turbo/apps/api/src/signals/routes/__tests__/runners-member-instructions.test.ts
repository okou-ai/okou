import { randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import {
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { instructionsRoutes } from "../instructions";
import { logsRoutes } from "../logs";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
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

  const chatEventsApi = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const instructionsApi = setupAppWithRoutes({
    context,
    routes: instructionsRoutes,
  })(instructionsContract);
  const uploadsApi = setupAppWithRoutes({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
  const onboardingCompleteApi = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const logsApi = setupAppWithRoutes({
    context,
    routes: logsRoutes,
  })(logsListContract);
  const runnersHeartbeatApi = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await Promise.all([
      accept(
        chatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      accept(
        instructionsApi.update({
          headers: {},
          body: { content: "warmup" },
        }),
        [401],
      ),
      accept(
        uploadsApi.prepare({
          headers: {},
          body: {
            filename: "warmup.txt",
            contentType: "text/plain",
            size: 16,
          },
        }),
        [401],
      ),
      accept(
        uploadsApi.complete({
          headers: {},
          body: { id: randomUUID() },
        }),
        [401],
      ),
      accept(
        onboardingCompleteApi.complete({
          headers: {},
          body: {},
        }),
        [401],
      ),
      accept(
        logsApi.list({
          headers: {},
          query: {},
        }),
        [401],
      ),
      accept(
        runnersHeartbeatApi.heartbeat({
          headers: {},
          body: {
            runnerId: randomUUID(),
            group: "vm0/warmup",
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 1,
            totalMemoryMb: 1024,
            maxConcurrent: 1,
            allocatedVcpu: 0,
            allocatedMemoryMb: 0,
            runningCount: 0,
            admittableProfiles: ["vm0/default"],
            heldSandboxStates: [],
            heldHomeStates: [],
            activeReuseProducers: [],
            mode: "running",
          },
        }),
        [401],
      ),
    ]);
  });

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

  it(
    "runners-member-instructions-003 reuses the sending member's instructions captured before attachment verification",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();

      const verificationEntered = createDeferredPromise<void>(context.signal);
      const releaseVerificationDeferred = createDeferredPromise<void>(
        context.signal,
      );
      const releaseVerification = () => {
        if (!releaseVerificationDeferred.settled()) {
          releaseVerificationDeferred.resolve();
        }
      };
      onTestFinished(releaseVerification);

      const chatStorage = fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      const objects = capturePublishedBundles(context);

      const runnerGroupPromise = fixture.api.configureRunnerGroup();
      const owner = publicRunOwner(context, actor);

      const [runnerGroup] = await Promise.all([
        runnerGroupPromise,
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(actor);
        }),
      ]);

      const instructionsBefore =
        "Captured member instructions before attachment verification.";
      const instructionsAfter =
        "Updated member instructions during attachment verification.";

      const filename = "notes.txt";
      const [, prepared] = await owner.run(() => {
        return Promise.all([
          bdd.updatePersonalInstructions(actor, instructionsBefore),
          fixture.chat.prepareUpload(actor, {
            filename,
            contentType: "text/plain",
            size: 16,
          }),
        ]);
      });

      const attachmentKey = `private-artifacts/${prepared.id}/${filename}`;
      // Leaving the upload pending (with its bytes in storage) forces
      // POST /api/chat/events to verify the stored object via HeadObjectCommand
      // instead of reusing completed file size metadata (#51627).
      const pendingSize = 24;
      const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
      if (!privateBucket) {
        throw new Error("Expected R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
      }
      chatStorage.addObject({
        bucket: privateBucket,
        key: attachmentKey,
        size: pendingSize,
        contentType: "text/plain",
      });

      const previousSend = context.mocks.s3.send.getMockImplementation();
      context.mocks.s3.send.mockImplementation(async (command: unknown) => {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Key === attachmentKey &&
          !verificationEntered.settled()
        ) {
          verificationEntered.resolve();
          await releaseVerificationDeferred.promise;
        }
        return previousSend ? await previousSend(command) : {};
      });

      const sendPromise = owner.run(() => {
        return fixture.chat.requestSendEvent(
          actor,
          {
            prompt: "Summarize the attached note",
            clientEventId: randomUUID(),
            model: null,
            userMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Summarize the attached note" },
                {
                  type: "file",
                  fileId: prepared.id,
                  filenameSnapshot: filename,
                  contentType: "text/plain",
                },
              ],
            },
          },
          [201],
        );
      });

      await verificationEntered.promise;
      await owner.run(() => {
        return bdd.updatePersonalInstructions(actor, instructionsAfter);
      });
      releaseVerification();

      const sent = await sendPromise;
      expect(sent.status).toBe(201);

      const execution =
        await createRunsApi(context).nextReceivedExecution(runnerGroup);
      owner.rememberExecution(execution.runId, execution.sandboxToken);
      const bundleRef = execution.startupInputs.contentBundles.instructions;
      if (!bundleRef) {
        throw new Error("Expected Run instructions bundle");
      }

      const files = readExecutionContentBundle(objects, bundleRef);
      expect(files.get("instructions.md")?.toString("utf8")).toBe(
        instructionsBefore,
      );
    },
  );
});
