import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  httpConnector,
  ACME_CONNECTOR_ID,
  installComposerConnectorFixture,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GITHUB_SLUG = "github" as ConnectorSlug;
const GMAIL_SLUG = "gmail" as ConnectorSlug;
const NOTION_SLUG = "notion" as ConnectorSlug;

test("Browse builtin MCP separately and explain independent tool access", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: "clickup", label: "ClickUp", connected: false }),
      builtinConnector({
        slug: "clickup-mcp",
        label: "ClickUp",
        protocol: "mcp",
        connected: true,
      }),
    ],
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: true,
      [FeatureSwitchKey.BuiltinConnectorMcp]: true,
    },
  });
  const dialog = await openDirectory(user);
  await expect(
    within(dialog).findByText("ClickUp · HTTP API"),
  ).resolves.toBeVisible();
  const mcp = queryAllByRoleFast("tab", dialog).find((tab) => {
    return tab.textContent === "MCP";
  });
  if (!mcp) {
    throw new Error("Expected MCP protocol control");
  }
  await user.click(mcp);
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "ClickUp",
  );
  await expect(
    within(dialog).findByText("ClickUp · MCP"),
  ).resolves.toBeVisible();
  expect(
    within(dialog).queryByText("ClickUp · HTTP API"),
  ).not.toBeInTheDocument();
  await user.click(dialogButton(dialog, "Open ClickUp · MCP details"));
  await expect(
    within(dialog).findByText(
      "Agent access applies to all tools exposed by this MCP server. HTTP API connector permissions are managed separately.",
    ),
  ).resolves.toBeVisible();
  expect(
    queryAllByRoleFast("button", dialog).some((button) => {
      return button.textContent === "Configure";
    }),
  ).toBeFalsy();
});

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
