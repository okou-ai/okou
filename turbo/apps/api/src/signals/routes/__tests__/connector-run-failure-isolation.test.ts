import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";

const context = testContext();
const connectors = createConnectorBddApi(context);
const firewall = createFirewallApi(context);
const runs = createRunsApi(context);

describe("connector failure isolation in dispatched Runs", () => {
  it.each([
    {
      name: "malformed provider response",
      status: 502,
      error: {
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "upstream_provider",
        connectors: ["lark"],
      },
    },
    {
      name: "deleted account",
      status: 424,
      error: { code: "CONNECTOR_NOT_CONFIGURED" },
    },
  ] as const)(
    "keeps healthy connector and model access through completion after a $name",
    async ({ name, status, error }) => {
      const owned = await publicChatActor(context, {
        beforeWorkspaceCleanup: async (actor) => {
          for (const slug of ["lark", "figma"] as const) {
            for (const account of await connectors.listBuiltinConnectorAccounts(
              actor,
              slug,
            )) {
              await connectors.deleteBuiltinConnectorAccount(
                actor,
                slug,
                account.id,
              );
            }
          }
        },
      });
      await owned.run(async () => {
        const faulty = await connectors.connectManualGrant(
          owned.actor,
          "lark",
          "api-token",
          { appId: "isolated-lark-app", appSecret: "isolated-lark-secret" },
        );
        await connectors.connectManualGrant(owned.actor, "figma", "api-token", {
          accessToken: "isolated-figma-token",
        });
        await runs.enableAgentConnectors(owned.actor, owned.agentId, [
          "lark",
          "figma",
        ]);
        server.use(
          http.post(
            "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
            () => {
              return HttpResponse.json({ code: 0, msg: "ok" });
            },
          ),
        );

        const run = await owned.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          prompt:
            "Continue with healthy tools when one connector is unavailable",
        });
        const { execution, sandboxHeaders } = await owned.runExecution(
          run.runId,
        );
        const credentialSources = {
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        };
        expect(execution.secretConnectorMetadataMap?.LARK_TOKEN).toMatchObject({
          sourceType: "connector",
          sourceId: faulty.id,
        });

        const larkRequest = {
          ...credentialSources,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("LARK_TOKEN")}`,
          },
        };
        if (name === "deleted account") {
          await connectors.deleteBuiltinConnectorAccount(
            owned.actor,
            "lark",
            faulty.id,
          );
        }
        const denied = await firewall.requestFirewallAuth(
          { authorization: `Bearer ${execution.firewallToken}` },
          larkRequest,
          [status],
        );
        expect(denied.body).toMatchObject({ error });
        const healthy = await firewall.requestFirewallAuth(
          { authorization: `Bearer ${execution.firewallToken}` },
          {
            ...credentialSources,
            authHeaders: {
              "X-Figma-Token": secretTemplate("FIGMA_TOKEN"),
            },
          },
          [200],
        );
        expect(healthy.body).toMatchObject({
          headers: {
            "X-Figma-Token": "isolated-figma-token",
          },
        });
        const model = await firewall.requestFirewallAuth(
          { authorization: `Bearer ${execution.firewallToken}` },
          {
            ...credentialSources,
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("CLAUDE_CODE_OAUTH_TOKEN")}`,
            },
          },
          [200],
        );
        expect(model.body).toMatchObject({
          headers: {
            Authorization: "Bearer bdd-personal-claude-token",
          },
        });
        expect((await runs.readRun(owned.actor, run.runId)).status).toBe(
          "running",
        );
        await completePublicClaudeRun(
          context,
          run,
          sandboxHeaders,
          "Finished using the healthy connector and model",
        );
        expect((await runs.readRun(owned.actor, run.runId)).status).toBe(
          "completed",
        );
        if (name === "malformed provider response") {
          await expect(
            connectors.listBuiltinConnectorAccounts(owned.actor, "lark"),
          ).resolves.toContainEqual(expect.objectContaining({ id: faulty.id }));
        }

        const next = await owned.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "Start another Run after a connector authentication failure",
        });
        const nextRun = await owned.runExecution(next.runId);
        expect(nextRun.execution.environment?.FIGMA_TOKEN).toBe(
          "fixture-figma-token",
        );
        expect((await runs.readRun(owned.actor, next.runId)).status).toBe(
          "running",
        );
        await completePublicClaudeRun(
          context,
          next,
          nextRun.sandboxHeaders,
          "Finished the next healthy Run",
        );
        expect((await runs.readRun(owned.actor, next.runId)).status).toBe(
          "completed",
        );
      });
    },
  );
});
