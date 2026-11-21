import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
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

test("connector-callbacks-005 a refreshed Link receipt identifies the wallet while services are pending", async () => {
  context.mocks.api(connectorCatalogContract.get, ({ never }) => {
    return never();
  });
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ never }) => {
      return never();
    },
  );
  const page = await startPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: "/connectors/link/callback/success",
  });
  await page.content;
  await screen.findByRole("heading", { name: "Link connected" });
  expect(screen.getByRole("img", { name: "Link" })).toBeInTheDocument();
});

test("connector-callbacks-008 a denied Notion callback replaces the provider query with a recoverable error", async () => {
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ params, query, respond }) => {
      return respond(200, {
        status: "error",
        message:
          params.connectorSlug === "notion" && query.error === "access_denied"
            ? "Provider denied access."
            : "Unknown response",
      });
    },
  );
  await setupPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: "/connectors/notion/callback?error=access_denied&state=notion-reply",
  });
  await screen.findByRole("heading", { name: "Couldn’t connect NOTION" });
  expect(
    screen.getByText(
      "Provider denied access. Close this window and try again.",
    ),
  ).toBeInTheDocument();
  const result = new URL(window.location.href);
  expect(result.pathname).toBe("/connectors/notion/callback/error");
  expect(result.searchParams.has("error")).toBeFalsy();
  expect(result.searchParams.has("state")).toBeFalsy();
});
