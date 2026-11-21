import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";
const context = testContext();
test("connectors-category-virtualization-001 the open category reserves space for its unmounted services", async () => {
  const category = "communication-collaboration";
  const services = Array.from({ length: 300 }, (_, i) => {
    return publicStatusItem({
      connectorSlug: "service-" + i,
      label: "Messaging service " + i,
      category,
    });
  });
  mockPublicConnectorStatus(context, services, { [category]: 300 });
  await setupPage({ context, path: "/connectors?category=" + category });
  const grid = await screen.findByTestId("connector-category-grid");
  const mounted = within(grid).getAllByText(/^Messaging service \d+$/);
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThan(300);
  const reserved = within(grid).getAllByTestId(
    "connector-category-reserved-rows",
  );
  expect(
    reserved.some((row) => {
      return /^span [1-9]\d*$/.test(row.style.gridRow);
    }),
  ).toBeTruthy();
});
