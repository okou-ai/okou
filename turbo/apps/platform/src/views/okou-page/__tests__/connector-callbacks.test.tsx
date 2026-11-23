import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { screen, waitFor } from "@testing-library/react";
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

test("connector-callbacks-002 GitHub publishes its account and catalog mark after the public callback", async () => {
  const mark = "https://icons.example.test/authorized-github.svg";
  let authorized = false;
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Sign in" },
    });
  });
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ query, params, respond }) => {
      authorized =
        params.connectorSlug === "github" &&
        query.code === "port-code" &&
        query.state === "review";
      return respond(200, { status: "success", username: "octocat" });
    },
  );
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    const connector = catalogConnector({
      slug: "github",
      label: "GitHub",
      method: browserAuthMethod(),
    });
    return respond(200, {
      connector: {
        ...connector,
        icon: {
          ...connector.icon,
          url: authorized ? mark : "https://icons.example.test/pending.svg",
        },
      },
    });
  });
  await setupPage({
    context,
    auth: null,
    path: "/connectors/github/callback?state=review&code=port-code",
    host: "app.okou.ai",
  });
  await screen.findByRole("heading", { name: "GitHub connected" });
  expect(screen.getByText(/^Connected as octocat\./)).toBeInTheDocument();
  expect(screen.getByAltText("")).toHaveAttribute("src", mark);
  expect(location.pathname).toBe("/connectors/github/callback/success");
  const query = new URLSearchParams(location.search);
  expect(query.has("code")).toBeFalsy();
  expect(query.has("state")).toBeFalsy();
});

function serveStravaCatalog() {
  const connector = catalogConnector({
    slug: "strava",
    label: "Strava",
    method: browserAuthMethod(),
  });
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector });
  });
}
test("A Strava confirmation returns to the iOS app with the attempt identifier alone", async () => {
  serveStravaCatalog();
  const attempt = "b86a89e2-052a-4c88-ae3e-1d71aa1631d2";
  const destination = "ai.okou.ios://connector-authorization/" + attempt;
  const navigation = context.mocks.browser.locationAssign();
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        code: "activity-read",
        state: "trail-return",
        scope: "read",
        responseMode: "json",
      });
      return respond(200, {
        status: "success",
        username: null,
        nativeAppReturn: { platform: "ios", attemptId: attempt },
      });
    },
  );
  await setupPage({
    context,
    auth: null,
    path: "/connectors/strava/callback?code=activity-read&state=trail-return&scope=read",
  });
  const link = await findNamedLink("Return to Okou");
  expect(link).toHaveAttribute("href", destination);
  await waitFor(() => {
    expect(navigation.calls).toContain(destination);
  });
});
test("Refreshing a denied Strava callback keeps its explicit return to the iOS app", async () => {
  serveStravaCatalog();
  const attempt = "b9a238d5-0fb4-43ec-9cd2-d8d5547911a9";
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ never }) => {
      return never();
    },
  );
  await setupPage({
    context,
    auth: null,
    path:
      "/connectors/strava/callback/error?message=Access+denied&nativeAppAttemptId=" +
      attempt,
  });
  const link = await findNamedLink("Return to Okou");
  expect(link).toHaveAttribute(
    "href",
    "ai.okou.ios://connector-authorization/" + attempt,
  );
  expect(
    screen.getByText("Access denied Close this window and try again."),
  ).toBeVisible();
});
