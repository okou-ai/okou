import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const installUrl =
  "https://api.okou.test/api/slack/oauth/install?connectorState=install";
const connectUrl =
  "https://api.okou.test/api/slack/oauth/connect?connectorState=connect";

test.each([
  "",
  "?status=connected&workspace=Forged",
  "?installed=1",
  "?updated=1",
])(
  "A bare or returned page reads actual state before offering installation: %s",
  async (query) => {
    const launched = context.mocks.browser.locationAssign();
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: false,
        isInstalled: false,
        isAdmin: true,
        installUrl,
      });
    });
    await setupPage({ context, path: `/settings/slack${query}` });
    await expect(
      waitFor(() => {
        return getAction("link", "Install to Slack");
      }),
    ).resolves.toHaveAttribute("href", installUrl);
    expect(screen.queryByText("Slack is connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Forged/u)).not.toBeInTheDocument();
    expect(pathname()).toBe("/settings/slack");
    expect(launched.calls).toStrictEqual([]);
  },
);

test.each(["", "?status=connected", "?updated=1"])(
  "A confirmed connection opens Slack once and retains the manual action: %s",
  async (query) => {
    const launched = context.mocks.browser.locationAssign();
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: true,
        isInstalled: true,
        isAdmin: true,
        workspaceName: "Actual workspace",
      });
    });
    await setupPage({ context, path: `/settings/slack${query}` });
    expect(launched.calls).toStrictEqual(["slack://open"]);
    expect(getAction("link", "Open Slack")).toHaveAttribute(
      "href",
      "slack://open",
    );
    expect(
      screen.getByRole("heading", { name: "Slack is connected" }),
    ).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(launched.calls).toStrictEqual(["slack://open"]);
  },
);

test("An installed member can authorize their account with the retained API shape", async () => {
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      connectUrl,
    });
  });
  await setupPage({ context, path: "/settings/slack?prompt=Hello%20team" });
  const url = new URL(
    (
      await waitFor(() => {
        return getAction("link", "Connect");
      })
    ).getAttribute("href")!,
  );
  expect(url.searchParams.get("connectorState")).toBe("connect");
  expect(url.searchParams.get("prompt")).toBe("Hello team");
});

test("A member can connect their Slack identity before bot installation", async () => {
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: false,
      connectUrl,
    });
  });
  await setupPage({ context, path: "/settings/slack" });
  await expect(
    waitFor(() => {
      return getAction("link", "Connect");
    }),
  ).resolves.toHaveAttribute("href", connectUrl);
});

test("A connected identity retains the installation action when its bot is missing", async () => {
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: true,
      isInstalled: false,
      isAdmin: true,
      workspaceName: "Home workspace",
      installUrl,
    });
  });
  await setupPage({ context, path: "/settings/slack" });
  await expect(
    waitFor(() => {
      return getAction("link", "Install to Slack");
    }),
  ).resolves.toHaveAttribute("href", installUrl);
  expect(
    screen.getByRole("heading", { name: "Slack is connected" }),
  ).toBeInTheDocument();
});

test("An existing connection and failed authorization are reported separately", async () => {
  const launched = context.mocks.browser.locationAssign();
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: true,
      isAdmin: true,
      workspaceName: "Actual workspace",
      scopeMismatch: true,
      reinstallUrl: installUrl,
    });
  });
  await setupPage({
    context,
    path: "/settings/slack?error=access_denied&workspace=Forged",
  });
  await expect(
    screen.findByRole("heading", { name: "Slack is connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(/You're connected to Actual workspace/u),
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "authorization was not completed",
  );
  expect(getAction("link", "Update Slack permissions")).toHaveAttribute(
    "href",
    installUrl,
  );
  expect(getAction("link", "Open Slack")).toHaveAttribute(
    "href",
    "slack://open",
  );
  expect(window.location.protocol).not.toBe("slack:");
  expect(launched.calls).toStrictEqual([]);
});

test.each([
  "/?tab=works&updated=1",
  "/?tab=works&installed=1",
  "/?tab=works&connected=1",
  "/slack/failed?error=access_denied",
])(
  "A retained Slack result reaches the canonical state page: %s",
  async (path) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: false,
        isInstalled: false,
        isAdmin: true,
        installUrl,
      });
    });
    await setupPage({ context, path });
    await expect(
      waitFor(() => {
        return getAction("link", "Install to Slack");
      }),
    ).resolves.toHaveAttribute("href", installUrl);
    expect(pathname()).toBe("/settings/slack");
  },
);

test("A success hint cannot bypass the authenticated account mismatch check", async () => {
  const launched = context.mocks.browser.locationAssign();
  context.mocks.api(slackConnectContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      isConnected: true,
      isAdmin: false,
      workspaceName: "Actual workspace",
      linkStatus: {
        kind: "slack_account_mismatch",
        currentSlackUserId: "U_CURRENT",
        requestedSlackUserId: "U_REQUESTED",
      },
    });
  });
  await setupPage({
    context,
    path: "/settings/slack?status=connected&w=T_ACTUAL&u=U_REQUESTED",
  });
  await expect(
    waitFor(() => {
      return getAction("button", "Switch to U_REQUESTED");
    }),
  ).resolves.toBeEnabled();
  expect(getAction("link", "Keep U_CURRENT")).toBeInTheDocument();
  expect(pathname()).toBe("/settings/slack");
  expect(launched.calls).toStrictEqual([]);
});

