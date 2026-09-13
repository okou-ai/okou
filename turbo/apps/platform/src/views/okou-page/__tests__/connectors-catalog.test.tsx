import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  pushState,
  search as locationSearch,
} from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setMockConnectorFeatureSwitches } from "../../../mocks/handlers/api-connectors.ts";
import {
  getConnectorAction,
  getConnectorCard,
  listAgent,
  mockConnectors,
  mockCustomConnectorStory,
  mockOAuthCompletions,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function oauthMethod() {
  return {
    id: "oauth",
    label: "OAuth",
    description: null,
    grantKind: "auth-code" as const,
    manualFields: [],
    startOptions: [],
  };
}

async function expectCards(expected: {
  readonly github: boolean;
  readonly asana: boolean;
}): Promise<void> {
  await waitFor(() => {
    expect({
      github: queryConnectorCard("GitHub") !== null,
      asana: queryConnectorCard("Asana") !== null,
    }).toStrictEqual(expected);
  });
}

test("Browse connectors by category", async () => {
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  await setupPage({ context, path: "/connectors" });

  const engineering = await screen.findByTestId(
    "connector-category-engineering-team-execution",
  );
  const labels = within(engineering)
    .getAllByTestId("connector-card-label")
    .map((element) => {
      return element.textContent;
    });
  expect(labels).toContain("GitHub");
  expect(labels).toContain("Asana");
  const ai = screen.getByTestId("connector-category-ai");
  expect(
    ai.compareDocumentPosition(engineering) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("Show only connectors present in the current catalog", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  await setupPage({ context, path: "/connectors?keywords=stripe" });

  await expect(
    screen.findByPlaceholderText("Find connectors"),
  ).resolves.toHaveValue("stripe");
  await expect(
    screen.findByText(/No connectors matching/u),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorAction("button", "Connect Stripe")).toBeNull();
});

test("Keep connectors discoverable during category changes", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "github",
      label: "Fallback GitHub",
      category: "legacy-category",
      authMethods: [oauthMethod()],
    }),
  ]);
  await setupPage({ context, path: "/connectors" });

  const section = await screen.findByTestId(
    "connector-category-legacy-category",
  );
  expect(within(section).getByText("Legacy Category")).toBeInTheDocument();
  expect(queryConnectorCard("Fallback GitHub")).toBeInTheDocument();
});

test("Avoid duplicate catalog sections during metadata changes", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(
    context,
    [
      publicStatusItem({
        connectorSlug: "github",
        label: "Partner GitHub",
        category: "partner-apps",
        authMethods: [oauthMethod()],
      }),
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Billing Stripe",
        category: "billing-apps",
        authMethods: [oauthMethod()],
      }),
    ],
    {
      categories: [
        {
          id: "partner-apps",
          label: "Partner Apps",
          menuLabel: "Partners",
          groupId: null,
        },
        {
          id: "partner-apps",
          label: "Duplicate Partner Apps",
          menuLabel: "Duplicate Partners",
          groupId: null,
        },
        {
          id: "billing-apps",
          label: "Billing Apps",
          menuLabel: "Billing",
          groupId: "partner-apps",
        },
      ],
      groups: [
        {
          id: "partner-apps",
          label: "Partner Group",
          menuLabel: "Partner Group",
        },
      ],
    },
  );
  await setupPage({ context, path: "/connectors" });

  await expect(screen.findByText("Partner Apps")).resolves.toBeInTheDocument();
  expect(screen.queryByText("Duplicate Partner Apps")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("connector-category-partner-apps")).toHaveLength(
    1,
  );
  expect(screen.getAllByTestId("connector-category-billing-apps")).toHaveLength(
    1,
  );
  expect(screen.getAllByText("Partner GitHub")).toHaveLength(1);
  expect(queryConnectorCard("Billing Stripe")).toBeInTheDocument();
});

test("Show Mailchimp OAuth without a feature-switch override", async () => {
  mockConnectors(context, []);
  await setupPage({ context, path: "/connectors?keywords=mailchimp" });

  await waitFor(() => {
    expect(getConnectorAction("button", "Connect Mailchimp")).toBeEnabled();
  });
});

