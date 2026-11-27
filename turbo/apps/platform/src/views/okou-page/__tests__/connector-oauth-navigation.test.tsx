import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, startPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserAuthMethod,
  catalogConnector,
} from "./chat-capability-connector-test-helpers.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";
import { mockPublicConnectorStatus } from "./connector-page-test-helpers.ts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import {
  findButton,
  findEnabledButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const context = testContext();

test("a saved callback with an explicit icon retains its published URL", async () => {
  const url = "https://static.vm0.io/test-fixtures/connectors/github.svg";
  const query = new URLSearchParams({
    iconUrl: url,
    iconInvertInDarkMode: "false",
  });
  await setupPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: `/connectors/github/callback/success?${query}`,
  });
  expect(screen.getByAltText("")).toHaveAttribute("src", url);
});

test("connector-callbacks-007 a completed Mercury connection identifies its banking providers", async () => {
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
  await expect(findButton("Close window")).resolves.toBeInTheDocument();
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

test("connector-callbacks-002 GitHub publishes its account and mark after the public callback", async () => {
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ query, params, respond }) => {
      expect(params.connectorSlug).toBe("github");
      expect(query).toMatchObject({ code: "port-code", state: "review" });
      return respond(200, { status: "success", username: "octocat" });
    },
  );
  await setupPage({
    context,
    auth: null,
    path: "/connectors/github/callback?state=review&code=port-code",
    host: "app.okou.ai",
  });
  await screen.findByRole("heading", { name: "GitHub connected" });
  expect(screen.getByText(/^Connected as octocat\./)).toBeInTheDocument();
  expect(screen.getByAltText("")).toHaveAttribute(
    "src",
    "https://api.okou.ai/api/connector-catalog/github/icon",
  );
  expect(location.pathname).toBe("/connectors/github/callback/success");
  const query = new URLSearchParams(location.search);
  expect(query.has("code")).toBeFalsy();
  expect(query.has("state")).toBeFalsy();
});

test("a native denial keeps the connector error and an app return fallback after automatic opening", async () => {
  const attempt = "b86a89e2-052a-4c88-ae3e-1d71aa1631d2";
  const destination = `ai.okou.ios://connector-authorization/${attempt}`;
  const navigation = context.mocks.browser.locationAssign();
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ respond }) => {
      return respond(200, {
        status: "error",
        message: "Provider denied access.",
        nativeAppReturn: {
          platform: "ios",
          attemptId: attempt,
          httpsHost: "app.okou.ai",
        },
      });
    },
  );
  await setupPage({
    context,
    auth: null,
    path: "/connectors/strava/callback?error=access_denied&state=native-denied",
  });
  await expect(findNamedLink("Return to Okou")).resolves.toHaveAttribute(
    "href",
    destination,
  );
  expect(
    screen.getByText("Provider denied access. Return to Okou to try again."),
  ).toBeInTheDocument();
  expect(location.pathname).toBe("/connectors/strava/callback/error");
  await waitFor(() => {
    expect(navigation.calls).toStrictEqual([destination]);
  });
});