test("A verified provider link opens the conversation and keeps a manual return link", async () => {
  const launched = context.mocks.browser.locationAssign();
  context.mocks.api(slackConnectContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      isConnected: true,
      isAdmin: false,
      workspaceName: "Actual workspace",
      linkStatus: { kind: "connected" },
    });
  });
  await setupPage({
    context,
    path: "/settings/slack?status=connected&w=T_ACTUAL&u=U_ACTUAL&c=C_ORIGIN&t=42.0&workspace=Forged",
  });
  const link = await waitFor(() => {
    return getAction("link", "Open Slack");
  });
  expect(link).not.toHaveAttribute("role", "button");
  expect(link).toHaveAttribute(
    "href",
    "slack://channel?team=T_ACTUAL&id=C_ORIGIN",
  );
  expect(launched.calls).toStrictEqual([
    "slack://channel?team=T_ACTUAL&id=C_ORIGIN",
  ]);
  expect(
    screen.getByText(/You're connected to Actual workspace/u),
  ).toBeInTheDocument();
  expect(pathname()).toBe("/settings/slack");
});

test("Leaving the page during verification cancels the automatic Slack launch", async () => {
  const launched = context.mocks.browser.locationAssign();
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(slackConnectContract.getLinkStatus, async ({ respond }) => {
    requested.resolve();
    await release.promise;
    return respond(200, {
      isConnected: true,
      isAdmin: false,
      workspaceName: "Actual workspace",
      linkStatus: { kind: "connected" },
    });
  });
  const page = await startPage({
    context,
    path: "/settings/slack?status=connected&w=T_ACTUAL&u=U_ACTUAL",
  });
  await page.content;
  await requested.promise;
  act(() => {
    window.history.pushState(null, "", "/works");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    screen.findByText("Microsoft Teams"),
  ).resolves.toBeInTheDocument();
  release.resolve();
  await page.ready;
  expect(launched.calls).toStrictEqual([]);
  expect(pathname()).toBe("/works");
});

test.each(["/settings/slack", "/settings/slack?w=T_ACTUAL&u=U_ACTUAL"])(
  "Changing accounts during verification prevents the old account from opening Slack: %s",
  async (path) => {
    const launched = context.mocks.browser.locationAssign();
    const requested = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      integrationsSlackContract.getStatus,
      async ({ respond }) => {
        requested.resolve();
        await release.promise;
        return respond(200, {
          isConnected: true,
          isInstalled: true,
          isAdmin: false,
        });
      },
    );
    context.mocks.api(
      slackConnectContract.getLinkStatus,
      async ({ respond }) => {
        requested.resolve();
        await release.promise;
        return respond(200, {
          isConnected: true,
          isAdmin: false,
          linkStatus: { kind: "connected" },
        });
      },
    );
    const page = await startPage({ context, path });
    await page.content;
    await requested.promise;
    const clerk = context.mocks.clerk();
    act(() => {
      clerk.user(
        { id: "replacement-owner", fullName: "Replacement" },
        { id: "replacement-session", token: "replacement-token" },
      );
      clerk.stateChanged();
    });
    release.resolve();
    await page.ready;
    expect(launched.calls).toStrictEqual([]);
  },
);

test("A member without an installation gets an admin action rather than an install grant", async () => {
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: false,
    });
  });
  await setupPage({ context, path: "/settings/slack" });
  await expect(
    screen.findByText("Ask your admin to install the Slack integration"),
  ).resolves.toBeInTheDocument();
  expect(getAction("link", "Back to settings")).toBeInTheDocument();
});

test("A canonical preview page preserves access to its own API authorization URL", async () => {
  const url =
    "https://pr-431-api.vm6.ai/api/slack/oauth/install?connectorState=install";
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: url,
    });
  });
  await setupPage({
    context,
    host: "pr-431-app-okou-app-preview.vm0.workers.dev",
    path: "/settings/slack?x-vercel-protection-bypass=preview-secret",
  });
  const action = await waitFor(() => {
    return getAction("link", "Install to Slack");
  });
  expect(
    new URL(action.getAttribute("href")!).searchParams.get(
      "x-vercel-protection-bypass",
    ),
  ).toBe("preview-secret");
});

test.each([
  {
    path: "/?tab=works&updated=1",
    target: "/settings/slack?updated=1",
    signedIn: false,
  },
  {
    path: "/?tab=works&updated=1",
    target: "/settings/slack?updated=1",
    signedIn: true,
  },
  {
    path: "/slack/failed?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two",
    target:
      "/settings/slack?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two",
    signedIn: false,
  },
  {
    path: "/slack/failed?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two",
    target:
      "/settings/slack?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two",
    signedIn: true,
  },
])(
  "A retained Slack result survives login and organization selection (signed in: $signedIn): $path",
  async ({ path, target, signedIn }) => {
    await startPage({
      context,
      host: "app.okou.ai",
      path: `${path}#public-context`,
      auth: signedIn
        ? {
            user: { id: "slack-user", fullName: "Slack User" },
            organization: { activeOrg: null, memberships: [] },
          }
        : null,
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        signedIn ? "/sign-in/tasks/choose-organization" : "/sign-in",
      );
    });
    window.history.replaceState(null, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const signIn = await screen.findByTestId("clerk-sign-in");
    expect(
      signIn.dataset.clerkForceRedirectUrl ===
        `https://app.okou.ai${target}#public-context`,
    ).toBeTruthy();
  },
);

test("An unrelated root query is not treated as a Slack completion", async () => {
  await startPage({
    context,
    host: "app.okou.ai",
    path: "/?tab=works&updated=1&prompt=Unrelated",
    auth: {
      user: { id: "other-user", fullName: "Other User" },
      organization: { activeOrg: null, memberships: [] },
    },
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in/tasks/choose-organization");
  });
  expect(window.location.search).toBe("");
});
