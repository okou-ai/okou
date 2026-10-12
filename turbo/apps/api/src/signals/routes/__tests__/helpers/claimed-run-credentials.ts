import { beforeEach } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { mockOptionalEnv, optionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { settleIncludingAbort } from "../../../utils";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createAuthDeviceSupportApi } from "./api-bdd-auth-device-support";
import { createAuthOrgAgentsBddApi } from "./api-bdd-auth-org";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
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
  const owners = new Map<
    string,
    {
      readonly owner: ReturnType<typeof publicRunOwner>;
      retainWorkspace: boolean;
    }
  >();
  beforeEach(() => {
    owners.clear();
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
    const retention = { retainWorkspace: false };
    const owner = publicRunOwner(context, actor, {
      clockTime: now,
      restoreEnvironment: () => {
        restoreAccepted();
      },
      afterRuns: () => {
        return retention.retainWorkspace
          ? Promise.resolve()
          : deletePublicWorkspace(context, actor);
      },
    });
    owners.set(key, {
      owner,
      get retainWorkspace() {
        return retention.retainWorkspace;
      },
      set retainWorkspace(value: boolean) {
        retention.retainWorkspace = value;
      },
    });
    const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    const previousOpenrouterKey = optionalEnv("OPENROUTER_API_KEY");
    const token = await owner.run(async () => {
      const result = await settleIncludingAbort(async () => {
        bdd.acceptAgentStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        const runnerGroup = runs.configureRunnerGroup();
        mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
        await runs.grantProEntitlement(actor);
        await createAuthDeviceSupportApi(context).initializePreferences(actor);
        const agent = await bdd.createAgent(actor, {
          displayName: "API caller credential",
          visibility: "private",
        });
        const thread = await createChatFilesBddApi(context).createThread(
          actor,
          { agentId: agent.agentId, model: null },
        );
        const run = await runs.createThreadRun(actor, {
          agentId: agent.agentId,
          threadId: thread.id,
          prompt: "Exercise the caller's API access",
        });
        await runs.heartbeatRunner(runnerGroup);
        const claim = await owner.claim(run.runId);
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
      restoreAccepted = captureConnectorExternalState(context);
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
      mockOptionalEnv("OPENROUTER_API_KEY", previousOpenrouterKey);
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });
    credentials.set(key, token);
    return token;
  }
  return {
    claim,
    async removeMember(
      identity: Parameters<typeof claim>[0],
      survivingAdmin?: ApiTestUser,
    ) {
      const record = owners.get(
        JSON.stringify([identity.userId, identity.orgId]),
      );
      if (!record) {
        throw new Error("Claim a Run before revoking its member");
      }
      // Release this actor's accepted work while its credentials still exist.
      // The surviving administrator owns workspace cleanup after revocation.
      const auth = createAuthOrgAgentsBddApi(context);
      const actor = auth.user(identity);
      const admin =
        survivingAdmin ??
        auth.user({ orgId: actor.orgId, orgRole: "org:admin" });
      let restoreAdmin = captureConnectorExternalState(context);
      const administrator = publicRunOwner(context, admin, {
        clockTime: now,
        restoreEnvironment: () => {
          restoreAdmin();
        },
        afterRuns: () => {
          return deletePublicWorkspace(context, admin);
        },
      });
      await administrator.run(async () => {
        const result = await settleIncludingAbort(async () => {
          record.retainWorkspace = true;
          await record.owner.cleanup();
          auth.mockClerkOrg(admin, {
            members: [{ actor: admin }, { actor }],
            createdBy: admin.userId,
          });
          await auth.removeMember(admin, { email: actor.email });
          auth.mockClerkOrg(admin, {
            members: [{ actor: admin }],
            createdBy: admin.userId,
          });
          context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
            (request) => {
              const isAdmin =
                (request as { userId: string }).userId === admin.userId;
              return Promise.resolve({
                data: isAdmin
                  ? [{ role: "org:admin", organization: { id: admin.orgId } }]
                  : [],
                totalCount: isAdmin ? 1 : 0,
              });
            },
          );
        });
        restoreAdmin = captureConnectorExternalState(context);
        if (!result.ok) {
          throw result.error;
        }
      });
    },
    async okouToken(identity: Parameters<typeof claim>[0]) {
      return (await claim(identity)).token;
    },
    async sandboxToken(identity: Parameters<typeof claim>[0]) {
      return (await claim(identity)).sandboxToken;
    },
  };
}
