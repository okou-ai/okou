import { catalogFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000030";
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000031";
const IDEAS_PATH = `/agents/${AGENT_ID}/ideas`;

const STANDUP_PROMPT =
  "Set up a daily standup report that pulls data from GitHub, Sentry, Axiom, and Plausible every morning, generates a pptx, and posts it to #team-updates";

const REVENUECAT_PROMPT =
  "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes";

function agentFixture(): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    description: "Helps turn ideas into work",
    displayName: "Research Agent",
    sound: null,
    avatarUrl: null,
    visibility: "public",
  };
}

function catalogItem(
  slug: ConnectorSlug,
  label: string,
): PublicConnectorCatalogStatusItem {
  return catalogFixture({
    slug,
    label,
    description: `${label} test connector`,
    icon: {
      url: `https://icons.example.test/${slug}.svg`,
      invertInDarkMode: slug === "github",
    },
    category: "test",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: "Sign in to grant access.",
        grantKind: "auth-code",
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  });
}

function catalogResponse(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): PublicConnectorCatalogStatusResponse {
  return { connectors: [...connectors] };
}

function configureAgent(): void {
  context.mocks.data.agents([agentFixture()]);
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
}

function mockCatalog(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, catalogResponse(connectors));
  });
}

async function findComposer(name = "Message"): Promise<HTMLElement> {
  return await screen.findByRole("textbox", { name });
}

test("The breadcrumb links back to the Agent chat", async () => {
  configureAgent();
  mockCatalog([]);

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByText("Browser screenshots");
  const breadcrumb = screen.getAllByRole("navigation").find((nav) => {
    return nav.textContent === "Chat/Ideas & Use Cases";
  });
  if (!breadcrumb) {
    throw new Error("Expected the ideas page breadcrumb");
  }
  const back = queryAllByRoleFast("link", breadcrumb).find((link) => {
    return link.textContent === "Chat";
  });
  if (!back) {
    throw new Error("Expected the breadcrumb link back to the chat");
  }
  click(back);

  await findComposer();
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
});

function configureWorkspaceAgents(): void {
  context.mocks.data.agents([
    {
      ...agentFixture(),
      agentId: DEFAULT_AGENT_ID,
      isDefaultAgent: true,
      displayName: "Okou",
    },
    agentFixture(),
  ]);
  context.mocks.data.onboardingStatus({ defaultAgentId: DEFAULT_AGENT_ID });
}

test("A custom Agent can start the instruction self-management example", async () => {
  configureWorkspaceAgents();
  mockCatalog([]);

  await setupPage({ context, path: IDEAS_PATH });
  const title = await screen.findByText("Self-update instructions");
  const idea = queryAllByRoleFast("link", screen.getByRole("main")).find(
    (link) => {
      return link.contains(title);
    },
  );
  if (!idea) {
    throw new Error("Expected the custom Agent instruction example link");
  }
  click(idea);

  const composer = await findComposer();
  await waitFor(() => {
    expect(composer.textContent).toBe(
      "Update yourself: add the following instructions — ...",
    );
  });
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
});

test.each([
  { path: "/ideas", destination: "/", targetAgent: DEFAULT_AGENT_ID },
  {
    path: IDEAS_PATH,
    destination: `/agents/${AGENT_ID}/chat`,
    targetAgent: AGENT_ID,
  },
])(
  "A card on $path exposes its prompt link and opens by keyboard",
  async ({ path, destination, targetAgent }) => {
    const user = userEvent.setup({ delay: null });
    context.mocks.data.agents([
      {
        ...agentFixture(),
        agentId: DEFAULT_AGENT_ID,
        isDefaultAgent: true,
        displayName: "General",
      },
      agentFixture(),
    ]);
    context.mocks.data.onboardingStatus({ defaultAgentId: DEFAULT_AGENT_ID });
    mockCatalog([
      catalogItem("github", "GitHub"),
      catalogItem("sentry", "Sentry"),
      catalogItem("axiom", "Axiom"),
      catalogItem("plausible", "Plausible"),
      catalogItem("slack", "Slack"),
    ]);

    await setupPage({ context, path });
    const search = await screen.findByLabelText("Search use cases");
    await fill(search, "Daily standup report");

    const title = await screen.findByText("Daily standup report");
    const idea = queryAllByRoleFast("link", screen.getByRole("main")).find(
      (link) => {
        return link.contains(title);
      },
    );
    if (!idea) {
      throw new Error("Expected the use-case card to expose a link");
    }
    expect(idea).toHaveAttribute(
      "href",
      `${destination}?${new URLSearchParams({ prompt: STANDUP_PROMPT })}`,
    );

    await user.keyboard("{Tab}");
    expect(idea).toHaveFocus();
    await user.keyboard("{Enter}");

    const composer = await findComposer();
    await waitFor(() => {
      expect(composer.textContent).toBe(STANDUP_PROMPT);
    });
    expect(pathname()).toBe(`/agents/${targetAgent}/chat`);
  },
);

test("Search for a use case and start it with the agent", async () => {
  configureAgent();
  mockCatalog([
    catalogItem("github", "GitHub"),
    catalogItem("sentry", "Sentry"),
    catalogItem("axiom", "Axiom"),
    catalogItem("plausible", "Plausible"),
    catalogItem("slack", "Slack"),
    catalogItem("revenuecat", "RevenueCat"),
    catalogItem("google-sheets", "Google Sheets"),
  ]);

  await setupPage({ context, path: IDEAS_PATH });
  const search = await screen.findByLabelText("Search use cases");

  await fill(search, "RevenueCat");

  const idea = await screen.findByText("RevenueCat subscription digest");
  expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

  click(idea);

  const composer = await findComposer();
  expect(composer.textContent).toBe(REVENUECAT_PROMPT);
});

test("Start the Zapier migration idea from the available connector catalog", async () => {
  configureAgent();
  mockCatalog([
    catalogItem("zapier", "Zapier"),
    catalogItem("slack", "Slack"),
    catalogItem("notion", "Notion"),
  ]);

  await setupPage({ context, path: IDEAS_PATH });
  await fill(await screen.findByLabelText("Search use cases"), "Zapier");
  click(await screen.findByText("Zapier → Okou migration"));

  const composer = await findComposer();
  expect(composer.textContent).toBe(
    "Help me migrate my Zapier workflows to Okou. I have zaps for: new Slack message → Notion, Gmail → Google Sheets, and GitHub PR → Slack",
  );
});
