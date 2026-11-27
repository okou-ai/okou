import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { settleIncludingAbort } from "../../utils";
import {
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

describe("custom-domain CLI guidance in the dispatched system prompt", () => {
  const context = testContext();

  it(
    "chat-events-custom-domains-prompt-002 includes custom-domain instructions only when the feature is enabled: true",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const actor = fixture.bdd.user();
      const orgId = requireOrgId(actor);
      let accepted = captureConnectorExternalState(context);
      let previous: (() => void) | undefined;
      let restoreSetupWebhook: (() => void) | undefined;
      onTestFinished(() => {
        previous?.();
      });

      const owner = publicRunOwner(context, actor, {
        continueAcceptedOperations: true,
        restoreEnvironment: () => {
          previous ??= captureConnectorExternalState(context);
          accepted();
          restoreSetupWebhook?.();
        },
        afterRuns: () => {
          return deleteFeatureSwitchesForUser(context, { ...actor, orgId });
        },
      });
      function runOwned<T>(operation: () => Promise<T>) {
        return owner.run(() => {
          const pending = settleIncludingAbort(operation);
          accepted = captureConnectorExternalState(context);
          return pending.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            return result.value;
          });
        });
      }

      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        runOwned(() => {
          return fixture.api.grantProEntitlement(actor, {
            onExternalStateReady: (restoreWebhook) => {
              restoreSetupWebhook = restoreWebhook;
            },
          });
        }),
        runOwned(() => {
          return updateFeatureSwitchesForUser(
            context,
            { userId: actor.userId, orgId, orgRole: actor.orgRole },
            { [FeatureSwitchKey.HostedSiteCustomDomains]: true },
          );
        }),
      ]);
      restoreSetupWebhook = undefined;

      const run = await runOwned(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Connect my custom domain docs.example.com to my hosted site",
          model: null,
        });
      });
      const { execution } = await runOwned(async () => {
        const result = await fixture.runExecution(run.runId);
        owner.rememberExecution(run.runId, result.execution.sandboxToken);
        return result;
      });
      const prompt = execution.appendSystemPrompt ?? "";

      expect(prompt).toContain("okou host domain --help");
      expect(prompt).toContain(
        "custom-domain feature switch and paid-subscription requirement",
      );
      expect(prompt).toContain("okou host domain add <site> <hostname>");
      expect(prompt).toContain("okou host domain verify <site> <hostname>");
      expect(prompt).toContain("additional certificate TXT records");
      expect(prompt).toContain("Do not poll or guess DNS targets");
      expect(prompt).toContain(
        "Only after all checks are ready, run `okou host domain select <site> <hostname>`",
      );
      expect(prompt).toContain("keeping connected domains active");
      expect(prompt).toContain(
        "Preserve the website's existing visibility and private sign-in",
      );
    },
  );
});
