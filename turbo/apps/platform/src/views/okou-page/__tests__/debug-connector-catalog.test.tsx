import { screen, within } from "@testing-library/react";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const catalogDigest = `sha256:${"b".repeat(64)}`;

test.each(["3.21.0", null])(
  "shows the accepted catalog identity with version %s in Debug settings",
  async (catalogVersion) => {
    context.mocks.api(connectorCatalogContract.release, ({ respond }) => {
      return respond(200, {
        catalog: { schemaVersion: 4, catalogDigest, catalogVersion },
      });
    });
    await setupPage({
      context,
      path: "/agents?settings=debug",
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });
    const catalog = within(
      await screen.findByRole("region", { name: "Connector catalog" }),
    );
    await expect(
      catalog.findByText(catalogDigest),
    ).resolves.toBeInTheDocument();
    expect(
      catalog.getByText(catalogVersion ?? "Unavailable"),
    ).toBeInTheDocument();
    expect(catalog.getByText("4")).toBeInTheDocument();
  },
);
