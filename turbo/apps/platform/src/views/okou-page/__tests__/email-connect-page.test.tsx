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

test("connects, disconnects, and reconnects email from the Works card", async () => {
  let linked = false;
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails: linked ? [emailAddress] : [],
      availableEmails: [emailAddress],
    });
  });
  context.mocks.api(integrationsEmailContract.unlink, ({ body, respond }) => {
    expect(body.emailAddress).toBe(emailAddress);
    linked = false;
    return respond(204);
  });
  context.mocks.api(
    integrationsEmailContract.connectAddress,
    ({ body, respond }) => {
      expect(body.emailAddress).toBe(emailAddress);
      linked = true;
      return respond(200, { emailAddress });
    },
  );
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
  const dialog = await screen.findByRole("dialog", { name: "Email Okou" });
  expect(window.location.pathname).toBe("/works");
  expect(within(dialog).getByText(emailAddress)).toBeInTheDocument();
  expect(getAction("link", "okou@okou.io", dialog)).toHaveAttribute(
    "href",
    "mailto:okou@okou.io",
  );
  click(getAction("button", "Connect", dialog));
  await waitFor(() => {
    expect(within(card).getByText(emailAddress)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(getAction("button", "Email options", card));
  click(getAction("button", "Disconnect"));
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
  });
  click(getAction("button", "Connect", card));
  const reconnectDialog = await screen.findByRole("dialog", {
    name: "Email Okou",
  });
  click(getAction("button", "Connect", reconnectDialog));
  await waitFor(() => {
    expect(within(card).getByText(emailAddress)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe("/works");
});

test("opens the email dialog on Works for an unsigned settings link", async () => {
  await setupPage({
    context,
    path: "/settings/email",
    featureSwitches: featureSwitches(),
  });
  const dialog = await screen.findByRole("dialog", { name: "Email Okou" });
  expect(window.location.pathname).toBe("/works");
  expect(within(dialog).getByText(emailAddress)).toBeInTheDocument();
  click(getAction("button", "Close", dialog));
  expect(
    getAction("button", "Connect", getIntegrationCard("Email")),
  ).toBeEnabled();
});

test("closes the email dialog when an address connects from email", async () => {
  let linked = false;
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails: linked ? [emailAddress] : [],
      availableEmails: [],
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
  const dialog = await screen.findByRole("dialog", { name: "Email Okou" });
  expect(getAction("link", "okou@okou.io", dialog)).toHaveAttribute(
    "href",
    "mailto:okou@okou.io",
  );
  linked = true;
  await context.mocks.ably.trigger("email:changed");
  await waitFor(() => {
    expect(within(card).getByText(emailAddress)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test("keeps a failed connection in the dialog and lets the user retry", async () => {
  let linked = false;
  let fail = true;
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails: linked ? [emailAddress] : [],
      availableEmails: [emailAddress],
    });
  });
  context.mocks.api(integrationsEmailContract.connectAddress, ({ respond }) => {
    if (fail) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Please try again" },
      });
    }
    linked = true;
    return respond(200, { emailAddress });
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
  const dialog = await screen.findByRole("dialog", { name: "Email Okou" });
  click(getAction("button", "Connect", dialog));
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Unable to load your email connection",
  );
  fail = false;
  click(getAction("button", "Connect", dialog));
  await waitFor(() => {
    expect(within(card).getByText(emailAddress)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test("disconnects each linked address from its own menu action", async () => {
  const secondEmail = "second@example.com";
  let emails = [emailAddress, secondEmail];
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails,
      availableEmails: [],
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
  click(getAction("button", `Disconnect ${emailAddress}`));
  await expect(
    within(card).findByText(secondEmail),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Disconnect"));
  await waitFor(() => {
    expect(getAction("button", "Connect", card)).toBeEnabled();
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
