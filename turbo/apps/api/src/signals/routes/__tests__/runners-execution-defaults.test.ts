import { randomUUID } from "node:crypto";
import { HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";

const EXPECTED_DISALLOWED_TOOLS = Object.freeze([
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
  "Skill(loop)",
  "Skill(loop *)",
]);

describe("Direct Run launch defaults", () => {
  const context = testContext();

  it(
    "runners-execution-defaults-001 pins the dispatch timezone and retains restrictions and identity with compact context",
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
        return bdd.bootstrapLimitedFreeOnboarding(actor, {
          timezone: "America/Los_Angeles",
        });
      });

      const firstSent = await owner.run(() => {
        return fixture.chat.requestSendEvent(
          actor,
          {
            prompt: "First direct Run with Los Angeles timezone",
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      expect(firstSent.status).toBe(201);
      if (firstSent.status !== 201) {
        throw new Error("Expected first direct Run send to succeed");
      }

      const firstRunId = await firstDispatchArrived.promise;
      await owner.run(() => {
        return bdd.updateUserTimezone(actor, "Asia/Shanghai");
      });
      releaseFirst();

      const firstExecution = await owner.executionInput(firstRunId);

      expect(firstExecution.userTimezone).toBe("America/Los_Angeles");
      expect(firstExecution.appendSystemPrompt).toContain(
        "Timezone: America/Los_Angeles",
      );
      expect(firstExecution.disallowedTools).toStrictEqual(
        expect.arrayContaining([...EXPECTED_DISALLOWED_TOOLS]),
      );
      expect(firstExecution.platformEnvironment.OKOU_APP_URL).toBe(
        env("APP_URL"),
      );
      expect(firstExecution.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(
        firstSent.body.threadId,
      );
      expect(firstExecution.platformEnvironment.OKOU_TOKEN).toMatch(
        /^vm0_sandbox_/u,
      );

      await owner.run(() => {
        return fixture.cancelChatRun(actor, firstRunId, {
          authorization: `Bearer ${firstExecution.sandboxToken}`,
        });
      });

      const secondRun = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Second direct Run with Shanghai timezone",
        });
      });
      const secondExecution = await owner.executionInput(secondRun.runId);

      expect(secondExecution.userTimezone).toBe("Asia/Shanghai");
      expect(secondExecution.appendSystemPrompt).toContain(
        "Timezone: Asia/Shanghai",
      );
    },
  );
});
