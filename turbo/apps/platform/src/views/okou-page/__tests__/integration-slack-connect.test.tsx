import { cleanup, screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { setupPage, startPage, click } from "../../../__tests__/page-helper.ts";
import { externalProtocolHandler } from "../../../test/mocks/external-protocol-handler.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { slackOauthCallbackContract } from "@okouai/api-contracts/contracts/slack-oauth-callback";

const context = testContext();

const host = "app.okou.ai";
const settings = "/settings/slack";
const install = "https://slack-install.example.test/start?workspace=bay";
const reconnect =
  "https://slack-install.example.test/permissions?workspace=bay";
const actual = "Actual workspace";
const missing = {
  isAdmin: true,
  isConnected: false,
  isInstalled: false,
  installUrl: install,
} as const;
const connected = {
  isAdmin: true,
  isConnected: true,
  isInstalled: true,
  workspaceName: actual,
} as const;
function organization(status: SlackOrgStatus) {
  context.mocks.http.get("https://slack-install.example.test/*", () => {
    return new Response("Local installation page");
  });
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, status);
  });
}
function page(path: string) {
  return {
    context,
    host,
    path,
  };
}
async function followWeb(label: string, expected: string) {
  click(screen.getByText(label, { selector: "a" }));
  await waitFor(() => {
    expect(location.href).toBe(expected);
  });
}
test("slack-connect-page-001 An admin at the bare settings URL can start installation without launching Slack", async () => {
  const slack = externalProtocolHandler("slack:");
  organization(missing);
  await setupPage(page(settings));
  await screen.findByText("Install to Slack");
  expect(screen.queryByText("Slack is connected")).not.toBeInTheDocument();
  expect(location.href).toBe("https://" + host + settings);
  expect(slack).toStrictEqual([]);
  await followWeb("Install to Slack", install);
});
test.each([
  ["005", ""],
  ["006", "?status=connected"],
  ["007", "?updated=1"],
])(
  "slack-connect-page-%s Confirmed membership with '%s' launches once on entry and leaves manual launch available after focus",
  async (_id, query) => {
    organization(connected);
    const slack = externalProtocolHandler("slack:");
    await setupPage(page(settings + query));
    await screen.findByRole("heading", { name: "Slack is connected" });
    expect(slack).toStrictEqual(["slack://open"]);
    window.dispatchEvent(new Event("focus"));
    expect(slack).toStrictEqual(["slack://open"]);
    click(screen.getByText("Open Slack", { selector: "a" }));
    expect(slack).toStrictEqual(["slack://open", "slack://open"]);
  },
);
test("slack-connect-page-010 A linked identity can install its missing workspace bot", async () => {
  externalProtocolHandler("slack:");
  organization({ ...missing, isConnected: true, workspaceName: actual });
  await setupPage(page(settings));
  await expect(
    screen.findByRole("heading", { name: "Slack is connected" }),
  ).resolves.toBeInTheDocument();
  await followWeb("Install to Slack", install);
});
test("slack-connect-page-011 Denial leaves the verified workspace available for manual launch and permission repair", async () => {
  const slack = externalProtocolHandler("slack:");
  organization({ ...connected, scopeMismatch: true, reinstallUrl: reconnect });
  await setupPage(
    page(settings + "?error=access_denied&workspace=NotTheWorkspace"),
  );
  await expect(
    screen.findByRole("heading", { name: "Slack is connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("You're connected to Actual workspace.", { exact: false }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/NotTheWorkspace/u)).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Slack authorization was not completed",
  );
  expect(slack).toStrictEqual([]);
  click(screen.getByText("Open Slack", { selector: "a" }));
  expect(slack).toStrictEqual(["slack://open"]);
  await followWeb("Update Slack permissions", reconnect);
});
test.each([
  ["012", "/?tab=works&updated=1"],
  ["015", "/slack/failed?error=access_denied"],
])(
  "slack-connect-page-%s Returning to %s with onboarding unfinished still reaches Slack installation",
  async (_id, entry) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    organization(missing);
    await setupPage(page(entry));
    await screen.findByText("Install to Slack");
    expect(location.pathname).toBe(settings);
    await followWeb("Install to Slack", install);
  },
);
test("slack-connect-page-016 A confirmed mismatch requires a choice even when the URL claims success", async () => {
  const slack = externalProtocolHandler("slack:");
  context.mocks.api(
    slackConnectContract.getLinkStatus,
    ({ query, respond }) => {
      return respond(200, {
        isConnected: true,
        isAdmin: false,
        linkStatus: {
          kind: "slack_account_mismatch",
          currentSlackUserId: "U_CURRENT",
          requestedSlackUserId: query.slackUserId,
        },
      });
    },
  );
  await setupPage(
    page(settings + "?status=connected&w=T_ACTUAL&u=U_REQUESTED"),
  );
  await expect(
    screen.findByText("Switch to U_REQUESTED", { selector: "button" }),
  ).resolves.toBeEnabled();
  expect(location.pathname).toBe(settings);
  expect(slack).toStrictEqual([]);
  click(screen.getByText("Keep U_CURRENT", { selector: "a" }));
  await waitFor(() => {
    expect(location.pathname).toBe("/works");
  });
});
test("slack-connect-page-017 The verified workspace returns to its originating channel on automatic and manual launch", async () => {
  const slack = externalProtocolHandler("slack:");
  context.mocks.api(
    slackConnectContract.getLinkStatus,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        workspaceId: "T_ACTUAL",
        slackUserId: "U_SOURCE",
      });
      return respond(200, {
        isConnected: true,
        isAdmin: true,
        workspaceName: actual,
        linkStatus: { kind: "connected" },
      });
    },
  );
  await setupPage(
    page(
      settings + "?workspace=MadeUp&w=T_ACTUAL&u=U_SOURCE&c=C_ORIGIN&t=42.0",
    ),
  );
  await expect(
    screen.findByText("You're connected to Actual workspace.", {
      exact: false,
    }),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe(settings);
  const channel = "slack://channel?team=T_ACTUAL&id=C_ORIGIN";
  expect(slack).toStrictEqual([channel]);
  click(screen.getByText("Open Slack", { selector: "a" }));
  expect(slack).toStrictEqual([channel, channel]);
});
test("slack-connect-page-019 Finishing the original account's held verification after identity replacement cannot launch Slack", async () => {
  const sdk = context.mocks.clerk();
  const slack = externalProtocolHandler("slack:");
  const held = createDeferredPromise<void>(context.signal);
  const arrived = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    integrationsSlackContract.getStatus,
    async ({ respond }) => {
      arrived.resolve();
      await held.promise;
      return respond(200, connected);
    },
  );
  const startup = await startPage(page(settings));
  await Promise.all([startup.content, arrived.promise]);
  sdk.user(
    { id: "slack-replacement", fullName: "Rowan West" },
    { id: "replacement-session", token: "local-replacement" },
  );
  sdk.stateChanged();
  held.resolve();
  // The outgoing document's sidebar can be cancelled while Slack verifies its workspace.
  await screen.findByRole("heading", { name: "Slack is connected" });
  expect(slack).toStrictEqual([]);
});
const legacyFailure =
  "?error=access_denied&w=T123&u=U123&c=C123&t=42.0&context=one&context=two#public-context";
