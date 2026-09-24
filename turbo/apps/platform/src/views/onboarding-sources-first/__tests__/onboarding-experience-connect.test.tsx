import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
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
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();

const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

const EXPERIENCE_QUESTION = "How would you like to start with Okou?";
const SKILLS_QUESTION = "Bring your existing skills into Okou";
const SLACK_QUESTION = "Keep work moving in Slack";
const CODEX_CARD = "Codex";
const NEW_TO_THIS_CARD = "I'm new to AI agents";
const CONNECT_CODEX = "Connect Codex";
const FAILED_NOTE =
  "We couldn’t connect Codex. You can try again, or continue and connect it later.";

/** The step is only reachable once a source is connected. */
function mockConnectedSource(): void {
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
}

function connectedCodexAccount(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000401",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    accountEmail: "codex.user@example.com",
    workspaceName: "Personal ChatGPT",
    planType: "pro",
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function mockCodexDeviceAuthStart(): void {
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "onboarding-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/device",
      verificationCode: "ABCD-1234",
      expiresIn: 600,
      interval: 1,
    });
  });
}

/**
 * The step after this one names the org's own Slack, and the shared fixture
 * has one already connected. This run is a workspace that does not.
 */
function mockSlackNotInstalled(): void {
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.example.test/oauth/install",
      connectUrl: null,
    });
  });
}

async function waitForContinueEnabled(): Promise<void> {
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
}

async function openExperienceStep(fromStart = false): Promise<void> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockConnectedSource();
  mockSlackNotInstalled();

  await setupPage({
    context,
    locale: "en-US",
    path: fromStart ? ROUTES.onboarding : ROUTES.onboardingExperience,
    featureSwitches: SOURCES_FIRST_ON,
  });

  if (fromStart) {
    await screen.findByRole("heading", {
      name: "What kind of work do you do?",
    });
    click(answerRadio("Marketing & content"));
    await waitForContinueEnabled();
    click(getButtonByName("Continue"));
    await screen.findByRole("heading", {
      name: "Connect a work tool",
    });
    click(getButtonByName("Continue"));
    await screen.findByRole("heading", {
      name: "Make Okou useful to your whole team",
    });
    click(getButtonByName("Not now"));
  }

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
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

/** The control of the answer card carrying `name`, as a user would aim at it. */
function answerRadio(name: string): HTMLElement {
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

function closeDeviceAuthDialog(): void {
  click(screen.getByLabelText("Close"));
}

test("The guided start comes before subscription plans", async () => {
  await openExperienceStep();

  const choices = screen.getAllByRole("radio").map((radio) => {
    return radio.closest("label")?.textContent ?? "";
  });
  expect(choices[0]).toContain(NEW_TO_THIS_CARD);
  expect(choices[1]).toContain(CODEX_CARD);
  expect(choices[2]).toContain("Claude Code");
});

test("The step reports connected once the account lists the subscription", async () => {
  context.mocks.data.personalModelProviders([]);
  mockCodexDeviceAuthStart();
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    const provider = connectedCodexAccount();
    context.mocks.data.personalModelProviders([provider]);
    return respond(200, { status: "complete", provider, created: true });
  });

  await openExperienceStep();

  click(answerRadio(CODEX_CARD));

  await waitFor(() => {
    expect(getButtonByName(CONNECT_CODEX)).toBeEnabled();
  });

  click(getButtonByName(CONNECT_CODEX));

  await waitFor(() => {
    expect(getButtonByName("Connected")).toBeDisabled();
  });
});

test("A failed connect says so and still lets the person continue", async () => {
  context.mocks.data.personalModelProviders([]);
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(503, {
      error: {
        message: "Codex device auth is unavailable",
        code: "UNAVAILABLE",
      },
    });
  });

  await openExperienceStep();

  click(answerRadio(CODEX_CARD));

  await waitFor(() => {
    expect(getButtonByName(CONNECT_CODEX)).toBeEnabled();
  });

  click(getButtonByName(CONNECT_CODEX));

  await expect(
    screen.findByTestId("codex-device-auth-start"),
  ).resolves.toBeInTheDocument();

  closeDeviceAuthDialog();

  await expect(screen.findByText(FAILED_NOTE)).resolves.toBeInTheDocument();

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SKILLS_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSkills);
});

test("Answering new to this keeps skipping the skills step", async () => {
  await openExperienceStep(true);

  click(answerRadio(NEW_TO_THIS_CARD));

  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  // The connect belongs to a plan, and this answer names none.
  expect(screen.queryByText(CONNECT_CODEX)).not.toBeInTheDocument();

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SLACK_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSlack);
});
