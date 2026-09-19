import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const MOBILE_WARNING =
  "The GitHub app may not support this OAuth link. Please complete this connection in the Okou web app on a computer.";
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function getBackLink(): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Back to Okou";
  });
  if (!link) {
    throw new Error("Expected a Back to Okou link");
  }
  return link;
}

test("The connector redirect page explains the secure provider handoff", async () => {
  await setupPage({
    context,
    path: "/connectors/github/redirecting?label=GitHub",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to GitHub…" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("You’ll continue on GitHub to authorize Okou."),
  ).toBeInTheDocument();
  expect(screen.getByText("Preparing a secure connection")).toBeInTheDocument();
  expect(
    screen.getByLabelText("Connector icon unavailable"),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Mercury banking disclosure")).toBeNull();
  expect(getBackLink()).toHaveAttribute("href", "/");
});

test("The Mercury redirect page shows its required disclosure", async () => {
  await setupPage({
    context,
    path: "/connectors/mercury/redirecting?label=Mercury",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to Mercury…" }),
  ).resolves.toBeInTheDocument();
  const disclosure = screen.getByLabelText("Mercury banking disclosure");
  expect(
    screen.getByText(
      "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
    ),
  ).toBeInTheDocument();
  const attribution = queryAllByRoleFast("link", disclosure).find((link) => {
    return link.textContent?.trim() === "Powered by Mercury";
  });
  expect(attribution).toHaveAttribute("href", "https://mercury.com");
});

test("A stalled mobile provider handoff shows guidance", async () => {
  context.mocks.browser.userAgent(IPHONE_USER_AGENT);

  await setupPage({
    context,
    path: "/connectors/github/redirecting?label=GitHub",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to GitHub…" }),
  ).resolves.toBeInTheDocument();
  await expect(screen.findByText(MOBILE_WARNING)).resolves.toBeInTheDocument();
});

test("An unsafe route icon is not loaded", async () => {
  await setupPage({
    context,
    path: "/connectors/server-only/redirecting?label=Server+Only&iconUrl=http%3A%2F%2Ficons.example.test%2Fserver-only.svg&iconInvertInDarkMode=true",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to Server Only…" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByLabelText("Connector icon unavailable"),
  ).toBeInTheDocument();
  expect(
    document.querySelector(
      'img[src="http://icons.example.test/server-only.svg"]',
    ),
  ).toBeNull();
});

test("A failed provider handoff offers a return path", async () => {
  await setupPage({
    context,
    path: "/connectors/github/redirecting?label=GitHub&status=error",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Couldn’t open GitHub" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Return to Okou and try connecting again."),
  ).toBeInTheDocument();
  expect(getBackLink()).toHaveAttribute("href", "/");
});