test.each([
  [
    "023",
    "/?tab=works&updated=1#public-context",
    "?updated=1#public-context",
    false,
  ],
  [
    "024",
    "/?tab=works&updated=1#public-context",
    "?updated=1#public-context",
    true,
  ],
  ["025", "/slack/failed" + legacyFailure, legacyFailure, false],
] as const)(
  "slack-connect-page-%s The hosted access form for %s carries the full canonical Slack return",
  async (_id, entry, query, member) => {
    const auth = member
      ? {
          user: { id: "slack-first-org", fullName: "Rowan West" },
          organization: { activeOrg: null, members: [] },
        }
      : null;
    await startPage({ ...page(entry), auth });
    const expectedRoute = member
      ? "/sign-in/tasks/choose-organization"
      : "/sign-in";
    await waitFor(() => {
      expect(location.pathname).toBe(expectedRoute);
    });
    const destination = new URL(location.href);
    const returnUrl = "https://" + host + settings + query;
    expect(destination.searchParams.get("redirect_url")).toBe(returnUrl);
    cleanup();
    await setupPage({
      ...page(destination.pathname + destination.search + destination.hash),
      context: createTestRuntime(context),
      auth,
    });
    const signIn = await screen.findByTestId("clerk-sign-in");
    expect(signIn).toBeVisible();
    expect(signIn).toHaveAttribute("data-clerk-force-redirect-url", returnUrl);
  },
);

test.each([
  ["integration-oauth-callback-001", "slack", "slack"],
  ["integration-oauth-callback-002", "microsoft-365", "teams"],
] as const)(
  "%s returns the full provider continuation to sign-in",
  async (_id, slug, integration) => {
    const path =
      "/connectors/" +
      slug +
      "/callback?integration=" +
      integration +
      "&state=workspace%2Bnorth&code=office-19";
    await startPage({ context, auth: null, path, host: "app.okou.ai" });
    await waitFor(() => {
      return expect(location.pathname).toBe("/sign-in");
    });
    expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
      new URL(path, "https://app.okou.ai").href,
    );
  },
);

test("integration-oauth-callback-004 the signed-in Slack callback completes the secure handoff to settings", async () => {
  const release = createDeferredPromise<void>(context.signal);
  const browser = context.mocks.browser.locationAssign();
  const destination = new URL(
    "/settings/slack?connected=marina",
    "https://app.okou.ai",
  ).href;
  context.mocks.api(
    slackOauthCallbackContract.callback,
    async ({ query, request, respond }) => {
      expect(request.headers.get("Authorization")).toBe(
        "Bearer marina-session",
      );
      expect(query).toMatchObject({
        state: "marina-state",
        code: "ticket-52",
        responseMode: "json",
      });
      await release.promise;
      return respond(200, { redirectUrl: destination });
    },
  );
  const page = await startPage({
    context,
    path: "/connectors/slack/callback?integration=slack&code=ticket-52&state=marina-state",
    auth: {
      user: { id: "member-marina", fullName: "Marina Reed" },
      session: { token: "marina-session" },
    },
  });
  await expect(
    screen.findByText("Finishing the secure connection"),
  ).resolves.toBeInTheDocument();
  release.resolve();
  await waitFor(() => {
    return expect(browser.calls).toContain(destination);
  });
  await page.ready;
});
