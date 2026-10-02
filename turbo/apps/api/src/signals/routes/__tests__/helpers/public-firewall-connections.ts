import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import type { TestContext } from "../../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import {
  createConnectorBddApi,
  mockTestOAuthAuthCodeProvider,
  mockTestOAuthDeviceConnectorProvider,
} from "./api-bdd-connectors";
import { createFirewallApi } from "./api-bdd-firewall";
import { createRunsApi } from "./api-bdd-runs";

interface ProviderToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}

/** Ordinary firewall cases acquire connections through real provider callbacks. */
export function createPublicFirewallConnections(context: TestContext) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const runCleanups: (() => Promise<void>)[] = [];

  async function run() {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD firewall agent",
      description: "Exercises firewall auth resolution.",
      visibility: "private",
    });
    runCleanups.push(async () => {
      await bdd.deleteAgent(actor, agent.agentId);
    });
    const created = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "resolve firewall auth",
    });
    runCleanups.push(async () => {
      const current = await runs.readRun(actor, created.runId);
      if (current.status === "pending" || current.status === "running") {
        await runs.requestCancelRun(actor, created.runId, [200]);
      }
      await flushWaitUntilForTest();
    });
    if (created.status !== "pending" && created.status !== "running") {
      throw new Error("Expected an active Run for firewall authorization");
    }
    return {
      actor,
      runId: created.runId,
      headers: createFirewallApi(context).sandboxHeaders(actor, created.runId),
    };
  }

  async function completeOAuth(
    actor: ApiTestUser,
    slug: "test-oauth" | "gmail" | "google-ads" | "notion",
    method: "oauth" | "api" = "oauth",
  ) {
    const started = await connectors.startOauth(actor, slug, method);
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected the real OAuth start to issue state");
    }
    const completed = await connectors.completeOauthCallbackResult(slug, {
      code: `firewall-${randomUUID()}`,
      state,
    });
    if (completed.body.status !== "success") {
      throw new Error(`Expected successful ${slug} OAuth acquisition`);
    }
  }

  async function testOAuth(
    actor: ApiTestUser,
    token: ProviderToken,
    method: "oauth" | "api" = "oauth",
  ) {
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mockTestOAuthAuthCodeProvider({
      ...token,
      omitExpiresIn: token.expiresIn === undefined,
      scope: "",
      // The real mapped-input provider derives its tenant variable from UserInfo.
      userId: `test-oauth-${method}-tenantId`,
      username: "e2e-test-oauth",
      email: "e2e-test-oauth@test.vm0.ai",
    });
    await completeOAuth(actor, "test-oauth", method);
  }

  async function googleOAuth(
    actor: ApiTestUser,
    slug: "gmail" | "google-ads",
    token: ProviderToken,
  ) {
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") !== "authorization_code") {
          throw new Error("Expected OAuth acquisition before refresh probes");
        }
        return HttpResponse.json({
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          ...(token.expiresIn === undefined
            ? {}
            : { expires_in: token.expiresIn }),
          token_type: "Bearer",
          scope: "",
        });
      }),
      http.get(
        slug === "gmail"
          ? "https://openidconnect.googleapis.com/v1/userinfo"
          : "https://www.googleapis.com/oauth2/v2/userinfo",
        () => {
          return HttpResponse.json({
            ...(slug === "gmail"
              ? { sub: `e2e-test-${slug}` }
              : { id: `e2e-test-${slug}` }),
            email: `e2e-${slug}@test.vm0.ai`,
            name: `e2e-${slug}`,
          });
        },
      ),
    );
    await completeOAuth(actor, slug);
  }

  async function notionOAuth(actor: ApiTestUser, token: ProviderToken) {
    mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client-id");
    mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-client-secret");
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          expires_in: token.expiresIn,
          owner: {
            user: {
              id: "e2e-test-notion",
              name: "e2e-notion",
              person: { email: "e2e-notion@test.vm0.ai" },
            },
          },
        });
      }),
    );
    await completeOAuth(actor, "notion");
    // These cases exercise credentials retained after operator configuration is removed.
    mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", undefined);
    mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", undefined);
  }

  async function deviceOAuth(actor: ApiTestUser, token: ProviderToken) {
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mockTestOAuthDeviceConnectorProvider();
    server.use(
      http.post(
        "http://localhost:3000/api/test/oauth-provider/token",
        async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          if (
            body.get("grant_type") !==
            "urn:ietf:params:oauth:grant-type:device_code"
          ) {
            throw new Error("Expected the real device authorization poll");
          }
          return HttpResponse.json({
            access_token: token.accessToken,
            ...(token.expiresIn === undefined
              ? {}
              : { expires_in: token.expiresIn }),
            token_type: "Bearer",
            scope: "",
          });
        },
      ),
    );
    const session = await connectors.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const completed = await connectors.pollDeviceAuth(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
    );
    if (completed.status !== "complete") {
      throw new Error("Expected the provider to complete device authorization");
    }
  }

  async function cleanup() {
    for (const cleanupRun of runCleanups.splice(0).reverse()) {
      await cleanupRun();
    }
  }

  return { run, testOAuth, googleOAuth, notionOAuth, deviceOAuth, cleanup };
}
