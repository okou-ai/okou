import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

const INDUSTRY_QUESTION = "What kind of work do you do?";
const SOURCES_QUESTION = "Okou is for you, and shared across your whole team.";
const TEAM_QUESTION = "Bring the people who do this work with you.";
const EXPERIENCE_QUESTION = "Have you used Codex or Claude Code?";
const READY_TITLE = "Okou is ready for you";
const MARKETING_FIELD = "Marketing & content";
const TEAMMATE_EMAIL = "teammate@example.test";
/** A word the catalog only matches through a description, never a slug. */
const SEARCH_WORDS = "shared notes";
const API_TOKEN_PLACEHOLDER = "token-xxxx";

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

function catalogItem(item: {
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly connected: boolean;
  /** A token this test can type, so a connect completes without a provider. */
  readonly manual?: boolean;
}): PublicConnectorCatalogStatusItem {
  return {
    slug: item.slug,
    label: item.label,
    description: item.description,
    icon: {
      url: `https://icons.example.test/onboarding-${item.slug}.svg`,
      invertInDarkMode: false,
    },
    category: "productivity",
    generation: [],
    tags: [],
    authMethods: [
      item.manual
        ? {
            id: "api-token",
            label: "API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "API Token",
                required: true,
                placeholder: API_TOKEN_PLACEHOLDER,
                inputType: "password",
              },
            ],
            startOptions: [],
          }
        : {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind: "auth-code",
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
    connection: null,
    connected: item.connected,
    connectionStatus: item.connected ? "connected" : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: item.manual ? null : "oauth",
    connectNotice: null,
  };
}

/**
 * One source already connected, so the steps behind the connect requirement
 * are reachable, and one that is not, to connect during the run.
 */
function mockCatalog(): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [
        catalogItem({
          slug: "gmail",
          label: "Gmail",
          description: "Mail for your workspace",
          connected: true,
        }),
        catalogItem({
          slug: "notion",
          label: "Notion",
          description: "Shared notes for a team",
          connected: false,
          manual: true,
        }),
      ],
    });
  });
}

function getButtonByName(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

/** The control of the field card carrying `name`, as a user would aim at it. */
function choiceRadio(name: string): HTMLElement {
  const card = screen.getByText(name).closest("label");
  if (!card) {
    throw new Error(`Expected the "${name}" choice card`);
  }
  const radio = queryAllByRoleFast("radio", card)[0];
  if (!radio) {
    throw new Error(`Expected the "${name}" radio`);
  }
  return radio;
}

function onboardingEvent(name: string, properties: Record<string, unknown>) {
  return expect.objectContaining({
    name: `Onboarding: ${name}`,
    properties: expect.objectContaining(properties),
  });
}

async function openIndustryStep(): Promise<void> {
  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    host: "app.okou.ai",
    featureSwitches: SOURCES_FIRST_ON,
  });
  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
}

test("One run of the source-first flow reports a single onboarding start, whatever the way back", async () => {
  mockOnboardingNeeded();
  mockCatalog();
  const tags: string[] = [];
  context.mocks.api(marketingEventsContract.record, ({ body, respond }) => {
    tags.push(body.tag);
    return respond(204);
  });

  await openIndustryStep();
  await waitFor(() => {
    expect(tags).toStrictEqual(["onboarding-start"]);
  });

  click(choiceRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: TEAM_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Back"));

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: TEAM_QUESTION }),
  ).resolves.toBeInTheDocument();
  // The steps, the way back and the guard all belong to the same run.
  expect(tags).toStrictEqual(["onboarding-start"]);
});

