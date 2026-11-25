import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { now } from "../../../lib/time.ts";
import {
  findAction,
  mockSlack,
  mockTeams,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";

const context = testContext();
const channelPage = "/onboarding/slack";
const phone = "+14155550186";
function workspace(configured = true) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockSlack(context, { isAdmin: true, installUrl: "/slack/install" });
  mockTeams(context);
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: configured ? phone : null,
    configured,
  });
}
function issue(code: string, valid: boolean) {
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code,
        expiresAt: new Date(now() + (valid ? 600_000 : -1000)).toISOString(),
      });
    },
  );
}
test("onboarding-agentphone-tile-003 the mobile SMS invitation unlocks Continue only after the account is linked", async () => {
  workspace();
  context.mocks.browser.matchMedia((q) => {
    return q === "(width < 640px)";
  });
  issue("36004296", true);
  await setupPage({ context, path: channelPage });
  await expect(findAction("link", "Open Messages")).resolves.toHaveAttribute(
    "href",
    "sms:+14155550186?body=36004296",
  );
  for (const name of ["Telegram", "Teams", "Add to Slack"]) {
    await expect(findAction("button", name)).resolves.toBeEnabled();
  }
  const next = await findAction("button", "Continue");
  expect(next).toBeDisabled();
  context.mocks.data.agentPhoneIntegration({
    configured: true,
    linked: true,
    agentPhoneNumber: phone,
    phoneHandle: "+14155550110",
  });
  context.mocks.ably.trigger("agentphone:changed");
  await screen.findByText("iMessage is connected");
  expect(next).toBeEnabled();
  click(next);
  await screen.findByRole("heading", {
    name: "More ways to get your work done",
  });
});
test("onboarding-agentphone-tile-006 an unconfigured workspace can skip or add Slack without obtaining a phone code", async () => {
  workspace(false);
  const requested = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      requested.resolve();
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "No phone configured" },
      });
    },
  );
  await setupPage({ context, path: channelPage });
  await screen.findByText("iMessage isn’t available for this workspace yet.");
  expect(screen.queryByTestId("agentphone-link-qr")).toBeNull();
  await expect(findAction("button", "Add to Slack")).resolves.toBeEnabled();
  await expect(findAction("button", "Not now")).resolves.toBeEnabled();
  expect(requested.settled()).toBeFalsy();
});
test("onboarding-agentphone-tile-007 replacing an expired invitation renders a QR for the new message", async () => {
  workspace();
  issue("14006120", false);
  await setupPage({ context, path: channelPage });
  await screen.findByText("Your connection code has expired.");
  expect(screen.queryByTestId("agentphone-link-qr")).toBeNull();
  expect(screen.queryByText("Open Messages")).toBeNull();
  issue("52009345", true);
  click(await findAction("button", "Get a new code"));
  await expect(
    screen.findByTestId("agentphone-link-qr"),
  ).resolves.toHaveAttribute("data-sms-href", "sms:+14155550186?body=52009345");
});

test("The inline phone invitation uses the issued code and copies its destination", async () => {
  workspace();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const issued = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  const code = "96048371";
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    async ({ respond }) => {
      if (!ready.settled()) {
        ready.resolve();
      }
      await issued.promise;
      return respond(200, {
        code,
        expiresAt: new Date(now() + 120_000).toISOString(),
      });
    },
  );
  await setupPage({ context, path: channelPage });
  await ready.promise;
  await expect(findAction("button", "Continue")).resolves.toBeDisabled();
  issued.resolve();
  const qr = await screen.findByTestId("agentphone-link-qr"),
    sms = "sms:" + phone + "?body=" + code;
  expect(qr).toHaveAttribute("data-sms-href", sms);
  const smsLink = await screen.findByTestId("agentphone-open-messages");
  expect(smsLink).toHaveAttribute("href", sms);
  expect(screen.queryByRole("dialog")).toBeNull();
  click(await findFastControl("button", /^Copy .*415/));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(phone);
  });
  for (const channel of ["Add to Slack", "Telegram", "Teams"]) {
    await expect(findAction("button", channel)).resolves.toBeEnabled();
  }
  await expect(findAction("button", "Continue")).resolves.toBeDisabled();
});
