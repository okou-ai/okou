import type { TestContext } from "../../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../../lib/env";
import { createChatEventsFixture } from "./chat-events-fixture";
import { publicRunOwner } from "./public-run-owner";
import { deletePublicWorkspace } from "./public-workspace-cleanup";

/** Own a normal Stripe/personal-model chat actor from its first API write. */
export async function publicChatActor(context: TestContext) {
  const fixture = createChatEventsFixture(context);
  const actor = fixture.bdd.user();
  let runnerGroup: string | undefined;
  const owner = publicRunOwner(context, actor, {
    restoreEnvironment: () => {
      if (runnerGroup) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
      }
    },
    afterRuns: () => {
      return deletePublicWorkspace(context, actor);
    },
  });
  const entitled = await owner.run(async () => {
    const accepted = await fixture.entitledChatActor(actor);
    runnerGroup = accepted.runnerGroup;
    return accepted;
  });
  return {
    ...entitled,
    run: owner.run,
    sendChatRun: (...parameters: Parameters<typeof fixture.sendChatRun>) => {
      return owner.run(() => {
        return fixture.sendChatRun(...parameters);
      });
    },
    sendWaitingChatInput: (
      ...parameters: Parameters<typeof fixture.sendWaitingChatInput>
    ) => {
      return owner.run(() => {
        return fixture.sendWaitingChatInput(...parameters);
      });
    },
    requestSendEvent: (
      ...parameters: Parameters<typeof fixture.chat.requestSendEvent>
    ) => {
      return owner.run(() => {
        return fixture.chat.requestSendEvent(...parameters);
      });
    },
    requestSendEventWithBearer: (
      ...parameters: Parameters<typeof fixture.requestSendEventWithBearer>
    ) => {
      return owner.run(() => {
        return fixture.requestSendEventWithBearer(...parameters);
      });
    },
    claimChatRun: (...parameters: Parameters<typeof fixture.claimChatRun>) => {
      return owner.run(async () => {
        const claimed = await fixture.claimChatRun(...parameters);
        owner.rememberClaim(parameters[1], claimed.claim.sandboxToken);
        return claimed;
      });
    },
  };
}