test.each([null, "app.okou.ai"] as const)(
  "A Google Search Console confirmation returns to iOS with the attempt identifier over %s",
  async (host) => {
    const attempt = "b86a89e2-052a-4c88-ae3e-1d71aa1631d2";
    const destination = "ai.okou.ios://connector-authorization/" + attempt;
    const navigation = context.mocks.browser.locationAssign();
    const grant = context.mocks.deferred<void>();
    context.mocks.api(
      builtinConnectorsSlugCallbackContract.callback,
      async ({ query, respond }) => {
        await grant.promise;
        expect(query).toMatchObject({
          code: "console-grant",
          state: "browser-state",
          scope: "read",
          responseMode: "json",
        });
        return respond(200, {
          status: "success",
          username: null,
          nativeAppReturn: {
            platform: "ios",
            attemptId: attempt,
            ...(host ? { httpsHost: host } : {}),
          },
        });
      },
    );
    const page = await startPage({
      context,
      auth: null,
      host: "app.okou.ai",
      path: "/connectors/google-search-console/callback?code=console-grant&state=browser-state&scope=read",
    });
    await page.content;
    const image = screen.getByAltText("");
    expect(image).toHaveAttribute(
      "src",
      "https://api.okou.ai/api/connector-catalog/google-search-console/icon",
    );
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    grant.resolve();
    await page.ready;
    const link = await findNamedLink("Return to Okou");
    expect(link).toHaveAttribute("href", destination);
    expect(
      screen.getByText("Your account has been connected. Returning to Okou…"),
    ).toBeInTheDocument();
    expect(new URLSearchParams(location.search).has("code")).toBeFalsy();
    expect(new URLSearchParams(location.search).has("state")).toBeFalsy();
    await waitFor(() => {
      expect(navigation.calls).toStrictEqual([destination]);
    });
  },
);
test.each([
  [null, "error"],
  ["staging-app.omby.ai", "error"],
  ["app.okou.ai", "success"],
] as const)(
  "A saved Strava result reopens iOS over %s with status %s",
  async (host, status) => {
    const attempt = "b9a238d5-0fb4-43ec-9cd2-d8d5547911a9";
    const destination = "ai.okou.ios://connector-authorization/" + attempt;
    const navigation = context.mocks.browser.locationAssign();
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
        `/connectors/strava/callback/${status}?message=Access+denied&nativeAppAttemptId=` +
        attempt +
        (host ? "&nativeAppHttpsHost=" + host : ""),
    });
    expect(screen.getByAltText("")).toHaveAttribute(
      "src",
      expect.stringContaining("/api/connector-catalog/strava/icon"),
    );
    const link = await findNamedLink("Return to Okou");
    expect(link).toHaveAttribute("href", destination);
    expect(
      screen.getByRole("heading", {
        name:
          status === "error" ? "Couldn’t connect STRAVA" : "STRAVA connected",
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(navigation.calls).toStrictEqual([destination]);
    });
  },
);

test("connector-oauth-receipts-001 closing the pending Stripe authorization returns to a usable connection action", async () => {
  mockPublicConnectorStatus(context, [
    catalogConnector({
      slug: "stripe",
      label: "Stripe",
      method: browserAuthMethod(),
    }),
  ]);
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  const attempt = crypto.randomUUID();
  const authorizationUrl = "https://stripe.example.test/approval";
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ respond }) => {
    return respond(200, { authorizationUrl, oauthAttemptId: attempt });
  });
  const pending = context.mocks.deferred<void>();
  const finalLookup = context.mocks.deferred<void>();
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    async ({ params, query, respond, never }) => {
      if (
        params.attemptId === attempt &&
        query.kind === "builtin" &&
        query.connectorSlug === "stripe"
      ) {
        if (!popup.closed) {
          pending.resolve();
          return await never();
        }
        finalLookup.resolve();
      }
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Receipt not available yet" },
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  click(await findButton("Connect Stripe"));

  await pending.promise;
  expect(popup.location.href).toBe(authorizationUrl);
  expect(queryButton("Connect Stripe")).toBeDisabled();
  popup.close();
  await finalLookup.promise;
  await expect(
    findEnabledButton("Connect Stripe"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("OAuth completion is unavailable"),
  ).not.toBeInTheDocument();
});

test("connector-redirect-pages-001 identifies Mercury and its partner banks to signed-out visitors", async () => {
  await setupPage({
    context,
    auth: null,
    path: "/connectors/mercury/redirecting?label=Mercury",
  });
  const disclosure = await screen.findByRole("region", {
    name: "Mercury banking disclosure",
  });
  expect(disclosure).toHaveTextContent(
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
  );
  const provider = within(disclosure).getByText("Powered by Mercury", {
    selector: "a[href]",
  });
  expect(provider).toHaveAttribute("href", "https://mercury.com");
  expect(
    screen.getByRole("heading", { name: "Redirecting to Mercury…" }),
  ).toBeInTheDocument();
});
