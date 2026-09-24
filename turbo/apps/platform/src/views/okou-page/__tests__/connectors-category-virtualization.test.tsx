import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

const CATEGORY = "communication-collaboration";
const CATEGORY_SIZE = 300;

function categoryMetadata() {
  return {
    categories: [
      {
        id: CATEGORY,
        label: "Communication and Collaboration",
        menuLabel: "Communication",
        groupId: null,
      },
    ],
    groups: [],
  };
}

function bigCategory() {
  return Array.from({ length: CATEGORY_SIZE }, (_, index) => {
    return publicStatusItem({
      connectorSlug: `mail-${index}` as ConnectorSlug,
      label: `Connector ${String(index).padStart(3, "0")}`,
      category: CATEGORY,
      popularityRank: index,
      connected: false,
    });
  });
}

function renderedLabels(): readonly string[] {
  return screen.getAllByTestId("connector-card-label").map((element) => {
    return element.textContent ?? "";
  });
}

async function openCategory(): Promise<void> {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, bigCategory(), categoryMetadata(), {
    [CATEGORY]: CATEGORY_SIZE,
  });
  await setupPage({
    context,
    path: `/connectors?category=${CATEGORY}`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  await screen.findByTestId("connector-category-grid");
}

test("Mount a screen of a category instead of all of it", async () => {
  await openCategory();

  await waitFor(() => {
    expect(renderedLabels().length).toBeGreaterThan(0);
  });
  // The response carries the whole category; the grid mounts a window of it
  // and reserves the rest as grid rows no card is built for.
  expect(renderedLabels().length).toBeLessThan(CATEGORY_SIZE);
  expect(
    screen.getAllByTestId("connector-category-reserved-rows").length,
  ).toBeGreaterThan(0);
});
