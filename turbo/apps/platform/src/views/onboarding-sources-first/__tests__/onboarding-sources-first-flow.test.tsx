import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();
const draftStorage = localStorageSignals("onboarding:sources-first-draft");
const completedDraftStorage = localStorageSignals(
  "onboarding:sources-first-draft",
);

const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

const MAKE_QUESTION = "What do you want to make first";
const INDUSTRY_QUESTION = "What kind of work do you do?";
const SOURCES_QUESTION = "Okou is for you, and shared across your whole team.";
const MARKETING_FIELD = "Marketing & content";
const READY_TITLE = "Okou is ready for you";
const START_ACTION = "Start with Okou";
const HANDOFF_PROMPT = "Draft the launch plan";

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

function mockMemberOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: false,
  });
}

/** One catalog entry, so the source step has a grid to render. */
function mockCatalog({
  connected = false,
  ready,
  unavailable,
}: {
  connected?: boolean;
  ready?: Promise<void>;
  unavailable?: () => boolean;
} = {}): void {
  const connector: PublicConnectorCatalogStatusItem = {
    slug: "gmail",
    label: "Gmail",
    description: "Connect Gmail to continue",
    icon: {
      url: "https://icons.example.test/onboarding-gmail.svg",
      invertInDarkMode: false,
    },
    category: "productivity",
    generation: [],
    tags: [],
    authMethods: [
      {
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
    connected,
    connectionStatus: connected ? "connected" : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
  context.mocks.api(connectorCatalogContract.status, async ({ respond }) => {
    if (ready) {
      await ready;
    }
    if (unavailable?.()) {
      return respond(503, {
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Connector catalog is temporarily unavailable",
        },
      });
    }
    return respond(200, { connectors: [connector] });
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
function fieldRadio(name: string): HTMLElement {
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

test("The source-first steps stay unreachable while the switch is off", async () => {
  mockOnboardingNeeded();

  await setupPage({ context, locale: "en-US", path: ROUTES.onboardingSources });

  await expect(
    screen.findByRole("heading", { name: MAKE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
});

test("The switch opens the field question on /onboarding and continues to the sources step", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Continue")).toBeDisabled();

  click(fieldRadio(MARKETING_FIELD));

  expect(
    JSON.parse(context.store.get(draftStorage.get$) ?? "null"),
  ).toMatchObject({
    orgId: "org_default",
    userId: "test-user-123",
    industry: "marketing",
  });

  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });

  click(getButtonByName("Continue"));

  // Keep the current question in place while the next route is being set up.
  // The full-screen app loader would otherwise flash over every step change.
  expect(
    screen.getByRole("heading", { name: INDUSTRY_QUESTION }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Loading" }),
  ).not.toBeInTheDocument();

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSources);
  // Nothing is connected yet, so the one requirement of this step holds it.
  expect(getButtonByName("Continue")).toBeDisabled();

  click(getButtonByName("Back"));

  expect(
    screen.getByRole("heading", { name: SOURCES_QUESTION }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Loading" }),
  ).not.toBeInTheDocument();

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
  // The answer survives the way back, so the field can be changed.
  expect(fieldRadio(MARKETING_FIELD)).toBeChecked();
});

test("The first step waits for connector choices before opening the sources step", async () => {
  mockOnboardingNeeded();
  const catalogReady = context.mocks.deferred<void>();
  mockCatalog({ ready: catalogReady.promise });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(fieldRadio(MARKETING_FIELD));

  expect(getButtonByName("Continue")).toBeEnabled();
  click(getButtonByName("Continue"));

  expect(getButtonByName("Continue")).toBeDisabled();
  expect(getButtonByName("Continue")).toHaveAttribute("aria-busy", "true");
  expect(pathname()).toBe(ROUTES.onboarding);
  expect(
    screen.getByRole("heading", { name: INDUSTRY_QUESTION }),
  ).toBeInTheDocument();

  catalogReady.resolve();
  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Connect Gmail")).toBeInTheDocument();
  expect(screen.queryByText("Loading connectors…")).not.toBeInTheDocument();
});

test("The first step can retry when connector choices are unavailable", async () => {
  mockOnboardingNeeded();
  const catalogReady = context.mocks.deferred<void>();
  let unavailable = true;
  mockCatalog({
    ready: catalogReady.promise,
    unavailable: () => {
      return unavailable;
    },
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: SOURCES_FIRST_ON,
  });

  click(fieldRadio(MARKETING_FIELD));
  click(getButtonByName("Continue"));
  expect(getButtonByName("Continue")).toHaveAttribute("aria-busy", "true");
  catalogReady.resolve();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't load built-in connectors.");
  expect(getButtonByName("Continue")).toBeDisabled();
  expect(getButtonByName("Continue")).toHaveAttribute("aria-busy", "false");

  unavailable = false;
  click(getButtonByName("Retry"));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });

  click(getButtonByName("Continue"));
  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Connect Gmail")).toBeInTheDocument();
});

test("A later step returns to the entry until a source is connected", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
});

test("The ready step completes onboarding once, before it runs the first request", async () => {
  mockOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  // Where the browser still was when completion went out, so the order of the
  // two is observable rather than assumed.
  const completedFrom: string[] = [];
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ query, respond }) => {
      completedFrom.push(pathname());
      expect(query?.modelProvider).toBeUndefined();
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, {
        onboardingComplete: true,
        needsOnboarding: false,
      });
    },
  );

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName(START_ACTION));

  await waitFor(() => {
    expect(runPrompt).toBeTruthy();
  });
  expect(completedFrom).toStrictEqual([ROUTES.onboardingReady]);
});

