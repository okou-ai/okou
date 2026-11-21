import { hostContract } from "@okouai/api-contracts/contracts/host";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
// The bridge leaves this document before rendering a page; the browser destination is its completion signal.
function verificationPath(origin: string, returnTo?: string) {
  const query = new URLSearchParams({
    state: "s".repeat(43),
    origin,
    siteId: "9d8fc853-d2b7-489c-b63e-6edb41c52029",
    codeChallenge: "p".repeat(43),
  });
  if (returnTo) {
    query.set("returnTo", returnTo);
  }
  return "/hosted-site-authorize?" + query;
}

test.each([
  {
    id: "002",
    status: 403,
    reason: "denied",
    site: "https://reports.okou.app",
    returnTo: undefined,
  },
  {
    id: "004",
    status: 500,
    reason: "unavailable",
    site: "https://demo.okou.app",
    returnTo: "/report?view=summary",
  },
] as const)(
  "hosted-site-authorization-$id redirects the $status response to the website recovery destination",
  async ({ status, reason, site, returnTo }) => {
    context.mocks.api(hostContract.authorizeSiteSession, ({ respond }) => {
      return respond(status, {
        error: {
          code: status === 403 ? "FORBIDDEN" : "INTERNAL_SERVER_ERROR",
          message: "Site session could not be issued",
        },
      });
    });
    await startPage({
      context,
      host: "app.okou.ai",
      path: verificationPath(site, returnTo),
    });
    await waitFor(() => {
      return expect(location.pathname).toBe("/hosted-site-access");
    });
    const recovery = new URL(location.href);
    expect(recovery.origin + recovery.pathname).toBe(
      "https://app.okou.ai/hosted-site-access",
    );
    expect(Object.fromEntries(recovery.searchParams)).toStrictEqual({
      reason,
      url: site + (returnTo ?? "/"),
    });
  },
);

test("hosted-site-authorization-006 carries the complete pending verification through organization selection", async () => {
  const bridge = verificationPath(
    "https://archive.okou.app",
    "/notes?edition=2&section=index",
  );
  await startPage({
    context,
    host: "app.okou.ai",
    path: bridge,
    auth: {
      user: { id: "archive-reviewer", fullName: "Archive Reviewer" },
      organization: { activeOrg: null, memberships: [] },
    },
  });
  await waitFor(() => {
    return expect(location.pathname).toBe("/sign-in/tasks/choose-organization");
  });
  const choice = new URL(location.href);
  expect(choice.origin + choice.pathname).toBe(
    "https://app.okou.ai/sign-in/tasks/choose-organization",
  );
  expect(choice.searchParams.get("redirect_url")).toBe(
    "https://app.okou.ai" + bridge,
  );
});
