import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import {
  createComposerConnectorHelpers,
  builtinConnector,
  httpConnector,
  manualAuthMethod,
  SCOUT_THREAD_ID,
  FEISHU_CONNECTOR_ID,
  ACME_CONNECTOR_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const managed = () => {
  return httpConnector({
    id: FEISHU_CONNECTOR_ID,
    slug: "_feishu",
    displayName: "Feishu",
    authMode: "oauth",
    providerAdapter: "feishu",
    hasAccount: false,
  });
};
const acme = () => {
  return httpConnector({
    id: ACME_CONNECTOR_ID,
    slug: "_acme-search",
    displayName: "Acme Search",
    hasAccount: false,
  });
};
const gateway = createComposerConnectorHelpers(context);
async function menu(
  options: Parameters<typeof gateway.installComposerConnectorFixture>[0],
) {
  const fixture = gateway.installComposerConnectorFixture({
    ...options,
    threadId: SCOUT_THREAD_ID,
  });
  await setupPage({ context, path: "/chats/" + SCOUT_THREAD_ID });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  return { fixture, trigger };
}
async function directory() {
  click(await findFastControl("button", "Add connectors"));
  const filter = await screen.findByPlaceholderText("Find connectors...");
  const dialog = filter.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Missing directory dialog");
  }
  return dialog;
}
test("chat-composer-connectors-013 Searching beyond featured GitHub opens one manual Axiom setup", async () => {
  const featured = ["github", "calendar", "notes", "releases"];
  const catalog = featured.map((slug, i) => {
    return builtinConnector({
      slug,
      label: i === 0 ? "GitHub" : slug,
      hasAccount: false,
      popularityRank: i + 1,
    });
  });
  await menu({
    catalog: [
      ...catalog,
      builtinConnector({
        slug: "axiom",
        label: "Axiom",
        hasAccount: false,
        authMethods: [manualAuthMethod()],
      }),
    ],
    featuredConnectorSlugs: featured,
    categoryConnectorCounts: { productivity: 5 },
  });
  const browser = await directory();
  await within(browser).findByText("GitHub");
  expect(within(browser).queryByText("Axiom")).toBeNull();
  await fill(
    within(browser).getByPlaceholderText("Find connectors..."),
    "Axiom",
  );
  click(await findFastControl("button", "Connect Axiom", browser));
  const setup = await screen.findByRole("dialog", { name: /Axiom/i });
  await within(setup).findByText("API Token", { selector: "label" });
  expect(
    within(setup).getByText("API Token", { selector: "label" }),
  ).toBeVisible();
  expect(setup.querySelector('input[type="password"]')).toBeVisible();
  expect(screen.getAllByRole("dialog", { name: /Axiom/i })).toStrictEqual([
    setup,
  ]);
});
test("chat-composer-connectors-015 The custom directory offers Acme Search and excludes the integration-managed Feishu connection", async () => {
  await menu({ customConnectors: [managed(), acme()] });
  const browser = await directory();
  click(await findFastControl("radio", "Custom", browser));
  await expect(
    findFastControl("button", "Connect Acme Search", browser),
  ).resolves.toBeEnabled();
  expect(within(browser).queryByText("Feishu", { exact: true })).toBeNull();
  expect(queryFastControl("button", "Connect Feishu", browser)).toBeNull();
});
