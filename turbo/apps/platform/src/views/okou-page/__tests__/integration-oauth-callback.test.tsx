import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { teamsOauthContract } from "@okouai/api-contracts/contracts/teams-oauth";
import { githubOauthContract } from "@okouai/api-contracts/contracts/github-oauth";
import { INTEGRATION_OAUTH_CALLBACK_PATHS } from "@okouai/core/integration-routes";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each(["slack", "teams", "github"] as const)(
  "%s callback signs in before submitting provider credentials",
  async (integration) => {
    const path = `${INTEGRATION_OAUTH_CALLBACK_PATHS[integration]}?integration=${integration}&state=private-state&code=private-code`;
    await startPage({ context, host: "app.okou.ai", path, auth: null });
    await waitFor(() => {
      return expect(window.location.pathname).toBe("/sign-in");
    });
    const params = new URLSearchParams(window.location.hash.split("?")[1]);
    expect(params.get("redirect_url")).toBe(`https://app.okou.ai${path}`);
  },
);

test.each(["slack", "teams", "github"] as const)(
  "%s callback completes with the active session and follows the API continuation",
  async (integration) => {
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const redirectUrl =
      integration === "github"
        ? "https://github.com/login/oauth/authorize?state=continuation"
        : `https://app.okou.ai/settings/${integration}?status=connected`;
    const handler = async (
      query: { code?: string; state?: string; responseMode?: "json" },
      authorization: string | null,
    ) => {
      expect(query).toMatchObject({
        code: "private-code",
        state: "private-state",
        responseMode: "json",
      });
      expect(authorization).toMatch(/^Bearer /u);
      started.resolve(undefined);
      await release.promise;
      return { redirectUrl };
    };
    if (integration === "slack") {
      context.mocks.api(
        slackOauthContract.callback,
        async ({ query, request, respond }) => {
          return respond(
            200,
            await handler(query, request.headers.get("authorization")),
          );
        },
      );
    } else if (integration === "teams") {
      context.mocks.api(
        teamsOauthContract.callback,
        async ({ query, request, respond }) => {
          return respond(
            200,
            await handler(query, request.headers.get("authorization")),
          );
        },
      );
    } else {
      context.mocks.api(
        githubOauthContract.setupCallback,
        async ({ query, request, respond }) => {
          return respond(
            200,
            await handler(query, request.headers.get("authorization")),
          );
        },
      );
    }
    const page = await startPage({
      context,
      host: "app.okou.ai",
      path: `${INTEGRATION_OAUTH_CALLBACK_PATHS[integration]}?integration=${integration}&state=private-state&code=private-code`,
    });
    await started.promise;
    await expect(
      screen.findByText("Finishing the secure connection"),
    ).resolves.toBeInTheDocument();
    release.resolve(undefined);
    await page.ready;
    await waitFor(() => {
      return expect(window.location.href).toBe(redirectUrl);
    });
  },
);
