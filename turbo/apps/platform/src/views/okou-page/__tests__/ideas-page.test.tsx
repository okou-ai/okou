import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();

const standup =
  "Set up a daily standup report that pulls data from GitHub, Sentry, Axiom, and Plausible every morning, generates a pptx, and posts it to #team-updates";
async function visit(path: string) {
  const available = [
    "github",
    "sentry",
    "axiom",
    "plausible",
    "slack",
    "revenuecat",
    "google-sheets",
    "zapier",
    "notion",
  ];
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: available.map((slug) => {
        return {
          slug,
          label: slug,
          description: slug,
          icon: {
            url: "https://icons.example.test/" + slug + ".svg",
            invertInDarkMode: false,
          },
          category: "productivity",
          generation: [],
          tags: [],
          authMethods: [],
          permissionSummary: {
            hasPermissions: false,
            permissionCount: 0,
            hasCategories: false,
            hasDefaultPolicyOverrides: false,
          },
          singleAuthCodeAuthMethodId: null,
          connectNotice: null,
        };
      }),
    });
  });
  await setupPage({ context, path, host: "app.okou.ai" });
  return await screen.findByRole("searchbox");
}
async function card(title: string) {
  return (
    (await screen.findByText(title, { exact: true })).closest("a") ??
    Promise.reject(new Error("Idea card is missing its link"))
  );
}
async function activeDraft(prompt: string) {
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor.textContent).toBe(prompt);
    expect(window.location.pathname).toBe("/");
  });
}
test("ideas-page-009 the standup card opens its exact prompt with Enter", async () => {
  const search = await visit("/ideas");
  await fill(search, "Daily standup report");
  const link = await card("Daily standup report");
  const url = new URL(link.href);
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get("prompt")).toBe(standup);
  link.focus();
  await userEvent.keyboard("{Enter}");
  await activeDraft(standup);
});
test("ideas-page-011 searching RevenueCat opens the matching subscriptions digest in chat", async () => {
  const search = await visit("/ideas");
  await fill(search, "RevenueCat");
  const link = await card("RevenueCat subscription digest");
  expect(screen.queryByText("Daily standup report")).toBeNull();
  click(link);
  await activeDraft(
    "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes",
  );
});
test("ideas-page-012 the Zapier idea transfers all three migration examples into chat", async () => {
  const search = await visit("/ideas");
  await fill(search, "Zapier");
  const link = await card("Zapier → Okou migration");
  expect(link).toBeVisible();
  click(link);
  await activeDraft(
    "Help me migrate my Zapier workflows to Okou. I have zaps for: new Slack message → Notion, Gmail → Google Sheets, and GitHub PR → Slack",
  );
});
