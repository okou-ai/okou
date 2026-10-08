import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import type { RouteEntry } from "../../route-entry";
import { feishuOauthRoutes } from "../feishu-oauth";
import { slackCommandsRoutes } from "../slack-commands";
import { slackInteractiveRoutes } from "../slack-interactive";
import { teamsOauthRoutes } from "../teams-oauth";

const context = testContext();
const REQUEST_ORIGIN = "http://api.test";
const APP_ORIGIN = "https://app.okou.test";
const WEB_ORIGIN = "https://www.okou.test";
// Generated rather than written as a literal so this file does not add another
// hardcoded HMAC key, which the diff-aware Semgrep scan rejects outright.
const SLACK_SIGNING_SECRET = randomBytes(32).toString("hex");
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

interface ResponseSnapshot {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

async function snapshot(response: Response): Promise<ResponseSnapshot> {
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
  };
}

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

async function getRequest(
  routes: readonly RouteEntry[],
  path: string,
): Promise<ResponseSnapshot> {
  const app = createAppWithRoutes({ signal: context.signal, routes });
  return await snapshot(
    await app.request(`${REQUEST_ORIGIN}${path}`, { method: "GET" }),
  );
}

async function slackIngressRequest(args: {
  readonly routes: readonly RouteEntry[];
  readonly path: string;
  readonly body: string;
  readonly contentType: string;
}): Promise<ResponseSnapshot> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: args.routes,
  });
  return await snapshot(
    await app.request(`${REQUEST_ORIGIN}${args.path}`, {
      method: "POST",
      headers: {
        "content-type": args.contentType,
      },
      body: args.body,
    }),
  );
}

describe("provider console paths", () => {
  beforeEach(() => {
    mockEnv("APP_URL", APP_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
    mockEnv("SLACK_OAUTH_CLIENT_ID", "slack-client-id");
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-client-secret");
    mockOptionalEnv("SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET);
    mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "microsoft-client-id");
    mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "microsoft-client-secret");
  });

  describe("GET /api/integrations/teams/oauth/callback", () => {
    const path = "/api/integrations/teams/oauth/callback";

    it("rejects a callback without an authorization code", async () => {
      await expect(getRequest(teamsOauthRoutes, path)).resolves.toStrictEqual({
        status: 400,
        location: null,
        body: jsonBody({ error: "Missing authorization code" }),
      });
    });

    it("builds the failure redirect for a denied authorization", async () => {
      await expect(
        getRequest(teamsOauthRoutes, `${path}?error=access_denied`),
      ).resolves.toStrictEqual({
        status: 307,
        location: `${APP_ORIGIN}/settings/teams?error=access_denied`,
        body: "",
      });
    });
  });

  describe("GET /api/integrations/feishu/oauth/callback", () => {
    it("rejects a callback without connect state", async () => {
      await expect(
        getRequest(
          feishuOauthRoutes,
          "/api/integrations/feishu/oauth/callback",
        ),
      ).resolves.toStrictEqual({
        status: 400,
        location: null,
        body: jsonBody({ error: "Invalid or expired connect state" }),
      });
    });
  });

  describe("POST /api/webhooks/slack/commands", () => {
    const path = "/api/webhooks/slack/commands";
    const body = "command=%2Fokou&text=help";

    it("rejects an unsigned request", async () => {
      await expect(
        slackIngressRequest({
          routes: slackCommandsRoutes,
          path,
          body,
          contentType: FORM_CONTENT_TYPE,
        }),
      ).resolves.toStrictEqual({
        status: 401,
        location: null,
        body: jsonBody({ error: "Missing Slack signature headers" }),
      });
    });
  });

  describe("POST /api/webhooks/slack/interactive", () => {
    const path = "/api/webhooks/slack/interactive";
    const body = "not_a_payload=1";

    it("rejects an unsigned request", async () => {
      await expect(
        slackIngressRequest({
          routes: slackInteractiveRoutes,
          path,
          body,
          contentType: FORM_CONTENT_TYPE,
        }),
      ).resolves.toStrictEqual({
        status: 401,
        location: null,
        body: jsonBody({ error: "Missing Slack signature headers" }),
      });
    });
  });
});
