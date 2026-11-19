import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function catalogValue(catalog: HTMLElement, term: string): HTMLElement {
  const value = within(catalog).getByText(term).nextElementSibling;
  if (!(value instanceof HTMLElement)) {
    throw new Error(`Expected a value for ${term}`);
  }
  return value;
}

test("shows the accepted catalog identity with version 3.21.0 in Debug settings", async () => {
  const catalogDigest = `sha256:${"b".repeat(64)}`;
  context.mocks.api(connectorCatalogContract.release, ({ respond }) => {
    return respond(200, {
      catalog: { schemaVersion: 4, catalogDigest, catalogVersion: "3.21.0" },
    });
  });

  await setupPage({
    context,
    path: "/agents?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const catalog = await screen.findByRole("region", {
    name: "Connector catalog",
  });
  await expect(
    within(catalog).findByText(catalogDigest),
  ).resolves.toBeInTheDocument();
  expect(catalogValue(catalog, "Catalog hash")).toHaveTextContent(
    catalogDigest,
  );
  expect(catalogValue(catalog, "Version")).toHaveTextContent("3.21.0");
  expect(catalogValue(catalog, "Schema version")).toHaveTextContent("4");
});
