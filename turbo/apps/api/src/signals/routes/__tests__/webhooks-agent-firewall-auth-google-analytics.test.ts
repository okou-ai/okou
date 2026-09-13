import { randomUUID } from "node:crypto";

import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function setupAnalyticsFirewall() {
  const bdd = createBddApi(context);
  const fw = createFirewallApi(context);
  const runs = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await fw.provisionRunReadyOrg(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Analytics refresh agent",
    description: "Exercises Analytics refresh and reconnect.",
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "resolve Analytics firewall auth",
    modelProvider: "anthropic-api-key",
  });
  const headers = fw.sandboxHeaders(actor, run.runId);
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  server.use(
    http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(code).toBeTruthy();
      return HttpResponse.json({
        access_token: `analytics-access-${code}`,
        refresh_token: `analytics-refresh-${code}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/analytics.readonly",
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", ({ request }) => {
      const identity = request.headers.get("authorization");
      return HttpResponse.json({ id: identity, name: identity, email: null });
    }),
  );

  async function connect(
    code: string,
    account: ConnectorAccountMutationIntent,
  ) {
    const started = await connectors.startOauth(
      actor,
      "google-analytics",
      "oauth",
      agent.agentId,
      account,
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Analytics OAuth state");
    }
    const result = await connectors.completeOauthCallbackResult(
      "google-analytics",
      { code, state },
    );
    expect(result.body.status).toBe("success");
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "google-analytics",
    );
    const connected = accounts.find((candidate) => {
      return candidate.externalId === `Bearer analytics-access-${code}`;
    });
    if (!connected) {
      throw new Error("Expected the authorized Analytics account");
    }
    return connected;
  }

  function request(connectionId: string, forceRefresh: boolean) {
    return fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("GOOGLE_ANALYTICS_TOKEN")}`,
        },
        secretConnectorMap: { GOOGLE_ANALYTICS_TOKEN: "google-analytics" },
        secretConnectorMetadataMap: {
          GOOGLE_ANALYTICS_TOKEN: {
            sourceType: "connector",
            sourceId: connectionId,
          },
        },
        forceRefresh,
      },
      [200, 502],
    );
  }

  const code = randomUUID();
  const account = await connect(code, { intent: "add" });
  return { actor, account, code, connect, connectors, request };
}

