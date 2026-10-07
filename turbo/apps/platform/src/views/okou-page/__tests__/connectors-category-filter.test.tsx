import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("Offer every whole-catalog category id, named from the id alone", async () => {
  const user = userEvent.setup({ delay: null });
  mockConnectors(context, []);
  // The response carries no category metadata: the whole-catalog counts
  // decide which category ids exist, and each is named from its id.
  mockPublicConnectorStatus(
    context,
    [
      publicStatusItem({
        connectorSlug: "gmail" as ConnectorSlug,
        label: "Gmail",
        category: "communication-collaboration",
        connected: false,
      }),
      publicStatusItem({
        connectorSlug: "notion" as ConnectorSlug,
        label: "Notion",
        category: "docs-files-knowledge",
        connected: false,
      }),
    ],
    undefined,
    {
      "docs-files-knowledge": 40,
      "communication-collaboration": 12,
      "meetings-scheduling": 0,
      "future-category": 3,
    },
  );
  await setupPage({ context, path: "/connectors" });

  const trigger = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label") === "Filter connectors";
    });
    expect(button).toBeDefined();
    return button as HTMLElement;
  });
  await user.click(trigger);

  const items = await waitFor(() => {
    const menuItems = queryAllByRoleFast("menuitem");
    expect(menuItems.length).toBeGreaterThan(0);
    return menuItems.map((item) => {
      return item.textContent;
    });
  });
  // Ordered by name with whole-catalog totals; an id without localized copy
  // keeps a derived name and an empty category is not offered.
  expect(items).toStrictEqual([
    "All",
    "Communication12",
    "Documents40",
    "Future Category3",
  ]);
});
