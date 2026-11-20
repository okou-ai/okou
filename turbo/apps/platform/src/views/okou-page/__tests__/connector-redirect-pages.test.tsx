import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
test("connector-redirect-pages-001 identifies Mercury and its partner banks to signed-out visitors", async () => {
  await setupPage({
    context,
    auth: null,
    path: "/connectors/mercury/redirecting?label=Mercury",
  });
  const disclosure = await screen.findByRole("region", {
    name: "Mercury banking disclosure",
  });
  expect(disclosure).toHaveTextContent(
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
  );
  const provider = within(disclosure).getByText("Powered by Mercury", {
    selector: "a[href]",
  });
  expect(provider).toHaveAttribute("href", "https://mercury.com");
  expect(
    screen.getByRole("heading", { name: "Redirecting to Mercury…" }),
  ).toBeInTheDocument();
});
