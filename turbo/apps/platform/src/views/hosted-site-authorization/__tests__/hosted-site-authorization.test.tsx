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

test.each(["https://archive.okou.app", "https://journal.example.net"])(
  "An invited website viewer without an organization reaches the signed callback at %s",
  async (origin) => {
    const path = verificationPath(origin, "/annual-report");
    const callback = new URL("/.okou/auth/callback", origin);
    callback.searchParams.set("code", "d".repeat(64));
    callback.searchParams.set(
      "state",
      new URL(path, origin).searchParams.get("state")!,
    );
    context.mocks.api(
      hostContract.authorizeSiteSession,
      ({ params, body, respond }) => {
        expect(params.siteId).toBe("9d8fc853-d2b7-489c-b63e-6edb41c52029");
        expect(body).toStrictEqual({
          origin,
          state: "s".repeat(43),
          codeChallenge: "p".repeat(43),
        });
        return respond(200, { callbackUrl: callback.href });
      },
    );
    await startPage({
      context,
      host: "app.okou.ai",
      path,
      auth: {
        user: { id: "invited-reader", fullName: "Invited Reader" },
        organization: { activeOrg: null, memberships: [] },
      },
    });
    await waitFor(() => {
      expect(location.href).toBe(callback.href);
    });
  },
);

test("A custom-domain grant denial keeps the original path for recovery", async () => {
  const site = "https://journal.example.net";
  context.mocks.api(hostContract.authorizeSiteSession, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "This invitation has expired" },
    });
  });
  await startPage({
    context,
    host: "app.okou.ai",
    path: verificationPath(site, "/issue?edition=7"),
  });
  await waitFor(() => {
    const dest = new URL(location.href);
    expect(dest.pathname).toBe("/hosted-site-access");
    expect(Object.fromEntries(dest.searchParams)).toStrictEqual({
      url: site + "/issue?edition=7",
      reason: "denied",
    });
  });
});
