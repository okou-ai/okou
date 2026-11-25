import { hostContract } from "@okouai/api-contracts/contracts/host";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const site = "https://field-notes.okou.app";

async function openNotice(
  reason: string,
  title: string,
  path: string,
  signedOut = false,
  origin = site,
) {
  const query = new URLSearchParams({ reason, url: origin + path });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/hosted-site-access?" + query,
    ...(signedOut ? { auth: null } : {}),
  });
  const card = within(await screen.findByRole("main"));
  await card.findByRole("heading", { name: title });
  return card;
}

const verify = "Verify access to this website";
function authorizationTarget(card: ReturnType<typeof within>, action: string) {
  const link = card.getByText(action, {
    selector: "a[href]",
  }) as HTMLAnchorElement;
  return link.href;
}

test("hosted-site-access-001 offers a signed-out reader the original journal or the Okou home page", async () => {
  const card = await openNotice(
    "authenticate",
    verify,
    "/journals/field?entry=23",
    true,
  );
  expect(
    card.getByText("Sign in with an account that can access this website."),
  ).toBeInTheDocument();
  expect(authorizationTarget(card, "Sign in")).toBe(
    site + "/.okou/auth/start?returnTo=%2Fjournals%2Ffield%3Fentry%3D23",
  );
  expect(screen.getByText("Back to Okou", { selector: "a" })).toHaveAttribute(
    "href",
    "/",
  );
  expect(document.title).toBe(verify + " | Okou");
});

test("hosted-site-access-002 resumes the draft verification with the current account", async () => {
  const card = await openNotice(
    "authenticate",
    verify,
    "/journals/draft?chapter=4",
  );
  expect(
    card.getByText("Continue to verify access with your current account."),
  ).toBeInTheDocument();
  expect(authorizationTarget(card, "Continue")).toBe(
    site + "/.okou/auth/start?returnTo=%2Fjournals%2Fdraft%3Fchapter%3D4",
  );
  expect(
    card.getByText("Switch account", { selector: "button" }),
  ).toBeEnabled();
  expect(card.queryByText("You can’t view this website")).toBeNull();
});

test("hosted-site-access-003 restarts an expired report session with its summary view", async () => {
  const title = "Verify your access again";
  const card = await openNotice("expired", title, "/report?view=summary");
  expect(authorizationTarget(card, "Continue")).toBe(
    site + "/.okou/auth/start?returnTo=%2Freport%3Fview%3Dsummary",
  );
  expect(
    card.getByText("Switch account", { selector: "button" }),
  ).toBeEnabled();
  expect(document.title).toBe(title + " | Okou");
});

test("hosted-site-access-004 gives a denied reader the sharer's guidance and an account choice", async () => {
  const title = "You can’t view this website";
  const card = await openNotice("denied", title, "/journals");
  expect(
    card.getByText("Ask the person who shared this link to check access.", {
      exact: false,
    }),
  ).toBeInTheDocument();
  expect(
    card.getByText("Switch account", { selector: "button" }),
  ).toBeEnabled();
  expect(document.title).toBe(title + " | Okou");
});

test("hosted-site-access-005 describes temporary unavailability in both the notice and browser title", async () => {
  const title = "This website is temporarily unavailable";
  await openNotice("unavailable", title, "/journals");
  expect(document.title).toBe(title + " | Okou");
});

test.each([
  [
    "active",
    "https://journal.example.net",
    "https://journal.example.net/.okou/auth/start?returnTo=%2Fissue%3Fedition%3D7",
  ],
  ["removed", "https://former.example.net", null],
] as const)(
  "The expired %s custom domain offers its resolved destination",
  async (state, origin, expected) => {
    context.mocks.api(
      hostContract.resolveCustomDomain,
      ({ params, respond }) => {
        expect(params.hostname).toBe(new URL(origin).hostname);
        return respond(
          200,
          state === "active"
            ? {
                siteId: "debc91b1-686e-422c-bbaa-3099e9c6a05f",
                publicSlug: "journal",
                revision: "60f39550-ea37-4968-be5f-71897d3702a0",
              }
            : null,
        );
      },
    );
    const card = await openNotice(
      "expired",
      "Verify your access again",
      "/issue?edition=7",
      true,
      origin,
    );
    const signIn = card.queryByText("Sign in", { selector: "a[href]" });
    expect(signIn?.getAttribute("href") ?? null).toBe(expected);
    expect(screen.getByText("Back to Okou", { selector: "a" })).toHaveAttribute(
      "href",
      "/",
    );
    const destinations = queryAllByRoleFast("link").map((link) => {
      return link.getAttribute("href");
    });
    expect(
      destinations.filter((href) => {
        return href !== "/";
      }),
    ).toStrictEqual(expected ? [expected] : []);
  },
);

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
