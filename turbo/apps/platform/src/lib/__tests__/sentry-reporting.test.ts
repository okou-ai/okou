import { expect, test } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";

import { initSentry } from "../sentry.ts";

const context = testContext();

test.each([
  "/connectors/slack/callback",
  "/connectors/microsoft-365/callback",
  "/connectors/github/callback",
  "/api/integrations/teams/oauth/callback",
  "/api/github/app/setup/callback",
])(
  "redacts OAuth callback credentials before Sentry reporting (%s)",
  async (path) => {
    const sentry = context.mocks.sentry();
    initSentry();
    const options = sentry.initializations.at(-1)?.options;
    if (!options?.beforeSend || !options.beforeBreadcrumb) {
      throw new Error("Expected Sentry privacy hooks");
    }
    const query = "?code=private-code&state=private-state&integration=slack";
    const absolute = `https://app.okou.ai${path}${query}`;
    const event = await options.beforeSend(
      { type: undefined, request: { url: absolute } },
      {},
    );
    const breadcrumb = options.beforeBreadcrumb(
      {
        category: "navigation",
        data: { from: path + query, to: absolute, status_code: 200 },
      },
      {},
    );
    const signIn = new URL("https://app.okou.ai/sign-in");
    signIn.searchParams.set("redirect_url", absolute);
    const authEvent = await options.beforeSend(
      {
        type: undefined,
        request: {
          url: signIn.toString(),
          headers: { Referer: absolute, "User-Agent": "test-agent" },
        },
      },
      {},
    );
    for (const value of [event, breadcrumb, authEvent]) {
      expect(JSON.stringify(value)).not.toContain("private-code");
      expect(JSON.stringify(value)).not.toContain("private-state");
    }
    expect(breadcrumb?.data?.status_code).toBe(200);
    expect(authEvent?.request?.headers?.["User-Agent"]).toBe("test-agent");
  },
);
