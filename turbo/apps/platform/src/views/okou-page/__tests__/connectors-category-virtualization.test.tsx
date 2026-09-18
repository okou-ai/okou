import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

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
const COLUMNS = 3;
const ROW_PITCH = 102 + 12;

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

/**
 * The grid resolves its own column count and its offset from the viewport, so
 * the test supplies both the way a browser would: a resolved grid template and
 * a rect that reports how far the grid has scrolled past the viewport's top.
 */
function layoutGrid(scrolledPast: number): void {
  const grid = screen.getByTestId("connector-category-grid");
  grid.style.gridTemplateColumns = "280px 280px 280px";
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top =
        this.dataset.testid === "connector-category-grid" ? -scrolledPast : 0;
      return { ...new DOMRect(0, top, 900, 0), top, toJSON: () => {} };
    },
  );
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

test("Follow the scroll through a category and release the rows behind it", async () => {
  await openCategory();
  await waitFor(() => {
    expect(renderedLabels().length).toBeGreaterThan(0);
  });

  vi.spyOn(window, "innerHeight", "get").mockReturnValue(4 * ROW_PITCH);
  layoutGrid(0);
  fireEvent(window, new Event("resize"));

  await waitFor(() => {
    expect(renderedLabels()[0]).toBe("Connector 000");
  });
  const firstScreen = renderedLabels();
  // Four rows of three, plus two rows of overscan below.
  expect(firstScreen).toHaveLength(6 * COLUMNS);

  layoutGrid(20 * ROW_PITCH);
  fireEvent(
    screen.getByTestId("connectors-scroll-viewport"),
    new Event("scroll"),
  );

  await waitFor(() => {
    // Row 20 minus two rows of overscan is the first row still mounted.
    expect(renderedLabels()[0]).toBe("Connector 054");
  });
  expect(renderedLabels()).toHaveLength(8 * COLUMNS);
  expect(renderedLabels()).not.toContain("Connector 000");
});
