import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
test("banking-connect-return-page-002 confirms the bank connection on the clean success URL", async () => {
  const receipt = new URLSearchParams({
    customerId: "customer-903",
    institutionId: "institution-57",
    code: "200",
    reason: "complete",
  });
  await setupPage({ context, path: "/banking/connect/return?" + receipt });
  await screen.findByRole("heading", { name: "Bank account connected" });
  await waitFor(() => {
    return expect(location.pathname + location.search).toBe(
      "/banking/connect/return/success",
    );
  });
  expect(screen.getByText("Connected", { exact: true })).toBeInTheDocument();
  expect(
    screen.getByText("Close window", { selector: "button" }),
  ).toBeEnabled();
});
