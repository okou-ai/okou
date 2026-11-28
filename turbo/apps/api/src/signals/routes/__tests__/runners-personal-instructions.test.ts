import { randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { prepareContentBundle } from "@okouai/core/content-bundle";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import {
  SINGLE_AGENT_SEED_INSTRUCTIONS,
  SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE,
} from "@okouai/core/seed-instructions";
import { HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { instructionsRoutes } from "../instructions";
import { createBddApi } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
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

function instructionsClient(context: TestContext) {
  return setupAppWithRoutes({ context, routes: instructionsRoutes })(
    instructionsContract,
  );
}

describe("Captured personal Instructions in direct Runs", () => {
  const context = testContext();

  it(
    "runners-personal-instructions-001 keeps published personal content and signed API mode after personal Instructions change",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      const dispatchArrived = createDeferredPromise<string>(context.signal);
      const releaseDispatch = createDeferredPromise<void>(context.signal);
      let dispatchReleased = false;
      const release = () => {
        if (!dispatchReleased) {
          dispatchReleased = true;
          releaseDispatch.resolve();
        }
      };
      onTestFinished(release);

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
      await fixture.api.configureRunnerGroup({
        runnerIdentity,
        reply: async (envelope) => {
          dispatchArrived.resolve(envelope.executionContext.runId);
          await releaseDispatch.promise;
          return HttpResponse.json({
            ...runnerIdentity,
            runId: envelope.executionContext.runId,
            disposition: "accepted",
          });
        },
      });

      await owner.run(() => {
        return bdd.bootstrapLimitedFreeOnboarding(actor);
      });

      const admissionText = "Admission-time personal Instructions.";
      await owner.run(() => {
        return bdd.updatePersonalInstructions(actor, admissionText);
      });

      const sent = await owner.run(() => {
        return fixture.chat.requestSendEvent(
          actor,
          {
            prompt: "Run with captured personal Instructions",
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      expect(sent.status).toBe(201);

      const runId = await dispatchArrived.promise;
      await owner.run(() => {
        return bdd.updatePersonalInstructions(
          actor,
          "Edited before dispatch personal Instructions.",
        );
      });
      release();

      const execution = await owner.executionInput(runId);
      const instructionsRef =
        execution.startupInputs.contentBundles.instructions;
      if (!instructionsRef) {
        throw new Error("Expected personal instructions bundle");
      }

      const files = readExecutionContentBundle(objects, instructionsRef);
      expect(files.get("instructions.md")?.toString("utf8")).toBe(
        admissionText,
      );

      const runToken = okouTokenFromExecution(execution);
      const tokenUpdatedText = "Updated via active Run token.";
      const updatedByRun = await accept(
        instructionsClient(context).update({
          headers: { authorization: `Bearer ${runToken}` },
          body: { content: tokenUpdatedText },
        }),
        [200],
      );
      expect(updatedByRun.status).toBe(200);

      const readByRun = await accept(
        instructionsClient(context).get({
          headers: { authorization: `Bearer ${runToken}` },
        }),
        [200],
      );
      expect(readByRun.status).toBe(200);
      expect(readByRun.body.content).toBe(tokenUpdatedText);

      const cancelled = await owner.run(() => {
        return fixture.api.requestCancelRun(actor, runId, [200]);
      });
      expect(cancelled.status).toBe(200);

      const readAfterCancel = await accept(
        instructionsClient(context).get({
          headers: { authorization: `Bearer ${runToken}` },
        }),
        [403],
      );
      expect(readAfterCancel.status).toBe(403);
    },
  );

  it(
    "runners-personal-instructions-003 (1/2) uses the deployment default bundle until the member's first save",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);

      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      const objects = capturePublishedBundles(context);
      const defaultBundle = await prepareContentBundle([
        {
          path: "instructions.md",
          content: Buffer.from(SINGLE_AGENT_SEED_INSTRUCTIONS, "utf8"),
        },
      ]);
      objects.set(
        `bundles/v1/${defaultBundle.descriptor.sha256}.tar.gz`,
        defaultBundle.archive,
      );
      await fixture.api.configureRunnerGroup();

      await owner.run(() => {
        return bdd.bootstrapLimitedFreeOnboarding(actor);
      });

      const run = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Start an initial Run before saving Instructions",
        });
      });
      const execution = await owner.executionInput(run.runId);
      const bundleRef = execution.startupInputs.contentBundles.instructions;
      if (!bundleRef) {
        throw new Error("Expected default instructions bundle");
      }

      expect(bundleRef).toMatchObject({
        sha256: SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE.sha256,
        archiveBytes: SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE.archiveBytes,
      });
      const files = readExecutionContentBundle(objects, bundleRef);
      expect(files.get("instructions.md")?.toString("utf8")).toBe(
        SINGLE_AGENT_SEED_INSTRUCTIONS,
      );
    },
  );

  it(
    "runners-personal-instructions-003 (2/2) isolates two members' saved personal Instructions in the same workspace",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const firstMember = bdd.user();
      const secondMember = bdd.user({
        orgId: firstMember.orgId,
        orgRole: "org:member",
      });
      const firstOwner = publicRunOwner(context, firstMember);
      const secondOwner = publicRunOwner(context, secondMember);

      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      const objects = capturePublishedBundles(context);
      await fixture.api.configureRunnerGroup();

      await firstOwner.run(() => {
        return fixture.api.grantProEntitlement(firstMember);
      });
      await secondOwner.run(() => {
        return bdd.completeOnboarding(secondMember);
      });

      const firstText = "First workspace member personal Instructions.";
      const secondText = "Second workspace member personal Instructions.";

      await firstOwner.run(() => {
        return bdd.updatePersonalInstructions(firstMember, firstText);
      });
      await secondOwner.run(() => {
        return bdd.updatePersonalInstructions(secondMember, secondText);
      });

      const firstRun = await firstOwner.run(() => {
        return fixture.sendChatRun(firstMember, {
          prompt: "First member direct Run",
        });
      });
      const secondRun = await secondOwner.run(() => {
        return fixture.sendChatRun(secondMember, {
          prompt: "Second member direct Run",
        });
      });

      const firstExecution = await firstOwner.executionInput(firstRun.runId);
      const secondExecution = await secondOwner.executionInput(secondRun.runId);

      const firstBundle =
        firstExecution.startupInputs.contentBundles.instructions;
      const secondBundle =
        secondExecution.startupInputs.contentBundles.instructions;
      if (!firstBundle || !secondBundle) {
        throw new Error("Expected instructions bundles for both members");
      }

      expect(firstBundle.sha256).not.toBe(secondBundle.sha256);
      expect(
        readExecutionContentBundle(objects, firstBundle)
          .get("instructions.md")
          ?.toString("utf8"),
      ).toBe(firstText);
      expect(
        readExecutionContentBundle(objects, secondBundle)
          .get("instructions.md")
          ?.toString("utf8"),
      ).toBe(secondText);

      const secondRunToken = okouTokenFromExecution(secondExecution);
      const readBySecondRun = await accept(
        instructionsClient(context).get({
          headers: { authorization: `Bearer ${secondRunToken}` },
        }),
        [200],
      );
      expect(readBySecondRun.status).toBe(200);
      expect(readBySecondRun.body).toMatchObject({
        orgId: secondMember.orgId,
        userId: secondMember.userId,
        content: secondText,
      });
    },
  );
});
