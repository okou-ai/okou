import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  connectorAccount,
  noAuthMethod,
  httpConnector,
  ACME_CONNECTOR_ID,
  installComposerConnectorFixture,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

test("Show builtin tool service details without HTTP permission controls", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: [
      {
        ...builtinConnector({
          slug: "public-mcp",
          label: "Public Tools",
          connected: true,
          authMethods: [noAuthMethod()],
          popularityRank: 0,
        }),
        mcp: {
          transport: "streamable-http",
          endpoint: "https://public.example.test/mcp",
        },
      },
    ],
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  const dialog = await openDirectory(user);
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "public",
  );
  await expect(
    within(dialog).findByText("Public Tools"),
  ).resolves.toBeInTheDocument();
  click(dialogButton(dialog, "Open Public Tools details"));
  await expect(
    within(dialog).findByRole("heading", { name: "Public Tools" }),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Permissions")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", dialog).some((button) => {
      return button.textContent?.trim() === "Configure";
    }),
  ).toBeFalsy();
});

const GITHUB_SLUG = "github" as ConnectorSlug;
const GMAIL_SLUG = "gmail" as ConnectorSlug;
const NOTION_SLUG = "notion" as ConnectorSlug;

function directoryCatalog() {
  // Discovery ranks what it returns, so a fixture without ranks would describe
  // a response the API does not produce.
  return [
    builtinConnector({
      slug: GITHUB_SLUG,
      label: "GitHub",
      connected: true,
      popularityRank: 0,
    }),
    builtinConnector({
      slug: GMAIL_SLUG,
      label: "Gmail",
      connected: false,
      tags: ["email", "inbox"],
      hasPermissions: true,
      popularityRank: 1,
    }),
    builtinConnector({
      slug: NOTION_SLUG,
      label: "Notion",
      connected: false,
      popularityRank: 2,
    }),
  ];
}

function dialogButton(dialog: HTMLElement, name: string): HTMLElement {
  const match = queryAllByRoleFast("button", dialog).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
  if (!match) {
    throw new Error(`Expected a button named "${name}" in the dialog`);
  }
  return match;
}

async function openDirectory(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
  await user.click(await findFastControl("button", "Connectors"));
  await user.click(await findFastControl("button", "Add connectors"));
  const dialog = await screen.findByRole("dialog", { name: "Connectors" });
  return dialog;
}

function createAuthWindow() {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  return authWindow;
}

test("Keep connection progress on the active card and allow another connector after cancellation", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });
  const gmailWindow = createAuthWindow();
  const gmailOpen = context.mocks.browser.open(gmailWindow);
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await expect(
    within(dialog).findByText("Notion"),
  ).resolves.toBeInTheDocument();
  const gmail = dialogButton(dialog, "Connect Gmail");
  const notion = dialogButton(dialog, "Connect Notion");
  click(gmail);
  await waitFor(() => {
    expect(gmailWindow.location.href).toBe(
      "https://accounts.example.test/gmail",
    );
  });
  expect(
    within(gmail).getByRole("status", { name: "Connecting..." }),
  ).toBeInTheDocument();
  expect(gmail).toHaveAttribute("aria-busy", "true");
  expect(notion).not.toHaveAttribute("aria-busy", "true");
  expect(within(notion).queryByRole("status")).not.toBeInTheDocument();
  expect(notion).toBeDisabled();

  click(gmail);
  click(notion);
  expect(gmailOpen.calls).toHaveLength(1);

  await fill(within(dialog).getByRole("textbox"), "g");
  await expect(
    within(dialog).findByText("GitHub"),
  ).resolves.toBeInTheDocument();
  const github = dialogButton(dialog, "Open GitHub details");
  expect(github).not.toHaveAttribute("aria-busy", "true");
  expect(within(github).queryByRole("status")).not.toBeInTheDocument();
  expect(
    within(dialog).getAllByRole("status", { name: "Connecting..." }),
  ).toHaveLength(1);

  gmailWindow.close();
  await waitFor(() => {
    expect(dialogButton(dialog, "Connect Gmail")).toBeEnabled();
  });
  expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
  expect(dialogButton(dialog, "Connect Gmail")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );

  await fill(within(dialog).getByRole("textbox"), "");
  await expect(
    within(dialog).findByText("Notion"),
  ).resolves.toBeInTheDocument();
  const notionWindow = createAuthWindow();
  const notionOpen = context.mocks.browser.open(notionWindow);
  click(dialogButton(dialog, "Connect Notion"));
  await waitFor(() => {
    expect(notionWindow.location.href).toBe(
      "https://accounts.example.test/notion",
    );
  });
  expect(
    within(dialogButton(dialog, "Connect Notion")).getByRole("status", {
      name: "Connecting...",
    }),
  ).toBeInTheDocument();
  expect(dialogButton(dialog, "Connect Notion")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(dialogButton(dialog, "Connect Gmail")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(
    within(dialogButton(dialog, "Connect Gmail")).queryByRole("status"),
  ).not.toBeInTheDocument();
  expect(notionOpen.calls).toHaveLength(1);

  notionWindow.close();
  await waitFor(() => {
    expect(dialogButton(dialog, "Connect Notion")).toBeEnabled();
  });
  expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
});