test("Update connector visibility when availability changes", async () => {
  mockConnectors(context, []);
  setMockConnectorFeatureSwitches({
    [FeatureSwitchKey.MailchimpConnector]: false,
  });
  const switchesReady = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    await switchesReady.promise;
    return respond(200, {
      switches: { [FeatureSwitchKey.MailchimpConnector]: true },
      effectiveSwitches: { [FeatureSwitchKey.MailchimpConnector]: true },
    });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=mailchimp",
  });

  await expect(
    screen.findByText(/No connectors matching/u),
  ).resolves.toBeInTheDocument();

  setMockConnectorFeatureSwitches({
    [FeatureSwitchKey.MailchimpConnector]: true,
  });
  switchesReady.resolve();

  await waitFor(() => {
    expect(
      getConnectorAction("button", "Connect Mailchimp"),
    ).toBeInTheDocument();
  });
  expect(locationSearch()).toBe("?keywords=mailchimp");
});

async function openConnectorFilterCatalog() {
  const researchId = "c0000000-0000-4000-a000-000000000010";
  const [github] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  if (!github) {
    throw new Error("Expected the connected GitHub account");
  }
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      connection: github,
      connected: true,
      connectionStatus: "connected",
      authMethods: [oauthMethod()],
    }),
    publicStatusItem({
      connectorSlug: "asana",
      label: "Asana",
      authMethods: [oauthMethod()],
    }),
  ]);
  context.mocks.data.agents([
    listAgent(researchId, "Research Agent", "preset:0"),
  ]);
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledConnectorSlugs: params.id === researchId ? ["github"] : [],
    });
  });
  await setupPage({ context, path: "/connectors" });
  await expectCards({ github: true, asana: true });
  return { researchId };
}

test("Switch between connected and disconnected connector filters", async () => {
  await openConnectorFilterCatalog();
  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "Connected"));
  await expectCards({ github: true, asana: false });
  expect(new URLSearchParams(locationSearch()).get("connection")).toBe(
    "connected",
  );

  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "Not connected"));
  await expectCards({ github: false, asana: true });
});

test("Retain a text search when clearing the connector connection filter", async () => {
  await openConnectorFilterCatalog();
  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "Not connected"));
  await expectCards({ github: false, asana: true });

  await fill(screen.getByPlaceholderText("Find connectors"), "git");
  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "All"));
  await expectCards({ github: true, asana: false });
  expect(new URLSearchParams(locationSearch()).get("keywords")).toBe("git");
  expect(new URLSearchParams(locationSearch()).has("connection")).toBeFalsy();
});

test("Filter connectors by an agent after clearing the text search", async () => {
  const { researchId } = await openConnectorFilterCatalog();
  await fill(screen.getByPlaceholderText("Find connectors"), "git");
  await expectCards({ github: true, asana: false });
  await fill(screen.getByPlaceholderText("Find connectors"), "");
  click(getConnectorAction("button", "Filter connectors"));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Research Agent");
    }),
  );
  await expectCards({ github: true, asana: false });
  expect(locationSearch()).toContain("connection=agent");
  expect(locationSearch()).toContain(researchId);
});

test("Navigate the connector catalog with a keyboard", async () => {
  const user = userEvent.setup({ delay: null });
  mockConnectors(context, []);
  await setupPage({ context, path: "/connectors" });
  const ai = await waitFor(() => {
    return getConnectorAction("button", "AI");
  });
  ai.focus();
  await user.keyboard("{Enter}");
  const models = getConnectorAction("button", "General models and reasoning");
  models.focus();
  await user.keyboard("{Enter}");
  const engineering = getConnectorAction(
    "button",
    "Engineering and team execution",
  );
  engineering.focus();
  await user.keyboard("{Enter}");
  const axiom = await waitFor(() => {
    return getConnectorAction("button", "Connect Axiom");
  });

  axiom.focus();
  expect(axiom).toHaveFocus();
  await user.keyboard(" ");

  await expect(
    screen.findByRole("dialog", { name: "Axiom" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Save")).toBeInTheDocument();
});

test("Require an application update before using connectors", async () => {
  context.mocks.http.get("*/api/connector-catalog/discovery", () => {
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });
  await setupPage({ context, path: "/connectors" });

  const dialog = await screen.findByRole("dialog", { name: "Update required" });
  expect(dialog).toHaveTextContent(
    "This version of Okou is no longer supported.",
  );
  expect(screen.queryByText("HTTP 426")).not.toBeInTheDocument();
});

test("Search connectors and preserve meaningful navigation state", async () => {
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
    { connectorSlug: "axiom", authMethod: "api-token" },
  ]);
  await setupPage({ context, path: "/connectors?keywords=axiom" });
  const search = await screen.findByPlaceholderText("Find connectors");
  expect(search).toHaveValue("axiom");
  expect(queryConnectorCard("Axiom")).toBeInTheDocument();
  expect(queryConnectorCard("GitHub")).not.toBeInTheDocument();

  await fill(search, "github");
  await waitFor(() => {
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
    expect(queryConnectorCard("Axiom")).not.toBeInTheDocument();
  });
  expect(new URLSearchParams(locationSearch()).get("keywords")).toBe("github");

  pushState({}, "", "/connectors");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(screen.getByPlaceholderText("Find connectors")).toHaveValue("");
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
    expect(queryConnectorCard("Axiom")).toBeInTheDocument();
  });

  await fill(screen.getByPlaceholderText("Find connectors"), "missing-service");
  await expect(
    screen.findByText(/No connectors matching/u),
  ).resolves.toBeInTheDocument();
});

