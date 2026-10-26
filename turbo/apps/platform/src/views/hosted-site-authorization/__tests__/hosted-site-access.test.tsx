import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

function action(role: "link" | "button", label: string) {
  const element = queryAllByRoleFast(role).find((node) => {
    return node.textContent?.trim() === label;
  });
  if (!element) {
    throw new Error(`Missing ${role}: ${label}`);
  }
  return element;
}

const context = testContext();
const site = "https://demo.okou.app/report?view=summary";
const path = (reason: string, url = site) => {
  return `/hosted-site-access?${new URLSearchParams({ url, reason })}`;
};
const restart = `https://demo.okou.app/.okou/auth/start?${new URLSearchParams({ returnTo: "/report?view=summary" })}`;

test("signed-out website visitors can sign in without being forced away from the access page", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: path("authenticate"),
    auth: null,
  });
  expect(
    screen.getByRole("heading", { name: "Verify access to this website" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Sign in with an account that can access this website."),
  ).toBeInTheDocument();
  expect(document.title).toBe("Verify access to this website | Okou");
  expect(action("link", "Sign in")).toHaveAttribute("href", restart);
  expect(action("link", "Back to Okou")).toHaveAttribute("href", "/");
});

test("an incomplete authorization can be retried without claiming the signed-in visitor was denied", async () => {
  await setupPage({ context, host: "app.okou.ai", path: path("authenticate") });
  expect(
    screen.getByRole("heading", { name: "Verify access to this website" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Continue to verify access with your current account."),
  ).toBeInTheDocument();
  expect(action("link", "Continue")).toHaveAttribute("href", restart);
  expect(action("button", "Switch account")).toBeEnabled();
});

test("expired website sessions offer a fresh authorization for the original path", async () => {
  await setupPage({ context, host: "app.okou.ai", path: path("expired") });
  expect(
    screen.getByRole("heading", { name: "Verify your access again" }),
  ).toBeInTheDocument();
  expect(document.title).toBe("Verify your access again | Okou");
  expect(action("link", "Continue")).toHaveAttribute("href", restart);
  expect(action("button", "Switch account")).toBeEnabled();
});

test("a denied website uses the artifact recovery actions", async () => {
  await setupPage({ context, host: "app.okou.ai", path: path("denied") });
  expect(
    screen.getByRole("heading", { name: "You can’t view this website" }),
  ).toBeInTheDocument();
  expect(document.title).toBe("You can’t view this website | Okou");
  expect(action("button", "Switch account")).toBeEnabled();
  expect(
    screen.getByText(/Ask the person who shared this link to check access/u),
  ).toBeInTheDocument();
});

test("dependency failures remain visible without claiming an access denial", async () => {
  await setupPage({ context, host: "app.okou.ai", path: path("unavailable") });
  expect(
    screen.getByRole("heading", {
      name: "This website is temporarily unavailable",
    }),
  ).toBeInTheDocument();
  expect(document.title).toBe("This website is temporarily unavailable | Okou");
});

test.each([
  "https://demo.okou.app.attacker.example/report",
  "https://app.okou.ai/",
  String.raw`https://demo.okou.app/\attacker.example/report`,
  `https://pv-${"a".repeat(48)}.okou.app/`,
  "https://demo.okou.app/.okou/auth/callback?code=secret",
])(
  "an invalid authentication target %s cannot become a sign-in destination",
  async (url) => {
    await setupPage({
      context,
      host: "app.okou.ai",
      path: path("expired", url),
      auth: null,
    });
    expect(
      screen.getByRole("heading", { name: "Verify your access again" }),
    ).toBeInTheDocument();
    expect(
      queryAllByRoleFast("link").map((link) => {
        return link.getAttribute("href");
      }),
    ).toStrictEqual(["/", "/"]);
  },
);