test("Clear the active card after OAuth startup fails and allow retry", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });
  const startup = context.mocks.deferred<void>();
  let startupAvailable = false;
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    async ({ params, respond }) => {
      await startup.promise;
      return startupAvailable
        ? respond(200, {
            authorizationUrl: `https://accounts.example.test/${params.connectorSlug}`,
            oauthAttemptId: "e0000000-0000-4000-a000-000000000095",
            connectionId: "f0000000-0000-4000-a000-000000000095",
          })
        : respond(500, {
            error: {
              code: "UNAVAILABLE",
              message: "OAuth authorization is unavailable",
            },
          });
    },
  );
  const failedWindow = createAuthWindow();
  context.mocks.browser.open(failedWindow);
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await expect(within(dialog).findByText("Gmail")).resolves.toBeInTheDocument();
  click(dialogButton(dialog, "Connect Gmail"));
  await expect(
    within(dialogButton(dialog, "Connect Gmail")).findByRole("status", {
      name: "Connecting...",
    }),
  ).resolves.toBeInTheDocument();
  startup.resolve();
  await expect(
    screen.findByText("OAuth authorization is unavailable"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(dialogButton(dialog, "Connect Gmail")).toBeEnabled();
  });
  expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
  expect(dialogButton(dialog, "Connect Gmail")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(dialogButton(dialog, "Connect Notion")).toBeEnabled();
  expect(failedWindow.location.href).toContain("status=error");

  startupAvailable = true;
  const retryWindow = createAuthWindow();
  const browserOpen = context.mocks.browser.open(retryWindow);
  click(dialogButton(dialog, "Connect Gmail"));
  await waitFor(() => {
    expect(retryWindow.location.href).toBe(
      "https://accounts.example.test/gmail",
    );
  });
  expect(
    within(dialogButton(dialog, "Connect Gmail")).getByRole("status", {
      name: "Connecting...",
    }),
  ).toBeInTheDocument();
  expect(browserOpen.calls).toHaveLength(1);
  retryWindow.close();
  await waitFor(() => {
    expect(dialogButton(dialog, "Connect Gmail")).toBeEnabled();
  });
});