test("Search the full connector catalog", async () => {
  mockConnectors(context, []);
  const github = publicStatusItem({ connectorSlug: "github", label: "GitHub" });
  const slack = publicStatusItem({ connectorSlug: "slack", label: "Slack" });
  const keywords: (string | undefined)[] = [];
  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      keywords.push(query.keyword);
      return respond(200, {
        connectors: query.keyword ? [slack] : [github],
        totalConnectorCount: 1234,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  await expect(screen.findByText("GitHub")).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Connect 1,234 services for your agents to use."),
  ).toBeInTheDocument();

  await fill(screen.getByPlaceholderText("Find connectors"), "Slack");

  await waitFor(() => {
    expect(queryConnectorCard("Slack")).toBeInTheDocument();
    expect(queryConnectorCard("GitHub")).not.toBeInTheDocument();
  });
  expect(keywords).toContain("Slack");
  expect(
    screen.getByText("Connect 1,234 services for your agents to use."),
  ).toBeInTheDocument();
});

test("Switch between built-in and custom connectors", async () => {
  mockCustomConnectorStory(context);
  await setupPage({ context, path: "/connectors?tab=custom" });
  const custom = await waitFor(() => {
    return getConnectorAction("tab", "Custom");
  });
  expect(custom).toHaveAttribute("aria-selected", "true");
  expect(new URLSearchParams(locationSearch()).get("tab")).toBe("custom");

  click(getConnectorAction("tab", "Built-in"));
  await waitFor(() => {
    expect(getConnectorAction("tab", "Built-in")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(new URLSearchParams(locationSearch()).has("tab")).toBeFalsy();
  });

  click(getConnectorAction("tab", "Custom"));
  await waitFor(() => {
    expect(getConnectorAction("tab", "Custom")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(new URLSearchParams(locationSearch()).get("tab")).toBe("custom");
  });
});

test("Present a connector with no accounts", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      description:
        "Connect your GitHub account to access repositories and GitHub features.",
      authMethods: [oauthMethod()],
      singleAuthCodeAuthMethodId: "oauth",
    }),
  ]);
  const oauthStarted = context.mocks.deferred<void>();
  mockOAuthCompletions(context);
  context.mocks.browser.open(context.mocks.browser.authWindow());
  context.mocks.api(connectorOauthStartContract.start, async ({ respond }) => {
    await oauthStarted.promise;
    return respond(200, {
      authorizationUrl: "https://oauth.test/github/authorize",
      oauthAttemptId: crypto.randomUUID(),
    });
  });
  await setupPage({
    context,
    path: "/connectors",
  });
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  expect(card).toHaveTextContent(
    "Connect your GitHub account to access repositories and GitHub features.",
  );
  expect(within(card).queryByText("No accounts")).not.toBeInTheDocument();
  expect(
    queryConnectorAction("button", "Manage GitHub access", card),
  ).toBeNull();
  const connect = await waitFor(() => {
    return getConnectorAction("button", "Connect GitHub");
  });

  click(connect);
  await expect(
    screen.findByRole("status", { name: "Connecting..." }),
  ).resolves.toBeVisible();
  expect(connect).toBeDisabled();
  expect(screen.queryByRole("dialog")).toBeNull();
  oauthStarted.resolve();
});

function shelfCategoryMetadata() {
  return {
    categories: [
      {
        id: "communication-collaboration",
        label: "Communication and Collaboration",
        menuLabel: "Communication",
        groupId: null,
      },
      {
        id: "ai-voice-audio",
        label: "Voice / Audio",
        menuLabel: "Voice and Audio",
        groupId: null,
      },
    ],
    groups: [],
  };
}

