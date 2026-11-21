import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const site = "https://field-notes.okou.app";

async function openNotice(
  reason: string,
  title: string,
  path: string,
  signedOut = false,
) {
  const query = new URLSearchParams({ reason, url: site + path });
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
