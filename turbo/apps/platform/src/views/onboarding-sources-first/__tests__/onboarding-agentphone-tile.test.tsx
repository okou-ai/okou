import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const CONNECTION_CODE = "12345678";

function getButton(name: string): HTMLElement {
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

async function openChatStep(): Promise<void> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.example.test/oauth/install",
      connectUrl: null,
    });
  });
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      connectUrl: "/api/teams/oauth/connect?orgId=org_default",
    });
  });
  await setupPage({ context, locale: "en-US", path: ROUTES.onboardingSlack });
  await expect(
    screen.findByRole("heading", { name: "Text Okou in iMessage" }),
  ).resolves.toBeInTheDocument();
}

function mockCode(): void {
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: CONNECTION_CODE,
        expiresAt: new Date(now() + 600_000).toISOString(),
      });
    },
  );
}

test("iMessage shows its QR inline without a channel click, with parallel alternatives", async () => {
  mockCode();
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: "+13144386568",
    configured: true,
  });
  await openChatStep();
  const qr = await screen.findByTestId("agentphone-link-qr");
  expect(qr).toHaveAttribute(
    "data-sms-href",
    `sms:+13144386568?body=${CONNECTION_CODE}`,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("+1 (314) 438-6568")).toBeVisible();
  expect(screen.getByText("Also available in")).toBeVisible();
  expect(getButton("Add to Slack")).toBeEnabled();
  expect(getButton("Telegram")).toBeEnabled();
  expect(getButton("Teams")).toBeEnabled();
  expect(screen.getByTestId("agentphone-open-messages")).toHaveAttribute(
    "href",
    `sms:+13144386568?body=${CONNECTION_CODE}`,
  );
  expect(getButton("Continue")).toBeDisabled();
  click(getButton("Copy +1 (314) 438-6568"));
  await expect(
    screen.findByText("Phone number copied"),
  ).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual(["+13144386568"]);
});

test("Linking iMessage replaces the QR and enables Continue without Slack", async () => {
  mockCode();
  await openChatStep();
  await screen.findByTestId("agentphone-link-qr");
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: "+15555550123",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  act(() => {
    return context.mocks.ably.trigger("agentphone:changed");
  });
  await expect(
    screen.findByText("iMessage is connected"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("agentphone-link-qr")).not.toBeInTheDocument();
  expect(getButton("Continue")).toBeEnabled();
  click(getButton("Continue"));
  await waitFor(() => {
    return expect(pathname()).toBe(ROUTES.onboardingReady);
  });
});

test("A pending connection code does not prevent skipping the step", async () => {
  const releaseCode = context.mocks.deferred<void>();
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    async ({ respond }) => {
      await releaseCode.promise;
      return respond(200, {
        code: CONNECTION_CODE,
        expiresAt: new Date(now() + 600_000).toISOString(),
      });
    },
  );
  await openChatStep();
  await expect(
    screen.findByText("Creating connection code…"),
  ).resolves.toBeInTheDocument();
  click(getButton("Not now"));
  await expect(
    screen.findByRole("heading", { name: "Start with a task that matters" }),
  ).resolves.toBeInTheDocument();
  releaseCode.resolve();
  expect(pathname()).toBe(ROUTES.onboardingReady);
});

test("An already linked phone needs no new connection code", async () => {
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: "+15555550123",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.api(integrationsAgentPhoneContract.createLinkCode, () => {
    throw new Error("An already connected phone must not generate a code");
  });
  await openChatStep();
  expect(screen.getByText("iMessage is connected")).toBeInTheDocument();
  expect(screen.queryByTestId("agentphone-link-qr")).not.toBeInTheDocument();
  expect(getButton("Continue")).toBeEnabled();
});

test("An unconfigured phone leaves the other channels and skip available", async () => {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: null,
    configured: false,
  });
  context.mocks.api(integrationsAgentPhoneContract.createLinkCode, () => {
    throw new Error("An unconfigured phone must not generate a code");
  });
  await openChatStep();
  expect(
    screen.getByText("iMessage isn’t available for this workspace yet."),
  ).toBeInTheDocument();
  expect(screen.queryByTestId("agentphone-link-qr")).not.toBeInTheDocument();
  expect(getButton("Add to Slack")).toBeEnabled();
  expect(getButton("Not now")).toBeEnabled();
});

test("A failed code can be retried without leaving onboarding", async () => {
  let available = false;
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return available
        ? respond(200, {
            code: CONNECTION_CODE,
            expiresAt: new Date(now() + 600_000).toISOString(),
          })
        : respond(503, {
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "Phone service unavailable",
            },
          });
    },
  );
  await openChatStep();
  await expect(screen.findByRole("alert")).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("agentphone-link-qr")).not.toBeInTheDocument();
  available = true;
  click(getButton("Try again"));
  await expect(
    screen.findByTestId("agentphone-link-qr"),
  ).resolves.toHaveAttribute(
    "data-sms-href",
    `sms:+19039853128?body=${CONNECTION_CODE}`,
  );
});

test("An expired code is not scannable and can be replaced", async () => {
  let expired = true;
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: CONNECTION_CODE,
        expiresAt: new Date(now() + (expired ? -1 : 600_000)).toISOString(),
      });
    },
  );
  await openChatStep();
  await expect(
    screen.findByText("Your connection code has expired."),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("agentphone-link-qr")).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("agentphone-open-messages"),
  ).not.toBeInTheDocument();
  expired = false;
  click(getButton("Get a new code"));
  await expect(
    screen.findByTestId("agentphone-link-qr"),
  ).resolves.toBeInTheDocument();
});