test("Each step reports its own funnel event, counting invitees rather than naming them", async () => {
  const posthog = context.mocks.posthog();
  mockOnboardingNeeded();
  mockCatalog();

  await openIndustryStep();

  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("StepViewed", {
        flow: "source_first",
        step_key: "industry",
        step_index: 0,
        step_count: 6,
        route_path: ROUTES.onboarding,
        is_owner: true,
      }),
    ]),
  );

  click(choiceRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: TEAM_QUESTION }),
  ).resolves.toBeInTheDocument();
  await fill(screen.getByLabelText("Teammate’s email"), TEAMMATE_EMAIL);
  click(getButtonByName("Send invite"));

  await expect(screen.findByText("Invited")).resolves.toBeInTheDocument();
  click(getButtonByName("Not now"));

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(choiceRadio("No, I’m new to this"));

  await waitFor(() => {
    expect(posthog.events).toStrictEqual(
      expect.arrayContaining([
        onboardingEvent("ExperienceAnswered", {
          step_key: "experience",
          experienced: false,
          provider: "none",
        }),
      ]),
    );
  });
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("IndustrySelected", {
        step_key: "industry",
        industry: "marketing",
      }),
      onboardingEvent("StepViewed", {
        step_key: "sources",
        step_index: 1,
        step_count: 6,
        route_path: ROUTES.onboardingSources,
      }),
      onboardingEvent("StepViewed", {
        step_key: "team",
        step_index: 2,
        step_count: 6,
      }),
      onboardingEvent("InviteAdded", {
        step_key: "team",
        invite_count: 1,
      }),
      onboardingEvent("Skip", { step_key: "team" }),
    ]),
  );
  // Who was invited stays in the browser; the funnel only counts them.
  expect(JSON.stringify(posthog.events)).not.toContain(TEAMMATE_EMAIL);
});

test("Leaving a step through Back reports it against the step that was left", async () => {
  const posthog = context.mocks.posthog();
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSources,
    host: "app.okou.ai",
    featureSwitches: SOURCES_FIRST_ON,
  });
  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Back"));

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("Back", {
        flow: "source_first",
        step_key: "sources",
        step_index: 1,
        step_count: 6,
      }),
    ]),
  );
});

test("The catalog search reports what it produced, never the words that produced it", async () => {
  const posthog = context.mocks.posthog();
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSources,
    host: "app.okou.ai",
    featureSwitches: SOURCES_FIRST_ON,
  });
  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Find a source for your work"));

  const search = await screen.findByPlaceholderText(
    "Search by task or app name",
  );
  await fill(search, SEARCH_WORDS);

  const result = await screen.findByRole("option");
  click(result);

  await expect(
    screen.findByRole("dialog", { name: "Notion" }),
  ).resolves.toBeInTheDocument();
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("CatalogSearchOpened", { step_key: "sources" }),
      onboardingEvent("CatalogSearchResultSelected", {
        connector_slug: "notion",
        result_count: 1,
      }),
      onboardingEvent("SourceConnectStarted", {
        connector_slug: "notion",
        source_origin: "search",
      }),
    ]),
  );
  expect(JSON.stringify(posthog.events)).not.toContain(SEARCH_WORDS);
});

test("A source connected from the grid reports the connect it came from", async () => {
  const posthog = context.mocks.posthog();
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSources,
    host: "app.okou.ai",
    featureSwitches: SOURCES_FIRST_ON,
  });
  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Connect Notion"));

  const dialog = await screen.findByRole("dialog", { name: "Notion" });
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("SourceConnectStarted", {
        connector_slug: "notion",
        source_origin: "grid",
      }),
    ]),
  );

  await fill(within(dialog).getByPlaceholderText(API_TOKEN_PLACEHOLDER), "abc");
  click(getButtonByName("Save"));

  await expect(
    screen.findByText("Notion connected successfully"),
  ).resolves.toBeInTheDocument();
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("SourceConnected", {
        step_key: "sources",
        connector_slug: "notion",
        source_origin: "grid",
      }),
    ]),
  );
});

test("The starting prompt reports its length, never the request itself", async () => {
  const posthog = context.mocks.posthog();
  mockOnboardingNeeded();
  mockCatalog();
  mockChatLifecycle(context);

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    host: "app.okou.ai",
    featureSwitches: SOURCES_FIRST_ON,
  });
  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();

  const request = "Summarise last week for me";
  await fill(screen.getByLabelText("Your starting prompt"), request);
  click(getButtonByName("Start with Okou"));

  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("PromptEdited", {
        step_key: "ready",
        prompt_edited: true,
        prompt_length: request.length,
      }),
      onboardingEvent("StartClicked", {
        step_key: "ready",
        prompt_edited: true,
        prompt_length: request.length,
      }),
    ]),
  );
  expect(JSON.stringify(posthog.events)).not.toContain(request);
});
