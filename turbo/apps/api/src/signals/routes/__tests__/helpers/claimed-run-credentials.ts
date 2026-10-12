import { now } from "../../../../lib/time";
import { beforeEach } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { createBddApi } from "./api-bdd";
import { createAuthDeviceSupportApi } from "./api-bdd-auth-device-support";
import { createRunsApi } from "./api-bdd-runs";
import { captureConnectorExternalState } from "./public-connector-actor";
import { publicRunOwner } from "./public-run-owner";
import { deletePublicWorkspace } from "./public-workspace-cleanup";

/** Reuse one real, owned Runner claim per caller within the current case. */
export function createClaimedRunCredentials(context: TestContext) {
  const credentials = new Map<
    string,
    {
      readonly token: string;
      readonly sandboxToken: string;
      readonly runId: string;
      readonly threadId: string;
      readonly agentId: string;
    }
  >();
  beforeEach(() => {
    credentials.clear();
  });
  async function claim(identity: {
    readonly userId: string;
    readonly orgId: string | null;
  }) {
    if (!identity.orgId) {
      throw new Error("A Runner claim requires an organization");
    }
    const key = JSON.stringify([identity.userId, identity.orgId]);
    const existing = credentials.get(key);
    if (existing) {
      return existing;
    }
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user(identity);
    let restoreAccepted = captureConnectorExternalState(context);
    const owner = publicRunOwner(context, actor, {
      clockTime: now,
      restoreEnvironment: () => {
        restoreAccepted();
      },
      afterRuns: () => {
        return deletePublicWorkspace(context, actor);
      },
    });
    const token = await owner.run(async () => {
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await createAuthDeviceSupportApi(context).initializePreferences(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "API caller credential",
        visibility: "private",
      });
      const run = await runs.createThreadRun(actor, {
        agentId: agent.agentId,
        model: null,
        prompt: "Exercise the caller's API access",
      });
      await runs.heartbeatRunner(runnerGroup);
      const claim = await owner.claim(run.runId);
      restoreAccepted = captureConnectorExternalState(context);
      const issued = claim.platformEnvironment?.OKOU_TOKEN;
      if (!issued) {
        throw new Error("Expected the real claim's Okou token");
      }
      return {
        token: issued,
        sandboxToken: claim.sandboxToken,
        runId: run.runId,
        threadId: run.threadId,
        agentId: agent.agentId,
      };
    });
    credentials.set(key, token);
    return token;
  }
  return {
    claim,
    async okouToken(identity: Parameters<typeof claim>[0]) {
      return (await claim(identity)).token;
    },
    async sandboxToken(identity: Parameters<typeof claim>[0]) {
      return (await claim(identity)).sandboxToken;
    },
  };
}