describe("Google Analytics quiet refresh recovery", () => {
  it.each([
    { subtype: undefined, reason: "authorization_expired_or_revoked" },
    { subtype: "invalid_rapt", reason: "provider_session_expired" },
  ])(
    "retries $reason quietly and recovers the exact account",
    async ({ subtype, reason }) => {
      const analytics = await setupAnalyticsFirewall();
      const siblingCode = randomUUID();
      const sibling = await analytics.connect(siblingCode, { intent: "add" });
      const started = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      let refreshCalls = 0;
      server.use(
        http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
          const body = new URLSearchParams(await request.clone().text());
          if (body.get("grant_type") !== "refresh_token") {
            return;
          }
          expect(body.get("refresh_token")).toBe(
            `analytics-refresh-${analytics.code}`,
          );
          refreshCalls += 1;
          if (!started.settled()) {
            started.resolve(undefined);
          }
          await release.promise;
          return HttpResponse.json(
            {
              error: "invalid_grant",
              ...(subtype ? { error_subtype: subtype } : {}),
            },
            { status: 400 },
          );
        }),
      );
      context.mocks.sentry.captureException.mockClear();

      const first = analytics.request(analytics.account.id, true);
      await started.promise;
      const concurrent = analytics.request(analytics.account.id, true);
      release.resolve(undefined);
      const [firstFailure, concurrentFailure] = await Promise.all([
        first,
        concurrent,
      ]);
      // Existing request coalescing can reuse the first failure without its reason.
      expect(concurrentFailure.status).toBe(502);
      expect(concurrentFailure.body).toMatchObject({
        error: {
          code: "TOKEN_REFRESH_FAILED",
          connectors: ["google-analytics"],
        },
      });
      const callsBeforeRetries = refreshCalls;
      const responses = [firstFailure];
      await analytics.connectors.setDefaultBuiltinConnectorAccount(
        analytics.actor,
        "google-analytics",
        sibling.id,
      );
      responses.push(await analytics.request(analytics.account.id, false));
      responses.push(await analytics.request(analytics.account.id, true));
      for (const response of responses) {
        expect(response.status).toBe(502);
        expect(response.body).toMatchObject({
          error: {
            code: "TOKEN_REFRESH_FAILED",
            failureReason: "reconnect_required",
            connectors: ["google-analytics"],
          },
        });
      }
      expect(refreshCalls).toBe(callsBeforeRetries + 2);
      const accounts = await analytics.connectors.listBuiltinConnectorAccounts(
        analytics.actor,
        "google-analytics",
      );
      expect(accounts).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: analytics.account.id,
            connectionStatus: "reconnect-required",
            reconnectReason: reason,
          }),
          expect.objectContaining({
            id: sibling.id,
            connectionStatus: "connected",
            reconnectReason: null,
          }),
        ]),
      );
      const siblingAuth = await analytics.request(sibling.id, false);
      expect(siblingAuth.status).toBe(200);
      expect(siblingAuth.body).toMatchObject({
        headers: { Authorization: `Bearer analytics-access-${siblingCode}` },
      });
      expect(refreshCalls).toBe(callsBeforeRetries + 2);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();

      // A later request can recover with the same refresh token, without OAuth.
      server.use(
        http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          expect(body.get("refresh_token")).toBe(
            `analytics-refresh-${analytics.code}`,
          );
          return HttpResponse.json({
            access_token: "analytics-recovered-without-reconnect",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }),
      );
      const retried = await analytics.request(analytics.account.id, false);
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({
        headers: {
          Authorization: "Bearer analytics-recovered-without-reconnect",
        },
      });
      await expect(
        analytics.connectors.listBuiltinConnectorAccounts(
          analytics.actor,
          "google-analytics",
        ),
      ).resolves.toContainEqual(
        expect.objectContaining({
          id: analytics.account.id,
          connectionStatus: "connected",
          reconnectReason: null,
        }),
      );

      // A real OAuth callback must clear the persisted reconnect state.
      server.use(
        http.post(GOOGLE_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "analytics-reconnected",
            refresh_token: "analytics-new-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/analytics.readonly",
          });
        }),
        http.get("https://www.googleapis.com/oauth2/v2/userinfo", () => {
          return HttpResponse.json({
            id: analytics.account.externalId,
            name: "Reconnected Analytics user",
            email: null,
          });
        }),
      );
      const reconnected = await analytics.connect(analytics.code, {
        intent: "reconnect",
        connectionId: analytics.account.id,
      });
      expect(reconnected).toMatchObject({
        id: analytics.account.id,
        connectionStatus: "connected",
        reconnectReason: null,
      });
      const current = await analytics.request(analytics.account.id, false);
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject({
        headers: { Authorization: "Bearer analytics-reconnected" },
      });
      server.use(
        http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          expect(body.get("refresh_token")).toBe("analytics-new-refresh");
          return HttpResponse.json({
            access_token: "analytics-refreshed",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }),
      );
      const recovered = await analytics.request(analytics.account.id, true);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({
        headers: { Authorization: "Bearer analytics-refreshed" },
      });
    },
  );

  it.each([
    {
      name: "unknown subtype",
      status: 400,
      error: "invalid_grant",
      subtype: "unknown_policy",
      failureReason: "reconnect_required",
    },
    {
      name: "unknown OAuth error",
      status: 400,
      error: "invalid_client",
      subtype: undefined,
      failureReason: undefined,
    },
    {
      name: "provider outage",
      status: 503,
      error: "server_error",
      subtype: undefined,
      failureReason: "upstream_provider",
    },
    {
      name: "rate limit",
      status: 429,
      error: "temporarily_unavailable",
      subtype: undefined,
      failureReason: "upstream_provider",
    },
    {
      name: "unexpected invalid_grant status",
      status: 503,
      error: "invalid_grant",
      subtype: undefined,
      failureReason: "reconnect_required",
    },
  ])(
    "keeps $name observable and recoverable",
    async ({ status, error, subtype, failureReason }) => {
      const analytics = await setupAnalyticsFirewall();
      let refreshCalls = 0;
      server.use(
        http.post(GOOGLE_TOKEN_URL, () => {
          refreshCalls += 1;
          return HttpResponse.json(
            { error, ...(subtype ? { error_subtype: subtype } : {}) },
            { status },
          );
        }),
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = await analytics.request(analytics.account.id, true);
        expect(failed.status).toBe(502);
        if (failed.status !== 502) {
          throw new Error("Expected Analytics refresh failure");
        }
        expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
        expect(failed.body.error.failureReason).toBe(failureReason);
      }
      expect(refreshCalls).toBe(2);
      const accounts = await analytics.connectors.listBuiltinConnectorAccounts(
        analytics.actor,
        "google-analytics",
      );
      expect(accounts).toContainEqual(
        expect.objectContaining({
          id: analytics.account.id,
          reconnectReason:
            error === "invalid_grant" && !subtype
              ? "authorization_expired_or_revoked"
              : null,
        }),
      );
      server.use(
        http.post(GOOGLE_TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "analytics-recovered",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }),
      );
      const recovered = await analytics.request(analytics.account.id, true);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toMatchObject({
        headers: { Authorization: "Bearer analytics-recovered" },
      });
    },
  );
});
