import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import type { ApplyUserPermissionGrant } from "@okouai/api-contracts/contracts/user-permission-grants";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { connectorPermissionsRoutes } from "../connector-permissions";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  mockGitHubConnectorOAuth,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const {
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

async function sharedGrants(
  actor: ApiTestUser,
  connectorSlug: string,
  grants: readonly ApplyUserPermissionGrant[],
  mode: "patch" | "replace" = "patch",
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    setupApp({ context, routes: connectorPermissionsRoutes })(
      connectorPermissionsContract,
    ).apply({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        target: { kind: "builtin", connectorSlug },
        mode,
        grants: [...grants],
      },
    }),
    [200],
  );
}

describe.each([false, true])(
  "Runner claim current connector permissions (Chat accounts: %s)",
  (chatAccounts) => {
    it.each(["add", "revoke"] as const)(
      "applies a %s grant change made after the Run was queued",
      async (change) => {
        const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
        mockGitHubConnectorOAuth();
        server.use(
          http.delete(
            "https://api.github.com/applications/github-client-id/grant",
            () => {
              return new HttpResponse(null, { status: 204 });
            },
          ),
        );
        const started = await connectors.startOauth(
          actor,
          "github",
          "oauth",
          agentId,
        );
        const state = new URL(started.authorizationUrl).searchParams.get(
          "state",
        );
        if (!state) {
          throw new Error(
            "Expected OAuth state from the public start response",
          );
        }
        const completed = await connectors.completeOauthCallbackResult(
          "github",
          {
            state,
            code: randomUUID(),
          },
        );
        expect(completed.body.status).toBe("success");
        const runs = createRunsApi(context);
        const grant = {
          agentId,
          connectorSlug: "github" as const,
          permission: "user:read",
          action: "deny" as const,
        };
        if (change === "revoke") {
          await runs.applyUserPermissionGrant(actor, grant);
          await connectors.updateFeatureSwitches(actor, {
            connectorChatAccountAccess: true,
          });
          await sharedGrants(actor, "github", [
            { permission: grant.permission, action: grant.action },
          ]);
        }
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const queued = await sendChatRun(actor, {
          agentId,
          prompt: "use the current GitHub permissions at claim",
        });
        if (change === "add") {
          if (chatAccounts) {
            await sharedGrants(actor, "github", [
              { permission: grant.permission, action: grant.action },
            ]);
          } else {
            await runs.applyUserPermissionGrant(actor, grant);
          }
        } else if (chatAccounts) {
          await sharedGrants(actor, "github", [], "replace");
        } else {
          await expect(
            runs.replaceUserPermissionGrants(actor, {
              agentId,
              connectorSlug: "github",
              grants: [],
            }),
          ).resolves.toStrictEqual([]);
        }
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          queued.runId,
        );
        expect(claim.connectorRuntimeTargets).toContainEqual(
          expect.objectContaining({ kind: "builtin", connectorSlug: "github" }),
        );
        expect(claim.networkPolicies?.github).toMatchObject(
          change === "add"
            ? {
                deny: expect.arrayContaining(["user:read"]),
                allow: expect.not.arrayContaining(["user:read"]),
              }
            : {
                allow: expect.arrayContaining(["user:read"]),
                deny: expect.not.arrayContaining(["user:read"]),
              },
        );
        expect(claim.networkPolicies?.github?.allow).toContain(
          "notifications:read",
        );
        await cancelChatRun(actor, queued.runId, sandboxHeaders);
        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          "github",
        );
        for (const account of accounts) {
          await connectors.deleteBuiltinConnectorAccount(
            actor,
            "github",
            account.id,
          );
        }
      },
    );

    it.each([false, true])(
      "uses the current temporary grant when expired before claim: %s",
      async (expired) => {
        const startedAt = Date.parse("2026-11-05T00:00:00.000Z");
        mockNow(startedAt);
        const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
        mockSlackConnectorOAuth();
        const started = await connectors.startOauth(
          actor,
          "slack",
          "oauth",
          agentId,
        );
        const state = new URL(started.authorizationUrl).searchParams.get(
          "state",
        );
        if (!state) {
          throw new Error(
            "Expected OAuth state from the public start response",
          );
        }
        const completed = await connectors.completeOauthCallbackResult(
          "slack",
          { state, code: randomUUID() },
        );
        expect(completed.body.status).toBe("success");
        const runs = createRunsApi(context);
        const grant = {
          permission: "chat:write",
          action: "allow" as const,
          expiresIn: "1h" as const,
        };
        await runs.applyUserPermissionGrant(actor, {
          agentId,
          connectorSlug: "slack",
          ...(chatAccounts && !expired
            ? { permission: grant.permission, action: "deny" as const }
            : { ...grant, expiresIn: chatAccounts ? "always" : "1h" }),
        });
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: true,
        });
        await sharedGrants(actor, "slack", [
          { ...grant, expiresIn: chatAccounts ? "1h" : "always" },
        ]);
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const queued = await sendChatRun(actor, {
          agentId,
          prompt: "use the current Slack write grant and its original expiry",
        });
        const expiresAt = startedAt + 60 * 60 * 1000;
        mockNow(expired ? expiresAt : startedAt + 30 * 60 * 1000);
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          queued.runId,
        );
        expect(claim.networkPolicies?.slack?.allow).toStrictEqual(
          expired
            ? expect.not.arrayContaining(["chat:write"])
            : expect.arrayContaining(["chat:write"]),
        );
        if (expired) {
          expect(claim.networkPolicies?.slack?.deny).toContain("chat:write");
          expect(claim.networkPolicyRefreshes?.slack).toBeUndefined();
        } else {
          expect(claim.networkPolicyRefreshes?.slack).toStrictEqual({
            nextRefreshAt: new Date(expiresAt).toISOString(),
          });
          mockNow(expiresAt);
          const synced = await runs.syncConnectorRuntime(queued.runId, {
            targets: claim.connectorRuntimeTargets.filter((target) => {
              return (
                target.kind === "builtin" && target.connectorSlug === "slack"
              );
            }),
          });
          expect(synced).toContainEqual(
            expect.objectContaining({
              target: { kind: "builtin", connectorSlug: "slack" },
              state: "available",
              networkPolicy: expect.objectContaining({
                deny: expect.arrayContaining(["chat:write"]),
                allow: expect.not.arrayContaining(["chat:write"]),
              }),
            }),
          );
        }
        await cancelChatRun(actor, queued.runId, sandboxHeaders);
      },
    );
  },
);