function shelfCatalog() {
  // Sixteen, so the category holds more than the twelve discovery returns for
  // it when no category is asked for by name.
  const mail = [
    "Gmail",
    "Outlook Mail",
    "Slack",
    "Microsoft Teams Bot",
    "Discord",
    "Telegram",
    "Lark",
    "Zendesk",
    "Intercom",
    "Mailchimp",
    "Resend",
    "Twilio",
    "Front",
    "Missive",
    "Crisp",
    "Help Scout",
  ].map((label, index) => {
    return publicStatusItem({
      connectorSlug: `mail-${index}` as ConnectorSlug,
      label,
      category: "communication-collaboration",
      popularityRank: index,
      connected: false,
    });
  });
  return [
    ...mail,
    publicStatusItem({
      connectorSlug: "voice-0" as ConnectorSlug,
      label: "ElevenLabs",
      category: "ai-voice-audio",
      popularityRank: 40,
      connected: false,
    }),
  ];
}

test("Browse the catalog as shelves, then enter a category and come back", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, shelfCatalog(), shelfCategoryMetadata(), {
    "communication-collaboration": 327,
    "ai-voice-audio": 50,
  });
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  // Six per shelf, closed by the products it stands for rather than a count.
  await waitFor(() => {
    expect(screen.getByText(/^See .* and 321 more$/u)).toBeVisible();
  });
  expect(
    screen.getByTestId("connector-shelf-communication-collaboration"),
  ).toBeInTheDocument();

  // Status has no control: the page already opens on what is connected. The
  // agent list is gone from the filter too -- that question is answered on the
  // connector's own card.
  expect(screen.queryByRole("radio", { name: "Not connected" })).toBeNull();
  expect(screen.queryByLabelText("Filter connectors")).toBeInTheDocument();

  // A category is a place: entering it filters the page and leaves a way back.
  await click(screen.getByText(/^See .* and 321 more$/u));
  await waitFor(() => {
    expect(locationSearch()).toContain("category=communication-collaboration");
  });
  expect(
    screen.queryByTestId("connector-shelf-communication-collaboration"),
  ).toBeNull();
  expect(getConnectorCard("Zendesk")).toBeInTheDocument();

  // Entering a category asks the API for that category, so the view holds all
  // of it -- the count on the way in is a promise the page has to keep.
  // All sixteen, not the twelve the unfiltered response slices per category:
  // the count offered on the way in is a promise this view has to keep.
  expect(screen.getAllByTestId("connector-card-label")).toHaveLength(16);
  expect(screen.queryByTestId("connector-category-grid")).toBeInTheDocument();

  const back = queryAllByRoleFast("button").find((element) => {
    return element.textContent === "Discover";
  });
  await click(back!);
  await waitFor(() => {
    expect(locationSearch()).not.toContain("category=");
  });
  expect(
    screen.getByTestId("connector-shelf-communication-collaboration"),
  ).toBeInTheDocument();
});

test("Keep every category in the filter while one of them is open", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, shelfCatalog(), shelfCategoryMetadata(), {
    "communication-collaboration": 327,
    "ai-voice-audio": 50,
  });
  await setupPage({
    context,
    path: "/connectors?category=communication-collaboration",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  await waitFor(() => {
    expect(getConnectorCard("Zendesk")).toBeInTheDocument();
  });

  // Inside a category the response carries only that category. The filter
  // describes the catalog, not the response, or it becomes a dead end: the
  // only way back out would be the breadcrumb.
  await click(screen.getByLabelText("Filter connectors"));
  const menu = await screen.findByRole("menu");
  const options = queryAllByRoleFast("menuitem", menu).map((item) => {
    return item.textContent;
  });
  expect(options).toContain("All");
  expect(
    options.some((option) => {
      return option?.startsWith("Voice");
    }),
  ).toBeTruthy();
});

function connectedShelfCatalog() {
  return shelfCatalog().map((connector) => {
    return connector.slug === "mail-0" || connector.slug === "mail-1"
      ? {
          ...connector,
          connected: true,
          connectionStatus: "connected" as const,
          connection: {
            authMethod: "oauth" as const,
            externalUsername: "octocat",
            externalEmail: null,
            reconnectReason: null,
          },
        }
      : connector;
  });
}