test.each(["oauth", "no-auth"] as const)(
  "Keep only the connected card busy until current-agent authorization finishes (%s)",
  async (grant) => {
    const user = userEvent.setup({ delay: null });
    const catalog = [
      ...directoryCatalog(),
      ...["Dropbox", "Lark", "Telegram"].map((label, index) => {
        return builtinConnector({
          slug: label.toLowerCase() as ConnectorSlug,
          label,
          connected: false,
          popularityRank: index + 3,
        });
      }),
    ].map((connector) => {
      return connector.slug === GMAIL_SLUG && grant === "no-auth"
        ? builtinConnector({ ...connector, authMethods: [noAuthMethod()] })
        : connector;
    });
    const fixture = installComposerConnectorFixture({ catalog });
    const account = connectorAccount({
      id: "f0000000-0000-4000-a000-000000000064",
      target: { kind: "builtin", connectorSlug: GMAIL_SLUG },
      displayName: "Work",
      isDefault: true,
    });
    let oauthCompleted = false;
    if (grant === "oauth") {
      context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
        return respond(200, {
          connectors: catalog.map((connector) => {
            return oauthCompleted && connector.slug === GMAIL_SLUG
              ? {
                  ...connector,
                  connected: true,
                  connectionStatus: "connected" as const,
                  connection: {
                    id: account.id,
                    authMethod: account.authMethod,
                    externalUsername: null,
                    externalEmail: null,
                    reconnectReason: null,
                  },
                }
              : connector;
          }),
          totalConnectorCount: catalog.length,
        });
      });
    }
    const authorizationStarted = context.mocks.deferred<void>();
    const authorization = context.mocks.deferred<void>();
    let authorized = false;
    context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledConnectorSlugs: authorized ? [GMAIL_SLUG] : [],
      });
    });
    context.mocks.api(
      userBuiltinConnectorsContract.update,
      async ({ body, respond }) => {
        authorizationStarted.resolve();
        await authorization.promise;
        authorized = true;
        return respond(200, {
          enabledConnectorSlugs: body.enabledConnectorSlugs,
        });
      },
    );
    const authWindow = createAuthWindow();
    const browserOpen = context.mocks.browser.open(authWindow);
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
    });

    const dialog = await openDirectory(user);
    await expect(
      within(dialog).findByTestId("connector-shelf-productivity"),
    ).resolves.toBeInTheDocument();
    click(dialogButton(dialog, "Connect Gmail"));
    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        grant === "oauth" ? "https://accounts.example.test/gmail" : "",
      );
    });
    if (grant === "oauth") {
      oauthCompleted = true;
      context.mocks.data.connectors([{ ...account, slug: GMAIL_SLUG }]);
      fixture.completeOAuth(account.id);
      authWindow.close();
    }
    await authorizationStarted.promise;

    // A refreshed catalog now reports Gmail as connected. Keep its progress
    // visible in the default browse while authorizing the current agent.
    const gmail = await waitFor(() => {
      const card = dialogButton(dialog, "Open Gmail details");
      expect(card).toHaveAttribute("aria-busy", "true");
      return card;
    });
    expect(
      within(dialog).getByTestId("connector-shelf-productivity"),
    ).toBeInTheDocument();
    expect(
      within(gmail).getByRole("status", { name: "Connecting..." }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getAllByRole("status", { name: "Connecting..." }),
    ).toHaveLength(1);
    expect(dialogButton(dialog, "Connect Notion")).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(dialogButton(dialog, "Connect Notion")).toBeDisabled();
    expect(
      screen.queryByText("Gmail connected and authorized for Scout"),
    ).not.toBeInTheDocument();

    authorization.resolve();
    await expect(
      screen.findByText("Gmail connected and authorized for Scout"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Connectors" }),
      ).not.toBeInTheDocument();
    });
    expect(browserOpen.calls).toHaveLength(grant === "oauth" ? 1 : 0);
  },
);

test("Offer the catalog for adding, and find a connected connector by name", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  // The composer's connector popover already lists what is connected, so the
  // directory opens on what can be added and does not repeat GitHub.
  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByText("Notion")).toBeVisible();
  });
  expect(within(dialog).queryByText("GitHub")).not.toBeInTheDocument();

  // Searching for it must still answer, or the search reads as "we do not have
  // GitHub" for a connector the user already connected.
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "github",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("GitHub")).toBeVisible();
  });
  expect(
    within(dialog).getByRole("heading", { name: "Connected" }),
  ).toBeVisible();
});

test("Find a connector by a tag that is not in its name", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "email",
  );

  await waitFor(() => {
    expect(within(dialog).getByText("Gmail")).toBeVisible();
  });
  expect(within(dialog).queryByText("Notion")).not.toBeInTheDocument();
});

test("Open connector detail and step back to the list", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: directoryCatalog(),
    customConnectors: [
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        connected: false,
      }),
    ],
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "github",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("GitHub")).toBeVisible();
  });
  await user.click(dialogButton(dialog, "Open GitHub details"));

  await waitFor(() => {
    expect(
      within(dialog).getByRole("heading", { name: "GitHub" }),
    ).toBeVisible();
  });
  expect(within(dialog).getByText("Connection")).toBeVisible();

  await user.click(dialogButton(dialog, "Back"));
  await waitFor(() => {
    expect(
      within(dialog).getByRole("heading", { name: "Connected" }),
    ).toBeVisible();
  });
});

