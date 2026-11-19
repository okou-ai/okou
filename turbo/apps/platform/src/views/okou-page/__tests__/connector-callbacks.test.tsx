import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function callbackCard(heading: HTMLElement): HTMLElement {
  const card = heading.closest("[aria-live]");
  if (!(card instanceof HTMLElement)) {
    throw new Error("Expected the connector callback card");
  }
  return card;
}

test("Complete a GitHub connector authorization", async () => {
  const requests: string[] = [];
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Not authenticated" },
    });
  });
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ params, query, respond }) => {
      requests.push(`callback:${params.connectorSlug}`);
      expect(query).toMatchObject({
        code: "github-code",
        state: "github-state",
        responseMode: "json",
      });
      return respond(200, { status: "success", username: "octocat" });
    },
  );
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    requests.push(`catalog:${params.connectorSlug}`);
    return respond(200, {
      connector: publicStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        icon: {
          url: "https://icons.example.test/github-mark.svg",
          invertInDarkMode: true,
        },
      }),
    });
  });

  await setupPage({
    context,
    auth: null,
    path: "/connectors/github/callback?code=github-code&state=github-state",
  });

  const heading = await screen.findByRole("heading", {
    name: "GitHub connected",
  });
  const card = callbackCard(heading);
  expect(requests).toStrictEqual(["callback:github", "catalog:github"]);
  expect(card.querySelector("img")).toHaveAttribute(
    "src",
    "https://icons.example.test/github-mark.svg",
  );
  expect(
    within(card).getByText(
      "Connected as octocat. Close this window and return to the original page to continue.",
    ),
  ).toBeInTheDocument();
  expect(location.pathname).toBe("/connectors/github/callback/success");
  const search = new URLSearchParams(location.search);
  expect(search.get("code")).toBeNull();
  expect(search.get("state")).toBeNull();
  expect(search.get("username")).toBe("octocat");
});

test("Show the Link wallet icon on a refreshed success page", async () => {
  const pending = context.mocks.deferred<void>();
  context.mocks.api(connectorCatalogContract.get, async ({ respond }) => {
    await pending.promise;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Connector not found" },
    });
  });
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    async ({ respond }) => {
      await pending.promise;
      return respond(200, { status: "success", username: null });
    },
  );

  await setupPage({
    context,
    auth: null,
    path: "/connectors/link/callback/success",
  });

  const heading = await screen.findByRole("heading", {
    name: "Link connected",
  });
  expect(
    within(callbackCard(heading)).getByRole("img", { name: "Link" }),
  ).toBeInTheDocument();
});

test("Show Mercury attribution on a completed connector callback", async () => {
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, {
      connector: publicStatusItem({
        connectorSlug: "mercury",
        label: "Mercury",
      }),
    });
  });

  await setupPage({
    context,
    auth: null,
    path: "/connectors/mercury/callback/success?username=finance-team",
  });

  const heading = await screen.findByRole("heading", {
    name: "Mercury connected",
  });
  const disclosure = within(callbackCard(heading)).getByRole("region", {
    name: "Mercury banking disclosure",
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", disclosure),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(
    within(disclosure).getByText(
      "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
    ),
  ).toBeInTheDocument();
});

test("Show a provider error safely without an authenticated session", async () => {
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        error: "access_denied",
        state: "notion-state",
      });
      return respond(200, {
        status: "error",
        message: "Provider denied access.",
      });
    },
  );
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Connector not found" },
    });
  });

  await setupPage({
    context,
    auth: null,
    path: "/connectors/notion/callback?error=access_denied&state=notion-state",
  });

  const heading = await screen.findByRole("heading", {
    name: "Couldn’t connect NOTION",
  });
  expect(
    within(callbackCard(heading)).getByText(
      "Provider denied access. Close this window and try again.",
    ),
  ).toBeInTheDocument();
  expect(location.pathname).toBe("/connectors/notion/callback/error");
  const search = new URLSearchParams(location.search);
  expect(search.get("error")).toBeNull();
  expect(search.get("state")).toBeNull();
});
