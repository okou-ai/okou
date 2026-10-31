import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import { mockOAuthCompletions } from "../../okou-page/__tests__/connector-page-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

const INDUSTRY_QUESTION = "What kind of work do you do?";
const SOURCES_QUESTION = "Connect a work tool";
const EXPERIENCE_QUESTION = "How would you like to start with Okou?";
const READY_TITLE = "Start with a task that matters";
const MARKETING_FIELD = "Marketing & content";

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

/**
 * One source whose connection is configurable, and one to connect during the run.
 */
function mockCatalog(connected = true): void {
  mockOnboardingConnectorCatalog(context, [
    onboardingSourceItem({
      slug: "gmail",
      label: "Gmail",
      description: "Mail for your workspace",
      hasAccount: connected,
    }),
    onboardingSourceItem({
      slug: "notion",
      label: "Notion",
      description: "Shared notes for a team",
      hasAccount: false,
    }),
  ]);
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
  });
  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
}

test("Skipping sources reports the step skip and keeps a single onboarding start", async () => {
  const posthog = context.mocks.posthog();
  mockOnboardingNeeded();
  mockCatalog(false);
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
  click(getButtonByName("Skip"));

  await screen.findByRole("dialog", {
    name: "Okou works better with your tools",
  });
  expect(
    posthog.events.filter((event) => {
      return event.name === "Onboarding: Skip";
    }),
  ).toStrictEqual([]);
  click(getButtonByName("Connect a tool"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(
    posthog.events.filter((event) => {
      return event.name === "Onboarding: Skip";
    }),
  ).toStrictEqual([]);

  click(getButtonByName("Skip"));
  await screen.findByRole("dialog", {
    name: "Okou works better with your tools",
  });
  click(getButtonByName("Skip for now"));

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  // The steps and the guard all belong to the same run.
  expect(tags).toStrictEqual(["onboarding-start"]);
  expect(
    posthog.events.filter((event) => {
      return event.name === "Onboarding: Skip";
    }),
  ).toStrictEqual([
    onboardingEvent("Skip", {
      step_key: "sources",
      route_path: ROUTES.onboardingSources,
      is_owner: true,
    }),
  ]);
});

test("Each step reports its position in the flow without an invitation step", async () => {
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
        step_count: 5,
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
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(choiceRadio("I'm new to AI agents"));

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
        step_count: 5,
        route_path: ROUTES.onboardingSources,
      }),
      onboardingEvent("StepViewed", {
        step_key: "experience",
        step_index: 2,
        step_count: 5,
      }),
    ]),
  );
  expect(posthog.events).not.toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("StepViewed", { step_key: "team" }),
    ]),
  );
});

test.each([false, true])(
  "A source card starts OAuth directly and reports a successful connect (mobile=%s)",
  async (mobile) => {
    context.mocks.browser.matchMedia((query) => {
      return mobile && query === "(width < 640px)";
    });
    const posthog = context.mocks.posthog();
    mockOnboardingNeeded();
    mockCatalog();
    const completedAttempts = mockOAuthCompletions(context);
    const authWindow = context.mocks.browser.authWindow();
    authWindow.closed = true;
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    const oauthAttemptId = crypto.randomUUID();
    const connectionId = "11111111-1111-4111-8111-111111111112";
    let started = false;
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ body, params, respond }) => {
        started = true;
        expect(params.connectorSlug).toBe("notion");
        expect(body.authMethod).toBe("oauth");
        expect(body.account).toStrictEqual({ intent: "add" });
        completedAttempts.set(oauthAttemptId, connectionId);
        context.mocks.data.connectors([
          {
            id: connectionId,
            slug: "notion",
            authMethod: "oauth",
            externalId: "notion-user-1",
            externalUsername: null,
            externalEmail: null,
            oauthScopes: [],
            connectionStatus: "connected",
            reconnectReason: null,
            tokenExpiresAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]);
        context.mocks.ably.trigger("connector:changed", {
          connectorSlug: "notion",
        });
        return respond(200, {
          authorizationUrl: "https://oauth.test/notion/authorize",
          oauthAttemptId,
        });
      },
    );

    await setupPage({
      context,
      locale: "en-US",
      path: ROUTES.onboardingSources,
      host: "app.okou.ai",
    });
    await expect(
      screen.findByRole("heading", {
        name: "Put your everyday tools to work",
      }),
    ).resolves.toBeInTheDocument();

    click(getButtonByName("Connect Notion"));

    await waitFor(() => {
      expect(started).toBeTruthy();
      expect(authWindow.location.href).toBe(
        "https://oauth.test/notion/authorize",
      );
    });
    expect(
      screen.queryByRole("dialog", { name: "Notion" }),
    ).not.toBeInTheDocument();
    expect(posthog.events).toStrictEqual(
      expect.arrayContaining([
        onboardingEvent("SourceConnectStarted", {
          connector_slug: "notion",
          source_origin: "grid",
        }),
      ]),
    );

    await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
    expect(getButtonByName("Continue")).toBeEnabled();

    await waitFor(() => {
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
  },
);

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
