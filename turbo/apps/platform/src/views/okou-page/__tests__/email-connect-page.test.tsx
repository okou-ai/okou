import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { integrationsEmailContract } from "@okouai/api-contracts/contracts/integrations-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
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
  return { [FeatureSwitchKey.EmailIntegration]: true };
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

test("automatically connects the original email after authentication", async () => {
  let requestBody: unknown;
  context.mocks.api(integrationsEmailContract.connect, ({ body, respond }) => {
    requestBody = body;
    return respond(200, { emailAddress });
  });
  await setupPage({ context, path, featureSwitches: featureSwitches() });
  await expect(
    screen.findByText("Email connected"),
  ).resolves.toBeInTheDocument();
  expect(requestBody).toStrictEqual(proof());
  expect(control("link", "Open email")).toHaveAttribute(
    "href",
    "mailto:okou@okou.io",
  );
});

test("explains an expired connection without asking the user to resend account details", async () => {
  context.mocks.api(integrationsEmailContract.connect, ({ respond }) => {
    return respond(400, {
      error: {
        code: "BAD_REQUEST",
        message:
          "Invalid or expired email connection link. Send a new email to Okou.",
      },
    });
  });
  await setupPage({ context, path, featureSwitches: featureSwitches() });
  await expect(
    screen.findByText(/Invalid or expired email connection link/u),
  ).resolves.toBeInTheDocument();
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
    expect(getAction("button", "Add email", card)).toBeEnabled();
  });
  click(getAction("button", "Add email", card));
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
    expect(getAction("button", "Add email", card)).toBeEnabled();
  });
  click(getAction("button", "Add email", card));
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

test("deletes each linked address from Manage and returns focus to Add email", async () => {
  const secondEmail = "second@example.com";
  let emails = [emailAddress, secondEmail];
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails,
      availableEmails: [emailAddress, secondEmail],
      emailSources: {},
    });
  });
  context.mocks.api(integrationsEmailContract.unlink, ({ body, respond }) => {
    emails = emails.filter((email) => {
      return email !== body.emailAddress;
    });
    return respond(204);
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: featureSwitches(),
  });
  const card = getIntegrationCard("Email");
  await expect(
    within(card).findByText(emailAddress),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Email options", card));
  click(getAction("button", "Manage"));
  const dialog = await screen.findByRole("dialog", {
    name: "Email connections",
  });
  click(
    getAction(
      "button",
      `Delete ${emailAddress}`,
      emailRow(dialog, emailAddress),
    ),
  );
  await waitFor(() => {
    expect(within(dialog).queryByText(emailAddress)).not.toBeInTheDocument();
  });
  expect(within(dialog).getByText(secondEmail)).toBeInTheDocument();
  click(
    getAction("button", `Delete ${secondEmail}`, emailRow(dialog, secondEmail)),
  );
  await waitFor(() => {
    expect(within(dialog).queryByText(secondEmail)).not.toBeInTheDocument();
  });
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    expect(getAction("button", "Add email", card)).toHaveFocus();
  });
});

function control(role: "button" | "link", label: string): HTMLElement {
  const element = queryAllByRoleFast(role).find((item) => {
    return item.textContent?.trim() === label;
  });
  if (!element) {
    throw new Error("Expected control: " + label);
  }
  return element;
}

function emailRow(dialog: HTMLElement, email: string): HTMLElement {
  return within(dialog).getByRole("row", { name: email });
}

function emailSource(
  row: HTMLElement,
  source: string,
): HTMLElement | undefined {
  return queryAllByRoleFast("cell", row).find((item) => {
    return item.textContent?.trim() === source;
  });
}

test("manages multiple connections and adds another mailbox without leaving Works", async () => {
  const second = "other@outlook.example";
  const third = "new@gmail.example";
  let emails = [emailAddress, second];
  const code = "87654321";
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails,
      availableEmails: [emailAddress],
      emailSources: { [emailAddress]: "gmail", [second]: "outlook" },
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
    expect(getAction("button", "Email options", card)).toBeEnabled();
  });
  click(getAction("button", "Email options", card));
  click(getAction("button", "Manage"));
  const dialog = await screen.findByRole("dialog", {
    name: "Email connections",
  });
  expect(within(dialog).getByText(emailAddress)).toBeInTheDocument();
  expect(within(dialog).getByText(second)).toBeInTheDocument();
  expect(
    emailSource(emailRow(dialog, emailAddress), "Gmail"),
  ).toBeInTheDocument();
  expect(emailSource(emailRow(dialog, second), "Outlook")).toBeInTheDocument();
  click(getAction("button", "Add email", dialog));
  await expect(within(dialog).findByText(code)).resolves.toBeInTheDocument();
  emails = [...emails, third];
  await context.mocks.ably.trigger("email:changed");
  await expect(within(dialog).findByText(third)).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/works");
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    expect(getAction("button", "Email options", card)).toHaveFocus();
  });
});

test("keeps the login email connected while other emails can be deleted", async () => {
  const secondary = "removable@example.com";
  let emails = [emailAddress, secondary];
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails,
      availableEmails: [emailAddress],
      emailSources: {},
    });
  });
  context.mocks.api(integrationsEmailContract.unlink, ({ body, respond }) => {
    expect(body.emailAddress).toBe(secondary);
    emails = [emailAddress];
    return respond(204);
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: featureSwitches(),
    auth: {
      user: {
        id: "user_email_primary",
        fullName: "Email User",
        email: emailAddress,
      },
    },
  });
  const card = getIntegrationCard("Email");
  await waitFor(() => {
    expect(getAction("button", "Email options", card)).toBeEnabled();
  });
  click(getAction("button", "Email options", card));
  click(getAction("button", "Manage"));
  const dialog = await screen.findByRole("dialog", {
    name: "Email connections",
  });
  expect(
    emailSource(emailRow(dialog, emailAddress), "Login email"),
  ).toBeInTheDocument();
  click(
    getAction("button", `Delete ${secondary}`, emailRow(dialog, secondary)),
  );
  await waitFor(() => {
    expect(within(dialog).queryByText(secondary)).not.toBeInTheDocument();
  });
  expect(
    emailSource(emailRow(dialog, emailAddress), "Login email"),
  ).toBeInTheDocument();
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    expect(getAction("button", "Email options", card)).toHaveFocus();
  });
});
