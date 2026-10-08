import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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
