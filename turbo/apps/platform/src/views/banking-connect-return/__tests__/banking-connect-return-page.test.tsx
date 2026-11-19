import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("A successful bank connection opens its confirmation page", async () => {
  const returnParams = new URLSearchParams({
    reason: "complete",
    code: "200",
    customerId: "test-customer",
    institutionId: "test-institution",
  });
  await setupPage({ context, path: `/banking/connect/return?${returnParams}` });

  expect(
    await screen.findByRole("heading", { name: "Bank account connected" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Connected")).toBeInTheDocument();
  const close = queryAllByRoleFast("button", document.body).find((button) => {
    return button.textContent?.trim() === "Close window";
  });
  expect(close).toBeEnabled();
  expect(window.location.pathname).toBe("/banking/connect/return/success");
});
