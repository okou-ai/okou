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
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();

const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

const TEAM_QUESTION = "Make Okou useful to your whole team";
const EXPERIENCE_QUESTION = "How would you like to start with Okou?";
const TEAMMATE = "rowan@company.com";

/** One connected source, which every step after the source step requires. */
function mockConnectedCatalog(): void {
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
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
  await fill(screen.getByLabelText("Team member’s email"), email);
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
        message: "This person already has a pending invitation.",
        code: "INVITATION_ALREADY_EXISTS",
      },
    });
  });
  await openTeamStep();

  await typeInvite(TEAMMATE);
  click(getButtonByName("Send invite"));

  await expect(
    screen.findByText("This person already has a pending invitation."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Not sent")).toBeInTheDocument();
  expect(screen.queryByText("Invited")).not.toBeInTheDocument();

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingExperience);
});

test("The step can be left without inviting anyone", async () => {
  await openTeamStep();

  expect(getButtonByName("Send invite")).toBeDisabled();
  // The step offers one way on, and it never reads as a skip.
  expect(screen.queryByText("Skip for now")).not.toBeInTheDocument();
  expect(screen.queryByText("Not now")).not.toBeInTheDocument();

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingExperience);
});
