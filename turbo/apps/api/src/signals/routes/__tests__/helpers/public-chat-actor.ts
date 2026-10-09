import { onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { settleIncludingAbort } from "../../../utils";
import { mockOptionalEnv } from "../../../../lib/env";
import { createChatEventsFixture } from "./chat-events-fixture";
import { captureConnectorExternalState } from "./public-connector-actor";
import { publicRunOwner } from "./public-run-owner";
import { deletePublicWorkspace } from "./public-workspace-cleanup";

/** Own a normal Stripe/personal-model chat actor from its first API write. */
export async function publicChatActor(
  context: TestContext,
  options: { readonly restoreEnvironment?: () => void } = {},
) {
  const fixture = createChatEventsFixture(context);
  const actor = fixture.bdd.user();
  let accepted = captureConnectorExternalState(context);
  let previous: (() => void) | undefined;
  let restoreSetupWebhook: (() => void) | undefined;
  let ready = false;
  onTestFinished(() => {
    previous?.();
  });
  const owner = publicRunOwner(context, actor, {
    restoreEnvironment: () => {
      previous ??= captureConnectorExternalState(context);
      accepted();
      restoreSetupWebhook?.();
      if (ready) {
        options.restoreEnvironment?.();
      }
    },
    afterRuns: () => {
      return deletePublicWorkspace(context, actor);
    },
  });
  function run<T>(operation: () => Promise<T>) {
    return owner.run(() => {
      // Helpers install provider mocks synchronously before their first request.
      // Capture after invocation so failed construction retains those mocks too.
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
  const runnerGroup = fixture.api.configureRunnerGroup();
  const { customerId } = await run(() => {
    return fixture.api.grantProEntitlement(actor, {
      onExternalStateReady: (restoreWebhook) => {
        restoreSetupWebhook = restoreWebhook;
      },
    });
  });
  restoreSetupWebhook = undefined;
  const { providerId } = await run(() => {
    return fixture.api.ensurePersonalSubscriptionModel(actor);
  });
  const agent = await run(() => {
    return fixture.bdd.createAgent(actor, {
      displayName: "BDD chat messages agent",
      description: "Exercises the web chat send route.",
      visibility: "private",
    });
  });
  const entitled = {
    actor,
    customerId,
    agentId: agent.agentId,
    runnerGroup,
    providerId,
  };
  ready = true;
  return {
    ...entitled,
    run,
    sendChatRun: (...parameters: Parameters<typeof fixture.sendChatRun>) => {
      return run(() => {
        return fixture.sendChatRun(...parameters);
      });
    },
    sendWaitingChatInput: (
      ...parameters: Parameters<typeof fixture.sendWaitingChatInput>
    ) => {
      return run(() => {
        return fixture.sendWaitingChatInput(...parameters);
      });
    },
    requestSendEvent: (
      ...parameters: Parameters<typeof fixture.chat.requestSendEvent>
    ) => {
      return run(() => {
        return fixture.chat.requestSendEvent(...parameters);
      });
    },
    requestSendEventWithBearer: (
      ...parameters: Parameters<typeof fixture.requestSendEventWithBearer>
    ) => {
      return run(() => {
        return fixture.requestSendEventWithBearer(...parameters);
      });
    },
    claimChatRun: (...parameters: Parameters<typeof fixture.claimChatRun>) => {
      return run(async () => {
        const claimed = await fixture.claimChatRun(...parameters);
        owner.rememberClaim(parameters[1], claimed.claim.sandboxToken);
        return claimed;
      });
    },
  };
}
