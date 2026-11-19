import { hostContract } from "@okouai/api-contracts/contracts/host";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const site = "https://demo.okou.app";
const siteId = "40000000-0000-4000-8000-000000000100";
const app = "https://app.okou.ai";

function authorizationPath(returnTo?: string) {
  const params = new URLSearchParams({
    siteId,
    origin: site,
    codeChallenge: "c".repeat(43),
    state: "s".repeat(43),
  });
  if (returnTo) {
    params.set("returnTo", returnTo);
  }
  return `/hosted-site-authorize?${params}`;
}

test.each([
  { status: 403, reason: "denied", code: "FORBIDDEN", returnTo: undefined },
  {
    status: 500,
    reason: "unavailable",
    code: "INTERNAL_SERVER_ERROR",
    returnTo: "/report?view=summary",
  },
] as const)(
  "The authorization bridge returns visitors to the website access page when $reason",
  async ({ status, reason, code, returnTo }) => {
    const navigation = context.mocks.browser.locationReplace();
    context.mocks.api(
      hostContract.authorizeSiteSession,
      ({ params, respond }) => {
        expect(params.siteId).toBe(siteId);
        return respond(status, {
          error: { code, message: "Site authorization unavailable" },
        });
      },
    );

    await startPage({
      context,
      path: authorizationPath(returnTo),
      host: "app.okou.ai",
    });

    const expected = new URL("/hosted-site-access", app);
    expected.searchParams.set("url", new URL(returnTo ?? "/", site).href);
    expected.searchParams.set("reason", reason);
    await waitFor(() => {
      expect(navigation.calls).toStrictEqual([expected.href]);
    });
  },
);

test("Organization selection preserves the hosted-site authorization continuation", async () => {
  const path = authorizationPath("/report?view=summary");
  await startPage({
    context,
    path,
    host: "app.okou.ai",
    auth: {
      user: { id: "test-user-123", fullName: "Site Reader" },
      organization: { activeOrg: null, memberships: [] },
    },
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in/tasks/choose-organization");
  });
  expect(new URL(window.location.href).searchParams.get("redirect_url")).toBe(
    new URL(path, app).href,
  );
});