test("Keep the existing dialog when the directory switch is off", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
  await user.click(await findFastControl("button", "Connectors"));
  await user.click(await findFastControl("button", "Add connectors"));

  await expect(
    screen.findByRole("dialog", { name: /Available connectors/u }),
  ).resolves.toBeInTheDocument();
});

test("Keep the category chips the same width when the selection moves", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByText("Notion")).toBeVisible();
  });

  // A chip that changes font weight on selection changes its own width, which
  // shifts every chip after it. Every chip has to carry the same weight.
  const chips = Array.from(
    dialog.querySelectorAll<HTMLElement>("[data-connector-category-chip]"),
  );
  expect(chips.length).toBeGreaterThan(1);
  const weights = new Set(
    chips.map((element) => {
      return (
        element.className.split(/\s+/u).find((token) => {
          return token.startsWith("font-");
        }) ?? "none"
      );
    }),
  );
  expect(weights.size).toBe(1);
  expect(weights).not.toContain("none");
});

function rankedCatalog() {
  // Four ranked connectors earn "mail" a shelf; "voice" has one, so it stays a
  // counted chip rather than opening on the alphabet.
  return [
    // Sixteen, so the category holds more than the twelve a keyword-free
    // browse response returns for it.
    ...[
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
      return builtinConnector({
        slug: `mail-${index}` as ConnectorSlug,
        label,
        connected: false,
        category: "mail",
        popularityRank: index,
      });
    }),
    builtinConnector({
      slug: "voice-0" as ConnectorSlug,
      label: "ElevenLabs",
      connected: false,
      category: "voice",
      popularityRank: 40,
    }),
    builtinConnector({
      slug: "voice-1" as ConnectorSlug,
      label: "3Scribe",
      connected: false,
      category: "voice",
    }),
  ];
}

test("Close a shelf with the products behind it, and open that category", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: rankedCatalog(),
    categoryConnectorCounts: { mail: 327, voice: 50 },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByTestId("connector-shelf-mail")).toBeVisible();
  });

  // A count alone says nothing to someone who does not know the product names,
  // so the closing cell has to name what it stands for.
  const tail = dialogButton(dialog, "See Telegram, Lark and 323 more");
  expect(tail).toBeVisible();

  // A category with one ranked connector cannot fill a shelf and is offered as
  // a chip instead.
  expect(within(dialog).queryByTestId("connector-shelf-voice")).toBeNull();
  expect(within(dialog).getByText("More categories")).toBeVisible();

  await user.click(tail);
  await waitFor(() => {
    expect(within(dialog).queryByTestId("connector-shelf-mail")).toBeNull();
  });
  expect(within(dialog).getByText("Zendesk")).toBeVisible();
});

test("Show a connector on one shelf only", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: rankedCatalog(),
    categoryConnectorCounts: { mail: 327, voice: 50 },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByTestId("connector-shelf-head")).toBeVisible();
  });

  // Gmail leads the head shelf, so its own category has to start below it
  // instead of repeating the same card two sections apart.
  expect(within(dialog).getAllByText("Gmail")).toHaveLength(1);
});

test("List the catalog when it is too small for any category to fill a shelf", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByText("Notion")).toBeVisible();
  });

  // Shelves need something to shelve. With two unconnected connectors no
  // category earns one, and the reader must still get the catalog rather than
  // an empty sheet.
  expect(dialog.querySelector("[data-testid^='connector-shelf-']")).toBeNull();
  expect(within(dialog).getByText("Gmail")).toBeVisible();
});

