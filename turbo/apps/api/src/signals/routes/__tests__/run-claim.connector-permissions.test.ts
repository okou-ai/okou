import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockGitHubConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

describe("Runner claim current connector permissions", () => {
  it.each(["add", "revoke"] as const)(
    "applies a %s grant change made after the Run was queued",
    async (change) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      mockGitHubConnectorOAuth();
      const started = await connectors.startOauth(
        actor,
        "github",
        "oauth",
        agentId,
      );
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected OAuth state from the public start response");
      }
      const completed = await connectors.completeOauthCallbackResult("github", {
        state,
        code: randomUUID(),
      });
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
      }
      const queued = await sendChatRun(actor, {
        agentId,
        prompt: "use the current GitHub permissions at claim",
      });
      if (change === "add") {
        await runs.applyUserPermissionGrant(actor, grant);
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
});
