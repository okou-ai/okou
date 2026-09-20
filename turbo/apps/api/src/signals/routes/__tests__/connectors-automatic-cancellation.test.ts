import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { withConnectorAccountCommitBarrierFixture } from "../../../test-fixtures/connector-account-lock";
import { settleIncludingAbort } from "../../utils";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { installAutomaticMcpCatalog } from "./helpers/connector-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" } as const;

describe.each([false, true])(
  "builtin Automatic commit cancellation: %s",
  (cancelDuringCommit) => {
    it.each(["no-auth start", "OAuth callback"] as const)(
      "wakes a running account after %s commits",
      async (operation) => {
        mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
        mockEnv("APP_URL", "https://app.okou.ai");
        mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
        const catalog = await installAutomaticMcpCatalog();
        const targetAuthentication =
          operation === "no-auth start" ? "none" : "oauth";
        const initialProvider = mockAutomaticMcpOAuthProvider(context, {
          registration: "cimd",
          authentication: targetAuthentication === "none" ? "oauth" : "none",
          initialExpiresIn: 3600,
        });
        const bdd = createBddApi(context);
        const runs = createRunsApi(context);
        const connectors = createConnectorBddApi(context);
        const actor = bdd.user();
        bdd.acceptAgentStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        const runnerGroup = runs.configureRunnerGroup();
        await runs.grantProEntitlement(actor);
        await runs.ensureOrgModelProvider(actor);
        const agent = await bdd.createAgent(actor, {
          displayName: "MCP post-commit cancellation",
        });
        const automatic = setupApp({
          context,
          routes: builtinConnectorsAutomaticRoutes,
        })(builtinConnectorAutomaticContract);
        const accounts = setupApp({ context, routes: connectorAccountRoutes })(
          connectorAccountsContract,
        );
        createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
        const initial = await accept(
          automatic.start({
            headers,
            params: { connectorSlug: catalog.slug },
            body: {
              authMethod: catalog.methodId,
              account: { intent: "add" },
              agentId: agent.agentId,
              authorizeAgent: true,
            },
          }),
          [200],
        );
        let connectionId: string;
        if (initial.body.result === "connected") {
          connectionId = initial.body.connectedAccountId;
        } else {
          const state = new URL(initial.body.authorizationUrl).searchParams.get(
            "state",
          );
          if (!state) {
            throw new Error("Expected the initial OAuth state");
          }
          const completed = await accept(
            automatic.callback({
              query: {
                state,
                code: "initial-code",
                iss: initialProvider.issuer,
                responseMode: "json",
              },
            }),
            [200],
          );
          expect(completed.body.status).toBe("success");
          const receipt = await accept(
            accounts.oauthCompletion({
              headers,
              params: { attemptId: initial.body.oauthAttemptId },
              query: catalog.target,
            }),
            [200],
          );
          connectionId = receipt.body.connectionId;
        }
        let runId: string | undefined;
        const outcome = await settleIncludingAbort(async () => {
          const run = await runs.createRun(actor, {
            agentId: agent.agentId,
            prompt: "Keep the selected MCP account current",
            modelProvider: "anthropic-api-key",
          });
          runId = run.runId;
          await runs.heartbeatRunner(runnerGroup);
          const claim = await runs.claimRunnerJob(run.runId);
          const registration = claim.connectorRuntimeTargets.find((entry) => {
            return (
              entry.kind === "builtin" && entry.connectorSlug === catalog.slug
            );
          });
          expect(registration).toMatchObject({ sourceId: connectionId });
          if (!registration) {
            throw new Error("Expected the running builtin MCP account");
          }
          const provider = mockAutomaticMcpOAuthProvider(context, {
            registration: "cimd",
            authentication: targetAuthentication,
            initialExpiresIn: 3600,
          });
          const reconnect = {
            headers,
            params: { connectorSlug: catalog.slug },
            body: {
              authMethod: catalog.methodId,
              account: { intent: "reconnect" as const, connectionId },
            },
          };
          let oauthState: string | undefined;
          if (operation === "OAuth callback") {
            const started = await accept(automatic.start(reconnect), [200]);
            if (started.body.result !== "authorization") {
              throw new Error("Expected reconnect OAuth authorization");
            }
            oauthState =
              new URL(started.body.authorizationUrl).searchParams.get(
                "state",
              ) ?? undefined;
            if (!oauthState) {
              throw new Error("Expected reconnect OAuth state");
            }
          }
          const cancelled = new AbortController();
          const cancellable = setupApp({
            context,
            routes: builtinConnectorsAutomaticRoutes,
            signal: AbortSignal.any([context.signal, cancelled.signal]),
            rethrowErrors: true,
          })(builtinConnectorAutomaticContract);
          context.mocks.ably.batchPublish.mockClear();

          // Infrastructure exception: a request cannot hold its own COMMIT at the
          // provider boundary. Execute every real SQL statement unchanged, pausing
          // after the writer's last cancellation check and before COMMIT completes.
          await withConnectorAccountCommitBarrierFixture(
            connectionId,
            async (barrier) => {
              const pending = settleIncludingAbort(
                (async () => {
                  if (oauthState === undefined) {
                    return await cancellable.start(reconnect);
                  }
                  return await cancellable.callback({
                    query: {
                      state: oauthState,
                      code: "reconnected-code",
                      iss: provider.issuer,
                      responseMode: "json",
                    },
                  });
                })(),
              );
              const aborting = await settleIncludingAbort(async () => {
                await barrier.entered;
                if (cancelDuringCommit) {
                  cancelled.abort();
                }
              });
              barrier.release();
              const requestResult = await pending;
              if (!aborting.ok) {
                throw aborting.error;
              }
              expect(requestResult).toMatchObject(
                cancelDuringCommit
                  ? { ok: false, error: { name: "AbortError" } }
                  : {
                      ok: true,
                      value: {
                        status: 200,
                        body:
                          operation === "no-auth start"
                            ? {
                                result: "connected",
                                connectedAccountId: connectionId,
                              }
                            : { status: "success" },
                      },
                    },
              );
            },
            context.signal,
          );

          const account = await accept(
            accounts.connection({
              headers,
              params: { connectionId },
              query: catalog.target,
            }),
            [200],
          );
          expect(account.body).toMatchObject({
            authMethod: catalog.methodId,
            connectionStatus: "connected",
          });
          const [runtime] = await runs.syncConnectorRuntime(run.runId, {
            targets: [registration],
          });
          expect(runtime).toMatchObject({
            state: "available",
          });
          expect(runtime).not.toHaveProperty("firewall");
          expect(context.mocks.ably.batchPublish).toHaveBeenCalledWith({
            channels: [`runner-group:${runnerGroup}`],
            messages: [
              {
                name: "connector-runtime-sync",
                data: JSON.stringify({
                  runId: run.runId,
                  target: catalog.target,
                }),
                encoding: "json",
              },
            ],
          });
        });
        if (runId) {
          await runs.requestCancelRun(actor, runId, [200]);
        }
        await connectors.deleteBuiltinConnectorAccount(
          actor,
          catalog.slug,
          connectionId,
        );
        await bdd.deleteAgent(actor, agent.agentId);
        if (!outcome.ok) {
          throw outcome.error;
        }
      },
    );
  },
);
