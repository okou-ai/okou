import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("A cancelled banking-provider return shows failure", async () => {
  await setupPage({
    context,
    path: "/banking/connect/return?reason=cancelled&code=499&customerId=temporary-customer&institutionId=temporary-bank",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", {
      name: "Couldn’t connect Bank account",
    }),
  ).resolves.toBeVisible();
  expect(screen.getByText("Connection failed")).toBeVisible();
  expect(vi.mocked(window.history.replaceState)).toHaveBeenLastCalledWith(
    {},
    "",
    "/banking/connect/return/error",
  );
});

test("A successful banking-provider return confirms the connection", async () => {
  await setupPage({
    context,
    path: "/banking/connect/return?reason=complete&code=200&customerId=temporary-customer&institutionId=temporary-bank",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Bank account connected" }),
  ).resolves.toBeVisible();
  expect(screen.getByText("Connected")).toBeVisible();
  const closeWindow = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Close window";
  });
  expect(closeWindow).toBeEnabled();
  expect(vi.mocked(window.history.replaceState)).toHaveBeenLastCalledWith(
    {},
    "",
    "/banking/connect/return/success",
  );
});
