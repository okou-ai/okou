import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";

const context = testContext();

test("The Mercury redirect page shows its required disclosure", async () => {
  await setupPage({
    context,
    auth: null,
    path: "/connectors/mercury/redirecting?label=Mercury",
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to Mercury…" }),
  ).resolves.toBeInTheDocument();
  const disclosure = screen.getByRole("region", {
    name: "Mercury banking disclosure",
  });
  expect(
    within(disclosure).getByText(
      "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
    ),
  ).toBeInTheDocument();
  expect(
    getConnectorAction("link", "Powered by Mercury", disclosure),
  ).toHaveAttribute("href", "https://mercury.com");
});