test("Count the whole category on a chip, not the slice discovery returned", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: rankedCatalog(),
    categoryConnectorCounts: { mail: 329, voice: 50 },
    categoryMetadata: {
      categories: [
        {
          id: "mail",
          label: "Communication and Collaboration",
          menuLabel: "Communication",
          groupId: null,
        },
      ],
      groups: [],
    },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await waitFor(() => {
    expect(within(dialog).getByTestId("connector-shelf-mail")).toBeVisible();
  });

  // The chip stands for the category, so it has to carry the catalog's own
  // name and the server's total -- not a name derived from the id and the ten
  // connectors this response happened to include.
  const chips = Array.from(
    dialog.querySelectorAll<HTMLElement>("[data-connector-category-chip]"),
  ).map((element) => {
    return element.textContent;
  });
  expect(chips).toContain("Communication329");
  expect(
    within(dialog).getByRole("heading", {
      name: "Communication and Collaboration",
    }),
  ).toBeVisible();
});

test("Show the whole category the chip counted, not the browse slice", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: rankedCatalog(),
    categoryConnectorCounts: { mail: 16, voice: 50 },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  const chip = await waitFor(() => {
    const match = Array.from(
      dialog.querySelectorAll<HTMLElement>("[data-connector-category-chip]"),
    ).find((element) => {
      return element.textContent === "Mail16";
    });
    if (!match) {
      throw new Error("Expected the Mail category chip to count sixteen");
    }
    return match;
  });

  // The chip says sixteen, so entering it has to show sixteen -- a browse
  // response carries at most twelve of any one category.
  await user.click(chip);
  await waitFor(() => {
    expect(within(dialog).getByText("Help Scout")).toBeVisible();
  });
  expect(within(dialog).getAllByTestId("connector-card-label")).toHaveLength(
    16,
  );

  // The chip row still offers every category, so the reader can pick another.
  expect(
    Array.from(
      dialog.querySelectorAll<HTMLElement>("[data-connector-category-chip]"),
    ).map((element) => {
      return element.textContent;
    }),
  ).toContain("Voice50");
});

async function tabToCard(
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
): Promise<void> {
  for (let step = 0; step < 30; step += 1) {
    await user.keyboard("{Tab}");
    if (document.activeElement === card) {
      return;
    }
  }
  throw new Error(
    `Could not reach ${card.getAttribute("aria-label")} with Tab`,
  );
}

test("Keep search editing and composition separate from connector actions", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });
  const browserOpen = context.mocks.browser.open();
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  const search = within(dialog).getByRole<HTMLInputElement>("textbox");
  await user.type(search, "gm");
  await expect(within(dialog).findByText("Gmail")).resolves.toBeInTheDocument();
  await user.keyboard("{ArrowLeft}");
  expect(search.selectionStart).toBe(1);
  await user.keyboard("{ArrowRight}{ArrowDown}{ArrowUp}{Enter}");
  expect(search).toHaveFocus();
  expect(search).toHaveValue("gm");
  expect(search.selectionStart).toBe(2);

  fireEvent.compositionStart(search);
  fireEvent.keyDown(search, { key: "Enter", code: "Enter", isComposing: true });
  fireEvent.compositionEnd(search, { data: "gm" });
  expect(search).toHaveFocus();
  expect(dialogButton(dialog, "Connect Gmail")).toBeEnabled();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(browserOpen.calls).toHaveLength(0);
});

test("Move real focus within connector cards and use Tab to leave the group", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });
  const browserOpen = context.mocks.browser.open();
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await expect(
    within(dialog).findByText("Notion"),
  ).resolves.toBeInTheDocument();
  const gmail = dialogButton(dialog, "Connect Gmail");
  const notion = dialogButton(dialog, "Connect Notion");
  const group = within(dialog).getByRole("toolbar", { name: "2 matches" });
  await tabToCard(user, gmail);
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(notion).toHaveFocus();
  });
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(gmail).toHaveFocus();
  });
  await user.keyboard("{ArrowUp}");
  await waitFor(() => {
    expect(notion).toHaveFocus();
  });

  await user.keyboard("{Tab}");
  expect(group.contains(document.activeElement)).toBeFalsy();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(notion).toHaveFocus();
  expect(browserOpen.calls).toHaveLength(0);
});

