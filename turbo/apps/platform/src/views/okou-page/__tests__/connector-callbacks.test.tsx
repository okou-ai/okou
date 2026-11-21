import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserAuthMethod,
  catalogConnector,
} from "./chat-capability-connector-test-helpers.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";

const context = testContext();

test("connector-callbacks-007 a completed Mercury connection identifies its banking providers", async () => {
  const connector = catalogConnector({
    slug: "mercury",
    label: "Mercury",
    method: browserAuthMethod(),
  });
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector });
  });
  await setupPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: "/connectors/mercury/callback/success?username=cargo-finance",
  });
  await screen.findByRole("heading", { name: "Mercury connected" });
  const disclosure = await screen.findByRole("region", {
    name: "Mercury banking disclosure",
  });
  await expect(
    findNamedLink("Powered by Mercury", disclosure),
  ).resolves.toHaveAttribute("href", "https://mercury.com");
  expect(disclosure).toHaveTextContent(
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
  );
});
