import {
  type PublicConnectorCatalogIcon,
  connectorCatalogContract,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("returns an HTTPS attempt through the shared native publisher and removes provider parameters", async () => {
  const navigation = context.mocks.browser.locationAssign();
  const attemptId = "11111111-2222-4333-8444-555555555555";
  const url = `https://app.okou.ai/native/connector-authorization?attemptId=${attemptId}`;
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        code: "native-code",
        state: "native-state",
        responseMode: "json",
      });
      return respond(200, {
        status: "success",
        username: null,
        nativeAppReturn: {
          platform: "ios",
          attemptId,
          httpsHost: "app.okou.ai",
        },
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors/github/callback?code=native-code&state=native-state",
    auth: null,
  });
  await waitFor(() => {
    expect(navigation.calls).toContain(url);
  });
  expect(new URLSearchParams(search()).has("code")).toBeFalsy();
  expect(new URLSearchParams(search()).has("state")).toBeFalsy();
  expect(getConnectorAction("link", "Return to Okou")).toHaveAttribute(
    "href",
    url,
  );
});

test("preserves the shared HTTPS return action on a refreshed denial page", async () => {
  const attemptId = "11111111-2222-4333-8444-555555555555";
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, {
      connector: publicStatusItem({ connectorSlug: "github", label: "GitHub" }),
    });
  });
  await setupPage({
    context,
    path: `/connectors/github/callback/error?nativeAppAttemptId=${attemptId}&nativeAppHttpsHost=staging-app.omby.ai&message=Access+denied`,
    auth: null,
  });
  await waitFor(() => {
    expect(getConnectorAction("link", "Return to Okou")).toHaveAttribute(
      "href",
      `https://staging-app.omby.ai/native/connector-authorization?attemptId=${attemptId}`,
    );
  });
});

test("returns a backend-confirmed native attempt to Okou without carrying provider credentials", async () => {
  const navigation = context.mocks.browser.locationAssign();
  const attemptId = "98000000-0000-4000-8000-000000000005";
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, {
      connector: publicStatusItem({ connectorSlug: "strava", label: "Strava" }),
    });
  });
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        code: "oauth-code",
        state: "oauth-state",
        scope: "read",
        responseMode: "json",
      });
      return respond(200, {
        status: "success",
        username: null,
        nativeAppReturn: { platform: "ios", attemptId },
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors/strava/callback?code=oauth-code&state=oauth-state&scope=read",
    auth: null,
  });
  const url = `ai.okou.ios://connector-authorization/${attemptId}`;
  await waitFor(() => {
    expect(navigation.calls).toContain(url);
  });
  await waitFor(() => {
    expect(getConnectorAction("link", "Return to Okou")).toHaveAttribute(
      "href",
      url,
    );
  });
});

test("keeps an explicit native return action after a denied callback page is refreshed", async () => {
  const attemptId = "98000000-0000-4000-8000-000000000005";
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, {
      connector: publicStatusItem({ connectorSlug: "strava", label: "Strava" }),
    });
  });
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ never }) => {
      return never();
    },
  );
  await setupPage({
    context,
    path: `/connectors/strava/callback/error?nativeAppAttemptId=${attemptId}&message=Access+denied`,
    auth: null,
  });
  await waitFor(() => {
    expect(getConnectorAction("link", "Return to Okou")).toHaveAttribute(
      "href",
      `ai.okou.ios://connector-authorization/${attemptId}`,
    );
  });
});

function githubIcon(): PublicConnectorCatalogIcon {
  return {
    url: "https://icons.example.test/github.svg",
    invertInDarkMode: true,
  };
}

test("Complete a custom connector authorization", async () => {
  context.mocks.api(
    customConnectorOAuth2Contract.callback,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        code: "oauth-code",
        state: "oauth-state",
        responseMode: "json",
        integration: "provider-context",
      });
      return respond(200, { status: "success", username: null });
    },
  );

  await setupPage({
    context,
    path: "/connectors/custom/callback?code=oauth-code&state=oauth-state&integration=provider-context",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Custom connector connected" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/connectors/custom/callback/success");
    expect(search()).toBe("");
  });
});

