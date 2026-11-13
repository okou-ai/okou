import type { ApiTestUser } from "./api-bdd";
import { onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { settleIncludingAbort } from "../../../utils";
import { mockOptionalEnv } from "../../../../lib/env";
import { createChatEventsFixture } from "./chat-events-fixture";
import { captureConnectorExternalState } from "./public-connector-actor";
import { publicRunOwner } from "./public-run-owner";
import { deleteFeatureSwitchesForUser } from "./feature-switches";
import type { createRunsApi } from "./api-bdd-runs";

/** Own a normal Stripe/personal-model chat actor from its first API write. */
export async function publicChatActor(
  context: TestContext,
  options: {
    readonly beforeRuns?: (actor: ApiTestUser) => Promise<void>;
    readonly tier?: "pro" | "team";
    readonly stripeTransport?: "http";
    readonly restoreEnvironment?: () => void;
    readonly clockTime?: number | (() => number);
    readonly beforeWorkspaceCleanup?: (actor: ApiTestUser) => Promise<void>;
    readonly optionalEnvironmentNames?: readonly string[];
    readonly runner?: Parameters<
      ReturnType<typeof createRunsApi>["registerDirectRunner"]
    >[1];
  } = {},
) {
  const fixture = createChatEventsFixture(context);
  const actor = fixture.bdd.user();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected a public chat workspace owner");
  }
  let ownsFeatures = false;
  let accepted = captureConnectorExternalState(
    context,
    options.optionalEnvironmentNames,
  );
  let previous: (() => void) | undefined;
  let restoreSetupWebhook: (() => void) | undefined;
  let ready = false;
  onTestFinished(() => {
    previous?.();
  });
  const owner = publicRunOwner(context, actor, {
    clockTime: options.clockTime,
    continueAcceptedOperations: true,
    restoreEnvironment: () => {
      previous ??= captureConnectorExternalState(
        context,
        options.optionalEnvironmentNames,
      );
      accepted();
      restoreSetupWebhook?.();
      if (ready) {
        options.restoreEnvironment?.();
      }
    },
    beforeRuns: () => {
      return options.beforeRuns?.(actor) ?? Promise.resolve();
    },
    afterRuns: async () => {
      const features = await settleIncludingAbort(() => {
        return ownsFeatures
          ? deleteFeatureSwitchesForUser(context, { ...actor, orgId })
          : Promise.resolve();
      });
      const external = await settleIncludingAbort(() => {
        return options.beforeWorkspaceCleanup?.(actor) ?? Promise.resolve();
      });
      const errors = [features, external].flatMap((result) => {
        return result.ok ? [] : [result.error];
      });
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Chat workspace cleanup failed");
      }
    },
  });
  function run<T>(operation: () => Promise<T>) {
    return owner.run(() => {
      // Helpers install provider mocks synchronously before their first request.
      // Capture after invocation so failed construction retains those mocks too.
      const pending = settleIncludingAbort(operation);
      accepted = captureConnectorExternalState(
        context,
        options.optionalEnvironmentNames,
      );
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
  const runnerGroup = await fixture.api.configureRunnerGroup(options.runner);
  const { customerId } = await run(() => {
    return fixture.api.grantProEntitlement(actor, {
      tier: options.tier,
      stripeTransport: options.stripeTransport,
      onExternalStateReady: (restoreWebhook) => {
        restoreSetupWebhook = restoreWebhook;
      },
    });
  });
  restoreSetupWebhook = undefined;
  const { providerId, model } = await run(() => {
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
    model,
  };
  ready = true;
  return {
    ...entitled,
    run,
    rememberClaim: owner.rememberClaim,
    ownsFeatureSwitches() {
      ownsFeatures = true;
    },
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
    queueChatRun: (...parameters: Parameters<typeof fixture.queueChatRun>) => {
      return run(async () => {
        const waiting = await fixture.queueChatRun(...parameters);
        owner.rememberClaim(
          waiting.blocker.runId,
          waiting.blocker.sandboxToken,
        );
        return {
          launch() {
            return run(async () => {
              const launched = await waiting.launch();
              const claim = await fixture.api.executionInput(launched.runId);
              owner.rememberClaim(launched.runId, claim.sandboxToken);
              return launched;
            });
          },
        };
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
    claimRunnerRun: (
      ...parameters: Parameters<typeof fixture.api.executionInput>
    ) => {
      return run(async () => {
        const claim = await fixture.api.executionInput(...parameters);
        owner.rememberClaim(parameters[0], claim.sandboxToken);
        return claim;
      });
    },
    claimPatRun: (
      ...parameters: Parameters<typeof fixture.api.requestClaimRunnerJobAs>
    ) => {
      return run(async () => {
        const response = await fixture.api.requestClaimRunnerJobAs(
          ...parameters,
        );
        if (response.status === 200) {
          owner.rememberClaim(parameters[1], response.body.sandboxToken);
        }
        return response;
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
