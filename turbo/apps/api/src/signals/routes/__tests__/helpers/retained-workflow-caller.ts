import type { TestContext } from "../../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { captureConnectorExternalState } from "./public-connector-actor";
import { publicRunOwner } from "./public-run-owner";
import { createRouteMocks } from "./route-test";

type RunHeaders = { readonly authorization: string };

/** A named-Agent Workflow can still be managed by a Run admitted on a retained Agent. */
export function retainedWorkflowCaller(context: TestContext) {
  const cases = new WeakMap<AbortSignal, Map<string, Promise<RunHeaders>>>();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);

  async function admit(actor: ApiTestUser): Promise<RunHeaders> {
    const restore = captureConnectorExternalState(context);
    const owner = publicRunOwner(context, actor, {
      continueAcceptedOperations: true,
    });
    return await owner
      .run(async () => {
        bdd.acceptAgentStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        const billing = await runs.readBillingStatus(actor);
        if (billing.tier !== "pro" && billing.tier !== "team") {
          const admin =
            actor.orgRole === "org:admin"
              ? actor
              : bdd.user({ orgId: actor.orgId, orgRole: "org:admin" });
          await runs.grantProEntitlement(admin, { tier: "team" });
        }
        await bdd.completeOnboarding(actor);
        await runs.ensurePersonalSubscriptionModel(actor);
        await runs.configureRunnerGroup();
        const agent = await bdd.createAgent(actor, {
          displayName: "Retained Workflow caller",
          visibility: "private",
        });
        const run = await runs.createThreadRun(actor, {
          agentId: agent.agentId,
          prompt: "Manage my retained Workflows",
          model: "claude-fable-5-1",
        });
        const execution = await owner.executionInput(run.runId);
        const token = execution.platformEnvironment.OKOU_TOKEN;
        if (!token) {
          throw new Error("Expected a retained Run credential");
        }
        return { authorization: "Bearer " + token };
      })
      .finally(restore);
  }

  return async (actor: ApiTestUser) => {
    let callers = cases.get(context.signal);
    if (!callers) {
      callers = new Map();
      cases.set(context.signal, callers);
    }
    const key = JSON.stringify([actor.orgId, actor.userId]);
    const pending = callers.get(key) ?? admit(actor);
    callers.set(key, pending);
    const headers = await pending;
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    return headers;
  };
}