test("Land on Discover, then switch to the connectors this workspace has", async () => {
  mockConnectors(context, [
    { connectorSlug: "mail-0" as ConnectorSlug },
    { connectorSlug: "mail-1" as ConnectorSlug },
  ]);
  mockPublicConnectorStatus(
    context,
    connectedShelfCatalog(),
    shelfCategoryMetadata(),
    { "communication-collaboration": 327, "ai-voice-audio": 50 },
  );
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  // Discovery leads: the catalog is what a visit is usually for, and the
  // connectors this workspace has are counted rather than listed twice.
  await waitFor(() => {
    expect(
      screen.getByTestId("connector-shelf-communication-collaboration"),
    ).toBeInTheDocument();
  });
  const mine = screen.getByTestId("connectors-scope-mine");
  expect(mine).toHaveTextContent("Your connectors2");
  expect(screen.queryByTestId("connectors-mine-grid")).toBeNull();

  // A connector this workspace already has is still an answer to "what talks
  // to mail", so it stays on the shelf -- without an add affordance.
  const head = screen.getByTestId("connector-shelf-head");
  expect(within(head).getByTestId("connector-card-label")).toHaveTextContent(
    "Gmail",
  );
  expect(queryConnectorAction("button", "Connect Gmail")).toBeNull();
  // Category is the dimension that organises the catalog, so it owns the filter.
  expect(screen.getByLabelText("Filter connectors")).toHaveTextContent(
    "Filter: All",
  );

  await click(mine);
  await waitFor(() => {
    expect(locationSearch()).toContain("scope=mine");
  });

  // The other scope is the connected ones alone, and its dimension is the
  // agent -- one control in the slot, never two.
  const grid = await screen.findByTestId("connectors-mine-grid");
  expect(within(grid).getAllByTestId("connector-card-label")).toHaveLength(2);
  expect(
    screen.queryByTestId("connector-shelf-communication-collaboration"),
  ).toBeNull();
  expect(screen.getByLabelText("Filter connectors")).toHaveTextContent(
    "Filter: All agents",
  );
  await click(screen.getByLabelText("Filter connectors"));
  const menu = await screen.findByRole("menu");
  const options = queryAllByRoleFast("menuitem", menu).map((item) => {
    return item.textContent;
  });
  expect(options).toContain("All agents");
  expect(options).not.toContain("Not connected");
});

test("Leaving a category with the scope control drops the category with it", async () => {
  mockConnectors(context, [{ connectorSlug: "mail-0" as ConnectorSlug }]);
  mockPublicConnectorStatus(
    context,
    connectedShelfCatalog(),
    shelfCategoryMetadata(),
    { "communication-collaboration": 327, "ai-voice-audio": 50 },
  );
  await setupPage({
    context,
    path: "/connectors?category=communication-collaboration",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  await waitFor(() => {
    expect(getConnectorCard("Zendesk")).toBeInTheDocument();
  });

  // A category belongs to the scope it was opened in: carrying it across would
  // filter the connectors you own by a dimension that does not organise them.
  await click(screen.getByTestId("connectors-scope-mine"));
  await waitFor(() => {
    expect(locationSearch()).toContain("scope=mine");
  });
  expect(locationSearch()).not.toContain("category=");
});

test("Warn on the scope control when a connection this workspace owns needs a reconnect", async () => {
  mockConnectors(context, [
    {
      connectorSlug: "mail-0" as ConnectorSlug,
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    },
  ]);
  mockPublicConnectorStatus(
    context,
    connectedShelfCatalog(),
    shelfCategoryMetadata(),
    { "communication-collaboration": 327, "ai-voice-audio": 50 },
  );
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  // The list is behind a control, so the control has to carry the one thing a
  // count cannot say: something in there stopped working.
  await expect(
    screen.findByLabelText("Needs attention"),
  ).resolves.toBeInTheDocument();
});

test("Find the connectors no agent is using", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000011";
  mockConnectors(context, [
    { connectorSlug: "mail-0" as ConnectorSlug },
    { connectorSlug: "mail-1" as ConnectorSlug },
  ]);
  context.mocks.data.agents([listAgent(researchId, "Research", "preset:0")]);
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledConnectorSlugs: params.id === researchId ? ["mail-0"] : [],
    });
  });
  mockPublicConnectorStatus(
    context,
    connectedShelfCatalog(),
    shelfCategoryMetadata(),
    { "communication-collaboration": 327, "ai-voice-audio": 50 },
  );
  await setupPage({
    context,
    path: "/connectors?scope=mine",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  await waitFor(() => {
    expect(getConnectorCard("Gmail")).toBeInTheDocument();
  });
  expect(queryConnectorCard("Outlook Mail")).toBeInTheDocument();

  // A connector nobody uses is the one worth finding in your own list, and it
  // is the question the agent dimension cannot ask agent by agent.
  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "Not shared with any agent"));
  await waitFor(() => {
    expect(queryConnectorCard("Gmail")).toBeNull();
  });
  expect(getConnectorCard("Outlook Mail")).toBeInTheDocument();
  expect(new URLSearchParams(locationSearch()).get("connection")).toBe(
    "unshared",
  );
});
