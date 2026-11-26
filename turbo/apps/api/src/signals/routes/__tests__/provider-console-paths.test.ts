import { randomUUID } from "node:crypto";
import { slackCommandsContract } from "@okouai/api-contracts/contracts/slack-commands";
import { teamsOauthCallbackContract } from "@okouai/api-contracts/contracts/teams-oauth-callback";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { slackCommandsRoutes } from "../slack-commands";
import { teamsOauthRoutes } from "../teams-oauth";

const context = testContext();

describe("provider console paths", () => {
  it("provider-console-paths-001 redirects a denied Teams authorization back to Teams settings", async () => {
    mockEnv("APP_URL", "https://app.okou.test");
    mockEnv("MICROSOFT_OAUTH_CLIENT_ID", `client-${randomUUID()}`);
    mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", randomUUID());
    const api = setupApp({ context, routes: teamsOauthRoutes })(
      teamsOauthCallbackContract,
    );

    const response = await accept(
      api.callback({ query: { error: "access_denied" } }),
      [307],
    );

    const body: unknown = response.body;
    if (!(body instanceof Blob)) {
      throw new Error("Expected the redirect to carry an empty body");
    }
    expect(body.size).toBe(0);
    expect(response.headers.get("location")).toBe(
      "https://app.okou.test/settings/teams?error=access_denied",
    );
  });

  it("provider-console-paths-003 rejects an unsigned Slack slash command", async () => {
    mockOptionalEnv("SLACK_SIGNING_SECRET", randomUUID());
    const api = setupApp({ context, routes: slackCommandsRoutes })(
      slackCommandsContract,
    );
    const form = new URLSearchParams({
      command: "/okou",
      text: "help",
      team_id: `T${randomUUID()}`,
      channel_id: `C${randomUUID()}`,
      user_id: `U${randomUUID()}`,
      trigger_id: randomUUID(),
    });

    const response = await accept(
      api.post({
        body: form.toString(),
        extraHeaders: {
          "content-type": "application/x-www-form-urlencoded",
        },
      }),
      [401],
    );

    expect(response.headers.get("location")).toBeNull();
    expect(response.body).toStrictEqual({
      error: "Missing Slack signature headers",
    });
  });
});
