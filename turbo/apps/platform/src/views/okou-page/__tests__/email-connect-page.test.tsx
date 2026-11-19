import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { integrationsEmailContract } from "@okouai/api-contracts/contracts/integrations-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const emailAddress = "verified@example.com";
function proof() {
  return {
    messageId: "00000000-0000-4000-8000-000000000001",
    expires: 1_784_880_000,
    signature: "a".repeat(64),
  };
}
const path = `/settings/email?${new URLSearchParams({ message: proof().messageId, expires: String(proof().expires), signature: proof().signature })}`;
function featureSwitches() {
  return {
    [FeatureSwitchKey.WorksChannelCards]: true,
    [FeatureSwitchKey.EmailIntegration]: true,
  };
}

beforeEach(() => {
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails: [],
      availableEmails: [emailAddress],
      emailSources: {},
    });
  });
});

test("connects in the active workspace without asking a multi-workspace user to choose again", async () => {
  let requestBody: unknown;
  context.mocks.api(integrationsEmailContract.connect, ({ body, respond }) => {
    requestBody = body;
    return respond(200, { emailAddress });
  });
  await setupPage({
    context,
    path,
    featureSwitches: featureSwitches(),
    auth: {
      user: { id: "email-owner", fullName: "Email Owner" },
      organization: {
        activeOrg: { id: "org_active", name: "Active workspace" },
        memberships: [{ id: "org_other" }, { id: "org_active" }],
      },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "Email connected" }),
  ).resolves.toBeInTheDocument();
  const notifications = await screen.findByRole("region", {
    name: /Notifications/u,
  });
  await expect(
    within(notifications).findByText("Email connected"),
  ).resolves.toBeInTheDocument();
  expect(within(notifications).getByText(emailAddress)).toBeInTheDocument();
  expect(window.location.pathname).toBe("/settings/email");
  expect(requestBody).toStrictEqual(proof());
  expect(getAction("link", "Open email")).toHaveAttribute(
    "href",
    "mailto:okou@okou.io",
  );
});

test("adds an email from the Works card with a short code and updates the open dialog", async () => {
  let emails: string[] = [];
  let code = "01234567";
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails,
      availableEmails: [emailAddress],
      emailSources: {},
    });
  });
  context.mocks.api(integrationsEmailContract.createLinkCode, ({ respond }) => {
    return respond(200, { code, expiresAt: "2026-11-10T08:10:00.000Z" });
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: featureSwitches(),
  });
  const card = getIntegrationCard("Email");
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  click(getAction("button", "Connect", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Email connections",
  });
  expect(
    within(dialog).getByText("Send the code from the email you want to add."),
  ).toBeInTheDocument();
  await expect(within(dialog).findByText(code)).resolves.toBeInTheDocument();
  expect(getAction("link", "Open email", dialog)).toHaveAttribute(
    "href",
    `mailto:okou@okou.io?subject=${code}&body=${code}`,
  );
  click(getAction("button", `Copy connection code ${code}`, dialog));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([code]);
  });
  code = "76543210";
  click(getAction("button", "Generate new code", dialog));
  await expect(within(dialog).findByText(code)).resolves.toBeInTheDocument();
  expect(getAction("link", "Open email", dialog)).toHaveAttribute(
    "href",
    `mailto:okou@okou.io?subject=${code}&body=${code}`,
  );
  emails = [emailAddress];
  await context.mocks.ably.trigger("email:changed");
  await expect(
    within(dialog).findByText(emailAddress),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/works");
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    expect(getAction("button", "Email options", card)).toHaveFocus();
  });
  click(getAction("button", "Email options", card));
  expect(getAction("link", "okou@okou.io")).toHaveAttribute(
    "href",
    "mailto:okou@okou.io",
  );
});

test("opens unsigned email settings with the login email connected", async () => {
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails: [emailAddress],
      availableEmails: [emailAddress],
      emailSources: {},
    });
  });
  await setupPage({
    context,
    path: "/settings/email",
    featureSwitches: featureSwitches(),
    auth: {
      user: {
        id: "user_email_settings_primary",
        fullName: "Email User",
        email: emailAddress,
      },
    },
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Email connections",
  });
  expect(window.location.pathname).toBe("/works");
  expect(within(dialog).getByText(emailAddress)).toBeInTheDocument();
  expect(getAction("button", "Add email", dialog)).toBeEnabled();
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    expect(
      getAction("button", "Email options", getIntegrationCard("Email")),
    ).toHaveFocus();
  });
});

test("keeps a failed code request in the dialog and lets the user retry", async () => {
  let fail = true;
  context.mocks.api(integrationsEmailContract.createLinkCode, ({ respond }) => {
    if (fail) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Please try again" },
      });
    }
    return respond(200, {
      code: "12345678",
      expiresAt: "2026-11-10T08:10:00.000Z",
    });
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: featureSwitches(),
  });
  const card = getIntegrationCard("Email");
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  click(getAction("button", "Connect", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Email connections",
  });
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Could not create a connection code. Try again.",
  );
  fail = false;
  click(getAction("button", "Add email", dialog));
  await expect(
    within(dialog).findByText("12345678"),
  ).resolves.toBeInTheDocument();
});
