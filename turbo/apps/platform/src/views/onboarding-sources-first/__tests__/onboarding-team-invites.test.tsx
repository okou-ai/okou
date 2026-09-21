import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
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

const TEAM_QUESTION = "Bring the people who do this work with you.";
const EXPERIENCE_QUESTION = "Have you used Codex or Claude Code?";
/** Shown in place of the invite list while nothing has been sent. */
const TEAM_POINT =
  "They land in this workspace, with the sources you just connected.";
const TEAMMATE = "rowan@company.com";

/** One connected source, which every step after the source step requires. */
function mockConnectedCatalog(): void {
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
    connected: true,
    connectionStatus: "connected",
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

async function openTeamStep(): Promise<void> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockConnectedCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingTeam,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: TEAM_QUESTION }),
  ).resolves.toBeInTheDocument();
}

async function typeInvite(email: string): Promise<void> {
  await fill(screen.getByLabelText("Teammate’s email"), email);
}

test("An invited teammate is only marked invited once the API accepts the address", async () => {
  const sent = context.mocks.deferred<void>();
  const requested: { email: string; role: string }[] = [];
  context.mocks.api(orgInviteContract.invite, async ({ body, respond }) => {
    requested.push({ email: body.email, role: body.role });
    await sent.promise;
    return respond(200, { message: `Invitation sent to ${body.email}` });
  });
  await openTeamStep();

  await typeInvite(TEAMMATE);
  click(getButtonByName("Send invite"));

  await expect(screen.findByText("Sending…")).resolves.toBeInTheDocument();
  expect(screen.getByText(TEAMMATE)).toBeInTheDocument();
  expect(screen.queryByText("Invited")).not.toBeInTheDocument();

  sent.resolve();

  await expect(screen.findByText("Invited")).resolves.toBeInTheDocument();
  // The workspace invites a member, and no usage pack keeps onboarding clear
  // of the seat-purchase branch.
  expect(requested[0]).toStrictEqual({ email: TEAMMATE, role: "member" });
});

test("A refused address shows why, and the step continues anyway", async () => {
  context.mocks.api(orgInviteContract.invite, ({ respond }) => {
    return respond(409, {
      error: {
        message: "This person is already a member or has a pending invitation.",
        code: "CONFLICT",
      },
    });
  });
  await openTeamStep();

  await typeInvite(TEAMMATE);
  click(getButtonByName("Send invite"));

  await expect(
    screen.findByText(
      "This person is already a member or has a pending invitation.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Not sent")).toBeInTheDocument();
  expect(screen.queryByText("Invited")).not.toBeInTheDocument();

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingExperience);
});

test("An invitation cancelled by leaving the step reports no outcome", async () => {
  const sent = context.mocks.deferred<void>();
  context.mocks.api(orgInviteContract.invite, async ({ body, respond }) => {
    await sent.promise;
    return respond(200, { message: `Invitation sent to ${body.email}` });
  });
  await openTeamStep();

  await typeInvite(TEAMMATE);
  click(getButtonByName("Send invite"));

  await expect(screen.findByText("Sending…")).resolves.toBeInTheDocument();

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Back"));

  // The answer never reached this browser, so the step carries no outcome for
  // the address and offers what joining gives a teammate again.
  await expect(screen.findByText(TEAM_POINT)).resolves.toBeInTheDocument();
  expect(screen.queryByText(TEAMMATE)).not.toBeInTheDocument();
  sent.resolve();
});

test("The step can be left without inviting anyone", async () => {
  await openTeamStep();

  expect(getButtonByName("Send invite")).toBeDisabled();

  click(getButtonByName("Not now"));

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingExperience);
});