test("A refreshed ready step keeps the industry, model choice, and edited request", async () => {
  mockOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  let sentIndustry: string | undefined;
  let sentProvider: string | undefined;
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ body, query, respond }) => {
      sentIndustry = body.industry;
      sentProvider = query?.modelProvider;
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, {
        onboardingComplete: true,
        needsOnboarding: false,
      });
    },
  );
  // A fresh browser app starts with storage from the previous app lifetime.
  context.store.set(
    draftStorage.set$,
    JSON.stringify({
      version: 1,
      orgId: "org_default",
      userId: "test-user-123",
      industry: "marketing",
      experienced: true,
      provider: "claudeCode",
      startingPromptDraft: "Draft my launch plan",
      startingPromptKey: "marketing:gmail",
    }),
  );

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Your starting prompt")).toHaveValue(
    "Draft my launch plan",
  );

  click(getButtonByName(START_ACTION));
  await waitFor(() => {
    expect(runPrompt).toBe("Draft my launch plan");
  });
  expect(sentIndustry).toBe("marketing");
  expect(sentProvider).toBe("claudeCode");
  expect(context.store.get(completedDraftStorage.get$)).toBeNull();
});

test("A member's run reaches the first request without the admin-only completion", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  let completions = 0;
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completions += 1;
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName(START_ACTION));

  await waitFor(() => {
    expect(runPrompt).toBeTruthy();
  });
  // `POST /api/onboarding/complete` is admin-only, so a member run would only
  // ever collect a 403 from it.
  expect(completions).toBe(0);
});

test("A step keeps the prompt handoff and redeem code it arrived with", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}&redeemCode=LAUNCH50`,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(fieldRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  const params = new URLSearchParams(search());
  expect(params.get("prompt")).toBe(HANDOFF_PROMPT);
  expect(params.get("redeemCode")).toBe("LAUNCH50");
});

test("An already-onboarded visitor is forwarded with the prompt they brought", async () => {
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboardingSources}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}`,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await waitFor(() => {
    expect(runPrompt).toBe(HANDOFF_PROMPT);
  });
});

test("A refused completion keeps the ready step open for another try", async () => {
  mockOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  let completions = 0;
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completions += 1;
    if (completions === 1) {
      return respond(403, {
        error: {
          message: "Only org admins can complete onboarding",
          code: "FORBIDDEN",
        },
      });
    }
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName(START_ACTION));

  await waitFor(() => {
    expect(getButtonByName(START_ACTION)).toBeEnabled();
  });
  expect(completions).toBe(1);
  expect(pathname()).toBe(ROUTES.onboardingReady);
  expect(
    screen.getByRole("heading", { name: READY_TITLE }),
  ).toBeInTheDocument();
  // The first request never finished, so onboarding must not have handed the
  // user on to it.
  expect(runPrompt).toBeUndefined();

  click(getButtonByName(START_ACTION));

  await waitFor(() => {
    expect(runPrompt).toBeTruthy();
  });
  expect(completions).toBe(2);
});
