import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function control(role: "button" | "link", name: string): HTMLElement {
  const found = queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Expected the ${name} ${role}`);
  }
  return found;
}

test("The error page retains support and theme controls (dark: false)", async () => {
  await setupPage({ context, path: "/_/error", auth: null });
  const alert = await screen.findByRole("alert");
  const theme = control("button", "Toggle theme");
  expect(theme).toHaveAttribute("aria-pressed", "false");

  click(theme);

  await waitFor(() => {
    expect(theme).toHaveAttribute("aria-pressed", "true");
  });
  expect(alert).toHaveTextContent("We're here to help");
  expect(alert).toHaveTextContent("Give it another try or reach out");
  expect(
    queryAllByRoleFast("link", alert).map((link) => {
      return [link.textContent?.trim(), link.getAttribute("href")];
    }),
  ).toStrictEqual([["support", "mailto:contact@okou.ai"]]);
  expect(control("link", "Go to Okou home")).toHaveAttribute("href", "/");
});
