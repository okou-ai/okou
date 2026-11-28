import { beforeEach, onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { mockOptionalEnv, optionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { settleIncludingAbort } from "../../../utils";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createAuthDeviceSupportApi } from "./api-bdd-auth-device-support";
import { createAuthOrgBddApi } from "./api-bdd-auth-org";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";
import { deliverOrganizationCreated } from "./api-bdd-webhooks";
import { captureConnectorExternalState } from "./public-connector-actor";
import { publicRunOwner } from "./public-run-owner";

export interface RunExecutionCredentialOptions {
  /**
   * How the workspace becomes able to run. `pro` funds it through the Pro
   * invoice webhook (default). `limited-free` uses the public
   * `organization.created` bootstrap: an active limited free entitlement with
   * onboarding credits, for cases whose Given requires no paid plan.
   */
  readonly plan?: "pro" | "limited-free";
  /** Initialize the caller's preferences before the Run (default true). */
  readonly preferences?: boolean;
}

/** Reuse one real, owned Runner execution per caller within the current case. */
export function createRunExecutionCredentials(
  context: TestContext,
  options: RunExecutionCredentialOptions = {},
) {
  const plan = options.plan ?? "pro";
  const preferences = options.preferences ?? true;
  const credentials = new Map<
    string,
    {
      readonly token: string;
      readonly sandboxToken: string;
      readonly runId: string;
      readonly threadId: string;
    }
  >();
  const owners = new Map<string, ReturnType<typeof publicRunOwner>[]>();
  const workspaces = new Map<string, { restore: () => void }>();
  beforeEach(() => {
    workspaces.clear();
    owners.clear();
    credentials.clear();
  });
  async function launchRun(
    identity: {
      readonly userId: string;
      readonly orgId: string | null;
    },
    fresh = false,
  ) {
    if (!identity.orgId) {
      throw new Error("A Runner execution requires an organization");
    }
    const key = JSON.stringify([identity.userId, identity.orgId]);
    const existing = credentials.get(key);
    if (existing && !fresh) {
      return existing;
    }
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user(identity);
    let restoreAccepted = captureConnectorExternalState(context);
    let workspace = workspaces.get(identity.orgId);
    if (!workspace) {
      const ownedWorkspace = { restore: restoreAccepted };
      workspaces.set(identity.orgId, ownedWorkspace);
      workspace = ownedWorkspace;
      // Registered before all Run owners: reverse-order teardown releases
      // every actor's Runs before restoring the shared external mocks.
      onTestFinished(() => {
        ownedWorkspace.restore();
      });
    }
    const ownedWorkspace = workspace;
    const owner = publicRunOwner(context, actor, {
      clockTime: now,
      restoreEnvironment: () => {
        restoreAccepted();
      },
    });
    const actorOwners = owners.get(key) ?? [];
    actorOwners.push(owner);
    owners.set(key, actorOwners);
    const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    const previousOpenrouterKey = optionalEnv("OPENROUTER_API_KEY");
    const token = await owner.run(async () => {
      const result = await settleIncludingAbort(async () => {
        bdd.acceptStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        const runnerGroup = await runs.configureRunnerGroup();
        mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
        // The admin funds this workspace. Issue Run credentials to the actual member.
        const admin =
          actor.orgRole === "org:member"
            ? bdd.user({ orgId: actor.orgId, orgRole: "org:admin" })
            : actor;
        if (plan === "pro") {
          await runs.grantProEntitlement(admin);
        } else {
          await deliverOrganizationCreated(context, admin);
        }
        if (admin.userId !== actor.userId) {
          await bdd.completeOnboarding(actor);
        }
        if (preferences) {
          await createAuthDeviceSupportApi(context).initializePreferences(
            actor,
          );
        }

        const thread = await createChatFilesBddApi(context).createThread(
          actor,
          { model: null },
        );
        const run = await runs.createThreadRun(actor, {
          threadId: thread.id,
          prompt: "Exercise the caller's API access",
        });
        await runs.heartbeatRunner(runnerGroup);
        const execution = await owner.executionInput(run.runId);
        const issued = execution.platformEnvironment?.OKOU_TOKEN;
        if (!issued) {
          throw new Error("Expected the dispatched execution's Okou token");
        }
        return {
          token: issued,
          sandboxToken: execution.sandboxToken,
          runId: run.runId,
          threadId: run.threadId,
        };
      });
      restoreAccepted = captureConnectorExternalState(context);
      ownedWorkspace.restore = restoreAccepted;
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
    forActor(identity: Parameters<typeof launchRun>[0]) {
      return launchRun(identity);
    },
    freshForActor(identity: Parameters<typeof launchRun>[0]) {
      return launchRun(identity, true);
    },
    async removeMember(
      identity: Parameters<typeof launchRun>[0],
      survivingAdmin?: ApiTestUser,
    ) {
      const actorOwners = owners.get(
        JSON.stringify([identity.userId, identity.orgId]),
      );
      if (!actorOwners || !identity.orgId) {
        throw new Error("Launch a Run before revoking its member");
      }
      // Release this actor's accepted work while its credentials still exist.
      const auth = createAuthOrgBddApi(context);
      const actor = auth.user(identity);
      const admin =
        survivingAdmin ??
        auth.user({ orgId: actor.orgId, orgRole: "org:admin" });
      const workspace = workspaces.get(identity.orgId);
      if (!workspace) {
        throw new Error("Expected an owned workspace");
      }
      let restoreAdmin = captureConnectorExternalState(context);
      const administrator = publicRunOwner(context, admin, {
        clockTime: now,
        restoreEnvironment: () => {
          restoreAdmin();
        },
      });
      await administrator.run(async () => {
        const result = await settleIncludingAbort(async () => {
          for (const actorOwner of actorOwners) {
            await actorOwner.cleanup();
          }
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
        workspace.restore = restoreAdmin;
        if (!result.ok) {
          throw result.error;
        }
      });
    },
    async okouToken(identity: Parameters<typeof launchRun>[0]) {
      return (await launchRun(identity)).token;
    },
    async sandboxToken(identity: Parameters<typeof launchRun>[0]) {
      return (await launchRun(identity)).sandboxToken;
    },
  };
}
