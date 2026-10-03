import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  manualHttpCustomConnectorCreateBody,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";

const context = testContext({ connectorCatalog: true });
const {
  api,
  connectors,
  entitledNativeChatActor,
  seedBuiltInModelKey,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  sessionHeaders,
} = createChatEventsFixture(context);
const MODEL = "claude-fable-5-1";
const misc = createMiscRoutesApi(context);

function codexCredential() {
  const jwt = Buffer.from(
    JSON.stringify({
      exp: Math.floor(now() / 1000) + 7200,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "context-batch-account",
        chatgpt_plan_type: "plus",
      },
    }),
  ).toString("base64url");
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: `e30.${jwt}.test-signature`,
      refresh_token: "context-batch-refresh",
      account_id: "context-batch-account",
      id_token: `e30.${jwt}.test-signature`,
    },
  });
}

describe("shared context statement projections through normal sends", () => {
  it.each(["empty", "providers", "agent", "all"] as const)(
    "preserves %s rowsets in first and continuation sends",
    async (mode) => {
      const { actor, agentId, runnerGroup, providerId } =
        await entitledNativeChatActor();
      const hasProviders = mode === "providers" || mode === "all";
      const hasAgentRows = mode === "agent" || mode === "all";
      if (hasProviders) {
        await misc.upsertPersonalModelProvider(
          actor,
          {
            type: "codex-oauth-token",
            authMethod: "auth_json",
            secrets: { CODEX_AUTH_JSON: codexCredential() },
          },
          [200, 201],
        );
        await api.updateOrgModelPolicies(actor, [
          {
            model: MODEL,
            preferred: true,
            defaultProviderType: "anthropic-api-key",
            credentialScope: "org",
            modelProviderId: providerId,
          },
        ]);
      } else {
        await seedBuiltInModelKey(MODEL);
        await api.updateOrgModelPolicies(actor, [
          {
            model: MODEL,
            preferred: true,
            defaultProviderType: "built-in",
            credentialScope: "org",
            modelProviderId: null,
          },
        ]);
        await misc.deleteOrgModelProvider(actor, "anthropic-api-key", [204]);
      }
      let customId: string | undefined;
      let workflowId: string | undefined;
      if (hasAgentRows) {
        mockSlackConnectorOAuth();
        const slack = await connectors.startOauth(
          actor,
          "slack",
          "oauth",
          agentId,
        );
        const state = new URL(slack.authorizationUrl).searchParams.get("state");
        if (!state) {
          throw new Error("Expected Slack authorization state");
        }
        await connectors.completeOauthCallback("slack", {
          code: "batch-slack-code",
          state,
        });
        const custom = await connectors.createCustomConnector(
          actor,
          manualHttpCustomConnectorCreateBody({
            slug: `_batch-${randomUUID()}`,
            displayName: "Batch custom connector",
            prefixTemplates: ["https://batch.example.test/"],
          }),
        );
        customId = custom.id;
        await connectors.setCustomConnectorSecret(
          actor,
          custom.id,
          "context-batch-custom-secret",
        );
        await connectors.updateAgentCustomConnectors(actor, agentId, [
          custom.id,
        ]);
        const workflow = await misc.createWorkflow(
          actor,
          agentId,
          `batch-${randomUUID().slice(0, 8)}`,
          { content: "# Batch skill\nPreserve this selected workflow." },
          [201],
        );
        if (workflow.status !== 201) {
          throw new Error("Expected workflow publication");
        }
        workflowId = workflow.body.id;
        const response = await accept(
          setupApp({ context, routes: userPermissionGrantsRoutes })(
            userPermissionGrantsContract,
          ).apply({
            headers: sessionHeaders(actor),
            body: {
              agentId,
              connectorSlug: "slack",
              mode: "replace",
              grants: [{ permission: "__unknown__", action: "deny" }],
            },
          }),
          [200],
        );
        expect(response.body).toContainEqual(
          expect.objectContaining({
            action: "deny",
            permission: "__unknown__",
          }),
        );
      }
      let threadId: string | undefined;
      for (const flow of ["first", "continuation"]) {
        const run = await sendChatRun(actor, {
          agentId,
          ...(threadId ? { threadId } : {}),
          prompt: `${mode} ${flow}`,
        });
        threadId = run.threadId;
        const claimed = await claimChatRun(runnerGroup, run.runId);
        expect(claimed.claim.modelUsageProvider).toBe(MODEL);
        const targets = claimed.claim.connectorRuntimeTargets;
        if (customId) {
          expect(targets).toContainEqual(
            expect.objectContaining({
              kind: "custom",
              customConnectorId: customId,
            }),
          );
          expect(targets).toContainEqual(
            expect.objectContaining({
              kind: "builtin",
              connectorSlug: "slack",
            }),
          );
          expect(claimed.claim.networkPolicies?.slack?.unknownPolicy).toBe(
            "deny",
          );
        } else {
          expect(targets).toStrictEqual([]);
        }
        const mounts =
          expectCanonicalStorageManifest(claimed.claim.storageManifest)
            ?.storageMounts ?? [];
        if (workflowId) {
          expect(mounts).toContainEqual(
            expect.objectContaining({
              name: getCustomSkillStorageName(workflowId),
              versionId: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
          );
        } else {
          expect(
            mounts.some((mount) => {
              return mount.name.startsWith("custom-skill@");
            }),
          ).toBeFalsy();
        }
        await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
      }
    },
  );
});
