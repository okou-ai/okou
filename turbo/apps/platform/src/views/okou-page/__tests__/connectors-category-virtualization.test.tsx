import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockPublicConnectorStatus,
  mockSavedConnectorAccounts,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

const CATEGORY = "communication-collaboration";
const CATEGORY_SIZE = 300;

test("Mount a screen of a category instead of all of it", async () => {
  const connectors = Array.from({ length: CATEGORY_SIZE }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return publicStatusItem({
      connectorSlug: `chat-app-${number}` as ConnectorSlug,
      label: `Chat app ${number}`,
      category: CATEGORY,
    });
  });
  mockPublicConnectorStatus(context, connectors, {
    [CATEGORY]: CATEGORY_SIZE,
  });
  mockSavedConnectorAccounts(context, () => {
    return [];
  });

  await setupPage({ context, path: `/connectors?category=${CATEGORY}` });

  const grid = await screen.findByTestId("connector-category-grid");
  await waitFor(() => {
    expect(
      within(grid).getAllByTestId("connector-card-label").length,
    ).toBeGreaterThan(0);
  });
  const mounted = within(grid).getAllByTestId("connector-card-label");
  expect(mounted.length).toBeLessThan(CATEGORY_SIZE);
  expect(mounted[0]).toHaveTextContent("Chat app 001");
  expect(
    within(grid).getAllByTestId("connector-category-reserved-rows").length,
  ).toBeGreaterThan(0);
});
