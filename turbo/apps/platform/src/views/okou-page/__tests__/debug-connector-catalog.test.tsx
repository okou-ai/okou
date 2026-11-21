import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
test("debug-connector-catalog-001 the debug catalog identifies its release and schema", async () => {
  const digest = "sha256:" + "b".repeat(64);
  context.mocks.api(connectorCatalogContract.release, ({ respond }) => {
    return respond(200, {
      catalog: {
        catalogVersion: "3.21.0",
        schemaVersion: 4,
        catalogDigest: digest,
      },
    });
  });
  await setupPage({
    context,
    path: "/?settings=preference",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const nav = within(dialog).getByRole("navigation");
  click(
    queryAllByRoleFast("button", nav).find((el) => {
      return el.textContent?.trim() === "Debug";
    })!,
  );
  const catalog = within(
    await screen.findByRole("region", { name: "Connector catalog" }),
  );
  await catalog.findByText(digest, { selector: "dd" });
  for (const [label, value] of [
    ["Version", "3.21.0"],
    ["Catalog hash", digest],
    ["Schema version", "4"],
  ] as const) {
    expect(
      catalog.getByText(label, { selector: "dt" }).nextElementSibling
        ?.textContent,
    ).toBe(value);
  }
});
