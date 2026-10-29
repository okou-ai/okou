import {
  integrationsWhatsappContract as contract,
  type WhatsappLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const sharedNumber = "+12025550199";
function mockStatus(getStatus: () => WhatsappLinkStatusResponse) {
  context.mocks.api(contract.getLinkStatus, ({ respond }) => {
    return respond(200, getStatus());
  });
}

test("WhatsApp connects with the same shared number and a prefilled code, updates in realtime and disconnects", async () => {
  let linked = false;
  mockStatus(() => {
    return linked
      ? {
          linked: true,
          phoneHandle: "+4915123456789",
          agentPhoneNumber: sharedNumber,
          configured: true,
        }
      : { linked: false, agentPhoneNumber: sharedNumber, configured: true };
  });
  context.mocks.api(contract.createLinkCode, ({ respond }) => {
    return respond(200, {
      code: "12345678",
      expiresAt: "2026-10-28T00:10:00.000Z",
    });
  });
  context.mocks.api(contract.unlink, ({ respond }) => {
    linked = false;
    return respond(204);
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
  const card = getIntegrationCard("WhatsApp");
  click(getAction("button", "Connect WhatsApp", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect WhatsApp",
  });
  const link = await waitFor(() => {
    return getAction("link", "Open WhatsApp", dialog);
  });
  expect(link).toHaveAttribute(
    "href",
    "https://wa.me/12025550199?text=12345678",
  );
  expect(within(dialog).getByTestId("whatsapp-link-qr")).toHaveAttribute(
    "data-whatsapp-href",
    "https://wa.me/12025550199?text=12345678",
  );
  expect(within(dialog).getByText("12345678")).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "WhatsApp availability is subject to Meta's policies.",
    ),
  ).toBeInTheDocument();
  linked = true;
  context.mocks.ably.trigger("agentphone:changed");
  await expect(
    within(card).findByText("Connected (+4915123456789)"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connect WhatsApp" }),
    ).not.toBeInTheDocument();
  });
  click(getAction("button", "WhatsApp options", card));
  click(
    await waitFor(() => {
      return getAction("button", "Disconnect");
    }),
  );
  await expect(
    waitFor(() => {
      return getAction("button", "Connect WhatsApp", card);
    }),
  ).resolves.toBeInTheDocument();
});

test("WhatsApp does not offer a connection before the shared number is configured", async () => {
  mockStatus(() => {
    return {
      linked: false,
      agentPhoneNumber: sharedNumber,
      configured: false,
    };
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
  const card = getIntegrationCard("WhatsApp");
  expect(
    within(card).getByText("WhatsApp is not configured yet"),
  ).toBeInTheDocument();
  expect(getAction("button", "Connect WhatsApp", card)).toBeDisabled();
});

test("WhatsApp opens from the keyboard and returns focus after Escape", async () => {
  const user = userEvent.setup();
  mockStatus(() => {
    return {
      linked: false,
      agentPhoneNumber: sharedNumber,
      configured: true,
    };
  });
  context.mocks.api(contract.createLinkCode, ({ respond }) => {
    return respond(200, {
      code: "12345678",
      expiresAt: "2026-10-28T00:10:00.000Z",
    });
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
  const connectButton = getAction(
    "button",
    "Connect WhatsApp",
    getIntegrationCard("WhatsApp"),
  );
  connectButton.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Connect WhatsApp",
  });
  await expect(
    within(dialog).findByText("12345678"),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Connect WhatsApp" }),
    ).not.toBeInTheDocument();
    expect(connectButton).toHaveFocus();
  });
});

test("WhatsApp stays hidden while its feature switch is off", async () => {
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: false },
  });
  expect(screen.getByText("Phone")).toBeInTheDocument();
  expect(screen.queryByText("WhatsApp")).not.toBeInTheDocument();
});
