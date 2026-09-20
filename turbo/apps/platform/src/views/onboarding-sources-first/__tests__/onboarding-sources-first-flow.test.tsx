import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

const MAKE_QUESTION = "What do you want to make first";
const INDUSTRY_QUESTION = "What kind of work do you do?";
const SOURCES_QUESTION = "Okou is for you, and shared across your whole team.";
const MARKETING_FIELD = "Marketing & content";

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

/** One catalog entry, so the source step has a grid to render. */
function mockCatalog(): void {
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
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
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

  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSources);
  // Nothing is connected yet, so the one requirement of this step holds it.
  expect(getButtonByName("Continue")).toBeDisabled();

  click(getButtonByName("Back"));

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
  // The answer survives the way back, so the field can be changed.
  expect(fieldRadio(MARKETING_FIELD)).toBeChecked();
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
