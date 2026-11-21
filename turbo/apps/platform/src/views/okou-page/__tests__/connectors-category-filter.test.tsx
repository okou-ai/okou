import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { googleDriveCatalogItem } from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();

test("connectors-category-filter-001 the open filter orders the whole catalog's positive categories and shows each total", async () => {
  const discovery = context.mocks.deferred<void>();
  context.mocks.api(connectorCatalogContract.discovery, async ({ respond }) => {
    await discovery.promise;
    return respond(200, {
      connectors: [
        {
          ...googleDriveCatalogItem("not-connected"),
          category: "docs-files-knowledge",
        },
      ],
      totalConnectorCount: 55,
      categoryConnectorCounts: {
        "meetings-scheduling": 0,
        "future-category": 3,
        "docs-files-knowledge": 40,
        "communication-collaboration": 12,
      },
    });
  });
  await setupPage({ context, host: "app.okou.ai", path: "/connectors" });
  const filters = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((item) => {
      return item.getAttribute("aria-label") === "Filter connectors";
    });
    expect(button).toBeEnabled();
    return button!;
  });
  click(filters);
  const menu = await screen.findByRole("menu");
  discovery.resolve();
  await waitFor(() => {
    const options = queryAllByRoleFast("menuitem", menu);
    expect(
      options.map((option) => {
        return option.textContent?.trim();
      }),
    ).toStrictEqual([
      "All",
      "Communication12",
      "Documents40",
      "Future Category3",
    ]);
  });
});
