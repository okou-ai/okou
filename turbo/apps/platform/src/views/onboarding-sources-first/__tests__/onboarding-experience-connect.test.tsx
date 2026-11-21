import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  findAction,
  mockSlack,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";
const context = testContext();
test("onboarding-experience-connect-002 a completed device session marks the listed personal Codex plan connected", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.data.personalModelProviders([]);
  const approved = createDeferredPromise<void>(context.signal);
  const provider = {
    id: crypto.randomUUID(),
    type: "codex-oauth-token",
    framework: "codex",
    isActive: true,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-10-18T10:00:00Z",
    updatedAt: "2026-10-18T10:00:00Z",
  } as const;
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      type: "codex",
      scope: "personal",
      status: "pending",
      sessionToken: "harbor-session",
      browserUrl: "https://device.example.test/verify",
      verificationCode: "HARBOR-23",
      expiresIn: 300,
      interval: 1,
    });
  });
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ body, respond }) => {
      expect(body.sessionToken).toBe("harbor-session");
      await approved.promise;
      context.mocks.data.personalModelProviders([provider]);
      return respond(200, { status: "complete", provider, created: true });
    },
  );
  await setupPage({ context, path: "/onboarding/experience" });
  click(await screen.findByText("Codex"));
  click(await findAction("button", "Connect Codex"));
  await screen.findByText("HARBOR-23");
  approved.resolve();
  const linked = await findAction("button", "Connected");
  expect(linked).toBeDisabled();
  expect(window.location.pathname).toBe("/onboarding/experience");
});
test("onboarding-experience-connect-004 a new user starting with Okou goes directly from plan selection to chat channels", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockSlack(context, { isAdmin: true, installUrl: "/install/slack" });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  await setupPage({ context, path: "/onboarding" });
  click(await screen.findByText("Business & operations"));
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a work tool" });
  const next = await findAction("button", "Continue");
  await waitFor(() => {
    return expect(next).toBeEnabled();
  });
  click(next);
  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  click(await screen.findByText("Start with Okou"));
  expect(queryAction("button", "Connect Codex")).toBeNull();
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  expect(window.location.pathname).toBe("/onboarding/slack");
  await expect(findAction("button", "Add to Slack")).resolves.toBeEnabled();
});
