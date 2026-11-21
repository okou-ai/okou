import { test, expect } from "vitest";
import { waitFor, screen } from "@testing-library/react";
import { slackOauthCallbackContract } from "@okouai/api-contracts/contracts/slack-oauth-callback";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

test.each([
  ["integration-oauth-callback-001", "slack", "slack"],
  ["integration-oauth-callback-002", "microsoft-365", "teams"],
] as const)(
  "%s returns the full provider continuation to sign-in",
  async (_id, slug, integration) => {
    const path =
      "/connectors/" +
      slug +
      "/callback?integration=" +
      integration +
      "&state=workspace%2Bnorth&code=office-19";
    await startPage({ context, auth: null, path, host: "app.okou.ai" });
    await waitFor(() => {
      return expect(location.pathname).toBe("/sign-in");
    });
    expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
      new URL(path, "https://app.okou.ai").href,
    );
  },
);

test("integration-oauth-callback-004 the signed-in Slack callback completes the secure handoff to settings", async () => {
  const release = createDeferredPromise<void>(context.signal);
  const browser = context.mocks.browser.locationAssign();
  const destination = new URL(
    "/settings/slack?connected=marina",
    "https://app.okou.ai",
  ).href;
  context.mocks.api(
    slackOauthCallbackContract.callback,
    async ({ query, request, respond }) => {
      expect(request.headers.get("Authorization")).toBe(
        "Bearer marina-session",
      );
      expect(query).toMatchObject({
        state: "marina-state",
        code: "ticket-52",
        responseMode: "json",
      });
      await release.promise;
      return respond(200, { redirectUrl: destination });
    },
  );
  const page = await startPage({
    context,
    path: "/connectors/slack/callback?integration=slack&code=ticket-52&state=marina-state",
    auth: {
      user: { id: "member-marina", fullName: "Marina Reed" },
      session: { token: "marina-session" },
    },
  });
  await expect(
    screen.findByText("Finishing the secure connection"),
  ).resolves.toBeInTheDocument();
  release.resolve();
  await waitFor(() => {
    return expect(browser.calls).toContain(destination);
  });
  await page.ready;
});