test("Complete a GitHub connector authorization", async () => {
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Sign in to view saved accounts",
      },
    });
  });
  const icon = githubIcon();
  const catalogStarted = context.mocks.deferred<void>();
  const releaseCatalog = context.mocks.deferred<void>();
  const callbackStarted = context.mocks.deferred<void>();
  const requestOrder: string[] = [];
  context.mocks.api(
    connectorCatalogContract.get,
    async ({ params, respond, withSignal }) => {
      requestOrder.push("catalog");
      catalogStarted.resolve(undefined);
      expect(params.connectorSlug).toBe("github");
      await withSignal(releaseCatalog.promise);
      return respond(200, {
        connector: publicStatusItem({
          connectorSlug: "github",
          label: "GitHub",
          icon,
        }),
      });
    },
  );
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ params, query, respond }) => {
      requestOrder.push("callback");
      callbackStarted.resolve(undefined);
      expect(params.connectorSlug).toBe("github");
      expect(query).toMatchObject({
        code: "oauth-code",
        state: "oauth-state",
        responseMode: "json",
      });
      return respond(200, { status: "success", username: "octocat" });
    },
  );

  const page = setupPage({
    context,
    path: "/connectors/github/callback?code=oauth-code&state=oauth-state",
    auth: null,
  });
  await callbackStarted.promise;
  expect(requestOrder).toStrictEqual(["callback"]);
  await catalogStarted.promise;
  expect(releaseCatalog.settled()).toBeFalsy();
  expect(requestOrder).toStrictEqual(["callback", "catalog"]);
  releaseCatalog.resolve(undefined);
  await page;

  const heading = await screen.findByRole("heading", {
    name: "GitHub connected",
  });
  expect(heading).toBeInTheDocument();
  const image = document.querySelector<HTMLImageElement>(
    `img[src="${icon.url}"]`,
  );
  expect(image).toHaveAttribute("src", icon.url);
  expect(
    screen.getByText(
      "Connected as octocat. Close this window and return to the original page to continue.",
    ),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/connectors/github/callback/success");
  });
  const result = new URLSearchParams(search());
  expect(result.has("code")).toBeFalsy();
  expect(result.has("state")).toBeFalsy();
});

test("Refreshing a completed connector callback does not reconnect it", async () => {
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ never }) => {
      return never();
    },
  );

  await setupPage({
    context,
    path: "/connectors/github/callback/success?username=octocat",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "GitHub connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "Connected as octocat. Close this window and return to the original page to continue.",
    ),
  ).toBeInTheDocument();
});

test("Complete a native Link wallet authorization without a catalog entry", async () => {
  context.mocks.api(connectorCatalogContract.get, ({ never }) => {
    return never();
  });
  context.mocks.api(
    builtinConnectorsSlugCallbackContract.callback,
    ({ params, query, respond }) => {
      expect(params.connectorSlug).toBe("link");
      expect(query).toMatchObject({
        code: "oauth-code",
        state: "oauth-state",
        responseMode: "json",
      });
      return respond(200, { status: "success", username: null });
    },
  );

  await setupPage({
    context,
    path: "/connectors/link/callback?code=oauth-code&state=oauth-state",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Link connected" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Link" })).toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/connectors/link/callback/success");
    expect(search()).toBe("");
  });
});

test.each([
  ["success", "Link connected"],
  ["error", "Couldn’t connect Link"],
])(
  "Show the Link wallet icon on a refreshed %s page",
  async (status, title) => {
    context.mocks.api(connectorCatalogContract.get, ({ never }) => {
      return never();
    });
    context.mocks.api(
      builtinConnectorsSlugCallbackContract.callback,
      ({ never }) => {
        return never();
      },
    );

    await setupPage({
      context,
      path: `/connectors/link/callback/${status}`,
      auth: null,
    });

    await expect(
      screen.findByRole("heading", { name: title }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Link" })).toBeInTheDocument();
  },
);

test("Show Mercury attribution on a completed connector callback", async () => {
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    expect(params.connectorSlug).toBe("mercury");
    return respond(200, {
      connector: publicStatusItem({
        connectorSlug: "mercury",
        label: "Mercury",
      }),
    });
  });

  await setupPage({
    context,
    path: "/connectors/mercury/callback/success?username=Not+A+Real+Company+Inc.",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Mercury connected" }),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("link", "Powered by Mercury")).toHaveAttribute(
    "href",
    "https://mercury.com",
  );
  expect(
    screen.getByText(
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
        state: "oauth-state",
        responseMode: "json",
      });
      return respond(200, {
        status: "error",
        message: "Provider denied access",
      });
    },
  );

  await setupPage({
    context,
    path: "/connectors/notion/callback?error=access_denied&state=oauth-state",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Couldn’t connect NOTION" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(/Provider denied access/u)).toBeInTheDocument();
  expect(
    screen.getByText(/Close this window and try again\./u),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/connectors/notion/callback/error");
  });
  const result = new URLSearchParams(search());
  expect(result.has("error")).toBeFalsy();
  expect(result.has("state")).toBeFalsy();
});
