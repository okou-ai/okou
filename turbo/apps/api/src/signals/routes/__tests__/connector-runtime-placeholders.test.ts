import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const connectors = createConnectorBddApi(context);
const firewall = createFirewallApi(context);
const runs = createRunsApi(context);

describe("official connector runtime placeholders", () => {
  it("dispatches all GitHub aliases without decrypting their secret and resolves auth on demand", async () => {
    const kms = useSecretKmsProbe();
    const owned = await publicChatActor(context, {
      optionalEnvironmentNames: [
        "GH_OAUTH_CLIENT_ID",
        "GH_OAUTH_CLIENT_SECRET",
      ],
      beforeWorkspaceCleanup: async (actor) => {
        for (const account of await connectors.listBuiltinConnectorAccounts(
          actor,
          "github",
        )) {
          await connectors.deleteBuiltinConnectorAccount(
            actor,
            "github",
            account.id,
          );
        }
      },
    });
    await owned.run(async () => {
      mockGitHubConnectorOAuth();
      server.use(
        http.delete(
          "https://api.github.com/applications/github-client-id/grant",
          () => {
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );
      const start = await connectors.startOauth(owned.actor, "github", "oauth");
      const state = new URL(start.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected GitHub authorization state");
      }
      await connectors.completeOauthCallback("github", {
        code: "placeholder-dispatch",
        state,
      });
      const account = await connectors.readDefaultBuiltinAccount(
        owned.actor,
        "github",
      );

      const decryptsBeforeRun = kms.decryptCalls;
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Use GitHub through request-time authentication",
      });
      const { execution, sandboxHeaders } = await owned.runExecution(run.runId);
      expect(kms.decryptCalls).toBe(decryptsBeforeRun);
      expect(execution.environment?.GITHUB_TOKEN).toBeTruthy();
      expect(execution.environment?.GH_TOKEN).toBe(
        execution.environment?.GITHUB_TOKEN,
      );
      expect(execution.environment?.GH_TOKEN).not.toBe(
        "github-access-placeholder-dispatch",
      );
      expect(JSON.stringify(execution)).not.toContain(
        "github-access-placeholder-dispatch",
      );
      for (const alias of ["GH_TOKEN", "GITHUB_TOKEN"]) {
        expect(execution.secretConnectorMetadataMap?.[alias]).toMatchObject({
          sourceType: "connector",
          sourceId: account.id,
        });
      }

      // Host authority still requires the admitted connector account reference.
      const withoutSource = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("GITHUB_TOKEN")}`,
          },
        },
        [424],
      );
      expect(withoutSource.body).toMatchObject({
        error: { code: "CONNECTOR_NOT_CONFIGURED" },
      });
      const resolved = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("GITHUB_TOKEN")}`,
          },
        },
        [200],
      );
      expect(resolved.body).toMatchObject({
        headers: { Authorization: "Bearer github-access-placeholder-dispatch" },
      });
      expect(kms.decryptCalls).toBeGreaterThan(decryptsBeforeRun);
      await completePublicClaudeRun(
        context,
        run,
        sandboxHeaders,
        "Finished with lazy GitHub authentication",
      );
      expect((await runs.readRun(owned.actor, run.runId)).status).toBe(
        "completed",
      );
    });
  });
});