test.each(["{Enter}", " "])(
  "Open one provider authorization window from a focused card with %s",
  async (key) => {
    const user = userEvent.setup({ delay: null });
    installComposerConnectorFixture({ catalog: directoryCatalog() });
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      configurable: true,
      value: { href: "" },
    });
    const browserOpen = context.mocks.browser.open(authWindow);
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
    });

    const dialog = await openDirectory(user);
    await expect(
      within(dialog).findByText("Gmail"),
    ).resolves.toBeInTheDocument();
    const gmail = dialogButton(dialog, "Connect Gmail");
    await tabToCard(user, gmail);
    await user.keyboard(key);
    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://accounts.example.test/gmail",
      );
    });
    await waitFor(() => {
      expect(gmail).toBeDisabled();
    });
    expect(dialogButton(dialog, "Connect Notion")).toBeDisabled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByRole("textbox")).toBeInTheDocument();
    expect(browserOpen.calls).toHaveLength(1);
    click(within(dialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(authWindow.closed).toBeTruthy();
    });
  },
);

test("Enter the remaining connected card after filtering through an empty result", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await expect(
    within(dialog).findByText("Notion"),
  ).resolves.toBeInTheDocument();
  await tabToCard(user, dialogButton(dialog, "Connect Gmail"));
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(dialogButton(dialog, "Connect Notion")).toHaveFocus();
  });

  const search = within(dialog).getByRole("textbox");
  await user.click(search);
  await fill(search, "nonexistent connector");
  await expect(
    within(dialog).findByText(/No connector matches/u),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(search).toHaveFocus();
  await fill(search, "github");
  await expect(
    within(dialog).findByText("GitHub"),
  ).resolves.toBeInTheDocument();
  await tabToCard(user, dialogButton(dialog, "Open GitHub details"));
  await user.keyboard(" ");
  await expect(
    within(dialog).findByRole("heading", { name: "GitHub" }),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Connection")).toBeInTheDocument();
});

test("Keep attention-card navigation inside its own action group", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: [
      ...[GITHUB_SLUG, NOTION_SLUG].map((slug) => {
        return {
          ...builtinConnector({ slug, label: slug, connected: true }),
          scopeMismatch: true,
          connectionStatus: "scope-mismatch" as const,
        };
      }),
      builtinConnector({ slug: GMAIL_SLUG, label: "Gmail", connected: false }),
    ],
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  const attention = await within(dialog).findByRole("toolbar", {
    name: "Needs attention",
  });
  const github = dialogButton(attention, "Open github details");
  const notion = dialogButton(attention, "Open notion details");
  await tabToCard(user, github);
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(notion).toHaveFocus();
  });
  await user.keyboard("{Tab}");
  expect(dialogButton(dialog, "Connect Gmail")).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(notion).toHaveFocus();
  await user.keyboard("{Enter}");
  await expect(
    within(dialog).findByRole("heading", { name: "notion" }),
  ).resolves.toBeInTheDocument();
});

test("Keep remote access results outside connector action navigation", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await fill(within(dialog).getByRole("textbox"), "ssh");
  const remoteAccess = await within(dialog).findByRole("heading", {
    name: "Remote access",
  });
  expect(remoteAccess).toBeInTheDocument();
  const manageSsh = queryAllByRoleFast("link", dialog).find((link) => {
    return link.getAttribute("aria-label") === "Manage SSH hosts";
  });
  expect(manageSsh).toHaveAttribute("href", "/connectors/ssh?add=1");
  expect(within(dialog).queryByRole("toolbar")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText(/No connector matches/u),
  ).not.toBeInTheDocument();
});

test("Keep the remaining card reachable when a nonempty result list shrinks", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: directoryCatalog() });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });

  const dialog = await openDirectory(user);
  await expect(
    within(dialog).findByText("Notion"),
  ).resolves.toBeInTheDocument();
  await tabToCard(user, dialogButton(dialog, "Connect Gmail"));
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(dialogButton(dialog, "Connect Notion")).toHaveFocus();
  });

  const search = within(dialog).getByRole("textbox");
  await user.click(search);
  await fill(search, "gm");
  await expect(
    within(dialog).findByRole("toolbar", { name: "1 match" }),
  ).resolves.toBeInTheDocument();
  await tabToCard(user, dialogButton(dialog, "Connect Gmail"));
  expect(dialogButton(dialog, "Connect Gmail")).toHaveFocus();
});
