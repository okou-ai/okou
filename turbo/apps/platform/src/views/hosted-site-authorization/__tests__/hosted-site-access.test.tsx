import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const report = "https://review.okou.app/report?view=summary";

function accessPath(reason: string) {
  const params = new URLSearchParams({ reason, url: report });
  return `/hosted-site-access?${params}`;
}

function link(label: string) {
  const match = queryAllByRoleFast("link", document.body).find((item) => {
    return item.textContent?.trim() === label;
  });
  if (!(match instanceof HTMLAnchorElement)) {
    throw new Error(`Missing ${label} link`);
  }
  return match;
}

function expectAuthorizationLink(label: string) {
  const url = new URL(link(label).href);
  expect(url.origin).toBe("https://review.okou.app");
  expect(url.pathname).toBe("/.okou/auth/start");
  expect(url.searchParams.get("returnTo")).toBe("/report?view=summary");
}

function expectSwitchAccount() {
  const action = queryAllByRoleFast("button", document.body).find((button) => {
    return button.textContent?.trim() === "Switch account";
  });
  expect(action).toBeEnabled();
}

test("A signed-out visitor can sign in to view the requested website", async () => {
  await setupPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: accessPath("authenticate"),
  });

  const title = "Verify access to this website";
  await expect(
    screen.findByRole("heading", { name: title }),
  ).resolves.toBeInTheDocument();
  expect(document.title).toBe(`${title} | Okou`);
  expect(
    screen.getByText("Sign in with an account that can access this website."),
  ).toBeInTheDocument();
  expectAuthorizationLink("Sign in");
  expect(link("Back to Okou")).toHaveAttribute("href", "/");
});

test("A signed-in visitor can continue incomplete verification", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: accessPath("authenticate"),
  });

  await expect(
    screen.findByRole("heading", {
      name: "Verify access to this website",
    }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Continue to verify access with your current account."),
  ).toBeInTheDocument();
  expectAuthorizationLink("Continue");
  expectSwitchAccount();
  expect(
    screen.queryByRole("heading", { name: "You can’t view this website" }),
  ).not.toBeInTheDocument();
});

test("An expired session can restart verification for the original website path", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: accessPath("expired"),
  });

  const title = "Verify your access again";
  await expect(
    screen.findByRole("heading", { name: title }),
  ).resolves.toBeInTheDocument();
  expect(document.title).toBe(`${title} | Okou`);
  expectAuthorizationLink("Continue");
  expectSwitchAccount();
});

test("A visitor denied access can switch accounts or ask the sharer for access", async () => {
  await setupPage({ context, host: "app.okou.ai", path: accessPath("denied") });

  const title = "You can’t view this website";
  await expect(
    screen.findByRole("heading", { name: title }),
  ).resolves.toBeInTheDocument();
  expect(document.title).toBe(`${title} | Okou`);
  expect(
    screen.getByText(/Ask the person who shared this link to check access\./u),
  ).toBeInTheDocument();
  expectSwitchAccount();
});

test("An unavailable website explains that the failure is temporary", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: accessPath("unavailable"),
  });

  const title = "This website is temporarily unavailable";
  await expect(
    screen.findByRole("heading", { name: title }),
  ).resolves.toBeInTheDocument();
  expect(document.title).toBe(`${title} | Okou`);
});
