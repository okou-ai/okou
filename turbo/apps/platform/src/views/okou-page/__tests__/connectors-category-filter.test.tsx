import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockSavedConnectorAccounts,
  publicStatusItem,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("Offer every whole-catalog category id, named from the id alone", async () => {
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    return respond(200, {
      connectors: [
        publicStatusItem({
          connectorSlug: "slack" as ConnectorSlug,
          label: "Slack",
          category: "communication-collaboration",
        }),
      ],
      totalConnectorCount: 55,
      categoryConnectorCounts: {
        "communication-collaboration": 12,
        "docs-files-knowledge": 40,
        "meetings-scheduling": 0,
        "future-category": 3,
      },
    });
  });
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  await setupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(queryConnectorCard("Slack")).toBeInTheDocument();
  });

  click(getConnectorAction("button", "Filter connectors"));

  await waitFor(() => {
    expect(
      queryAllByRoleFast("menuitem").map((option) => {
        return option.textContent;
      }),
    ).toStrictEqual([
      "All",
      "Communication12",
      "Documents40",
      "Future Category3",
    ]);
  });
  expect(
    queryAllByRoleFast("menuitem").filter((option) => {
      return option.textContent?.startsWith("Meetings");
    }),
  ).toStrictEqual([]);
});
