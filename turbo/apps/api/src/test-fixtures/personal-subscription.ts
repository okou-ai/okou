import { createStore } from "ccstate";
import { now } from "../lib/time";
import { createTestFixtureAgentRun$ } from "../signals/services/agent-runs-create.service";

/** Infrastructure exception: current public model-first requests cannot name a
 * concrete account ID. Internal callers (chat continuation, workflows) pin the
 * captured account; replay that admission through the run fixture adapter and
 * assert the claimed/authenticated runtime through production APIs. */
export async function createPinnedSubscriptionRunFixture(
  args: {
    readonly owner: { readonly orgId: string | null; readonly userId: string };
    readonly agentId: string;
    readonly accountId: string;
    readonly type: "claude-code-oauth-token" | "codex-oauth-token";
    readonly model: string;
  },
  signal: AbortSignal,
) {
  if (!args.owner.orgId) {
    throw new Error("Expected a test-owned organization");
  }
  return await createStore().set(
    createTestFixtureAgentRun$,
    {
      auth: {
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        tokenType: "session",
        orgRole: "admin",
      },
      body: {
        agentId: args.agentId,
        prompt: "continue an exact subscription selection",
      },
      apiStartTime: now(),
      piExecution: false,
      modelProviderId: args.accountId,
      modelProviderCredentialScope: "member",
      selectedModelOverride: args.model,
      agentRunModelPin: {
        modelProvider: args.type,
        modelProviderId: args.accountId,
        modelProviderCredentialScope: "member",
        selectedModel: args.model,
      },
    },
    signal,
  );
}
