import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { integrationsAgentPhoneContract as phoneApi } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { integrationsWhatsappContract as whatsAppApi } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { externalProtocolHandler } from "../../../test/mocks/external-protocol-handler.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { DetachedBrowserContext } from "happy-dom";

const context = testContext();
const requested = "+15555550123";
const previous = "+15555550456";
const service = "+19039853128";
const code = {
  code: "12345678",
  expiresAt: "2030-02-01T12:00:00.000Z",
} as const;
const phonePath = "/settings/agentphone";
const whatsAppPath = "/settings/whatsapp";
function signed(channel = "sms", sig = "42".repeat(32)) {
  return (
    "?" +
    new URLSearchParams({
      channel,
      handle: requested,
      agent: "local-device",
      ts: "1795159200",
      sig,
    })
  );
}
function linked(phoneHandle: string) {
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle,
    agentPhoneNumber: service,
    configured: true,
  });
}
function open(path: string) {
  return setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
}
async function followSettings(label: string) {
  click(screen.getByText(label));
  await waitFor(() => {
    expect(location.pathname).toBe("/works");
  });
  await expect(
    screen.findByRole("heading", { name: /Where .+ works/u }),
  ).resolves.toBeInTheDocument();
}

test("agentphone-connect-page-001 A malformed local proof explains why linking cannot start", async () => {
  await open(phonePath + signed("sms", "local-invalid"));
  await expect(
    screen.findByText("The signature on this link is not valid."),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("Connect", { selector: "button" }),
  ).not.toBeInTheDocument();
});
test("agentphone-connect-page-003 The signed recipient recognizes the number already linked", async () => {
  linked(requested);
  await open(phonePath + signed());
  await expect(
    screen.findByRole("heading", { name: "Phone number connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("Connect", { selector: "button" }),
  ).not.toBeInTheDocument();
});
test("agentphone-connect-page-004 Keeping the old number returns to Works and switching replaces that number", async () => {
  const replacements: (string | undefined)[] = [];
  linked(previous);
  context.mocks.api(phoneApi.connectAgentPhone, ({ body, respond }) => {
    replacements.push(body.replacePhoneHandle);
    return respond(200, { phoneHandle: body.phoneHandle });
  });
  await open(phonePath + signed());
  await screen.findByText("Switch to " + requested);
  await followSettings("Keep " + previous);
  expect(replacements).toStrictEqual([]);
  history.back();
  const switchPhone = await screen.findByText("Switch to " + requested);
  expect(replacements).toStrictEqual([]);
  click(switchPhone);
  await expect(
    screen.findByRole("heading", { name: "Phone number connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(requested + " is connected.", { exact: false }),
  ).toBeInTheDocument();
  expect(new Set(replacements)).toStrictEqual(new Set([previous]));
});
test("agentphone-connect-page-006 A rejected switch preserves a working exit for the current number", async () => {
  linked(previous);
  const message = "This connection link is invalid or expired.";
  context.mocks.api(phoneApi.connectAgentPhone, ({ respond }) => {
    return respond(400, { error: { code: "BAD_REQUEST", message } });
  });
  await open(phonePath + signed());
  click(await screen.findByText("Switch to " + requested));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(message);
  await followSettings("Keep " + previous);
});
test("agentphone-connect-page-008 The linked overview addresses Messages to the service number and returns to Works", async () => {
  linked(requested);
  const messages = externalProtocolHandler("sms:");
  await open(phonePath);
  await expect(
    screen.findByText(
      requested +
        " is connected. Send a text message to start chatting with Okou.",
    ),
  ).resolves.toBeInTheDocument();
  click(screen.getByText("Open Messages"));
  expect(messages).toStrictEqual(["sms:" + service]);
  await followSettings("Back to settings");
});
test("agentphone-connect-page-010 A live phone connection replaces the code dialog with the plain Messages destination", async () => {
  const messages = externalProtocolHandler("sms:");
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    configured: true,
    agentPhoneNumber: service,
  });
  context.mocks.api(phoneApi.createLinkCode, ({ respond }) => {
    return respond(200, code);
  });
  await open(phonePath);
  click(await screen.findByText("Connect", { selector: "button" }));
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByText(code.code);
  const sms = "sms:" + service;
  expect(dialog.getByTestId("agentphone-link-qr")).toHaveAttribute(
    "data-sms-href",
    sms + "?body=" + code.code,
  );
  click(dialog.getByText("Open Messages"));
  expect(messages).toStrictEqual([sms + "?body=" + code.code]);
  linked(requested);
  context.mocks.ably.trigger("agentphone:changed");
  await expect(
    screen.findByRole("heading", { name: "Phone number connected" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  click(screen.getByText("Open Messages"));
  expect(messages).toStrictEqual([sms + "?body=" + code.code, sms]);
});
test("agentphone-connect-page-013 WhatsApp replaces the verified old number after explicit consent", async () => {
  const old = "+4915123456789";
  const requests: (string | undefined)[] = [];
  context.mocks.api(whatsAppApi.getLinkStatus, ({ respond }) => {
    return respond(200, {
      linked: true,
      phoneHandle: old,
      agentPhoneNumber: service,
      configured: true,
    });
  });
  context.mocks.api(whatsAppApi.getConnectStatus, ({ respond }) => {
    return respond(200, { kind: "phone_mismatch", currentPhoneHandle: old });
  });
  context.mocks.api(whatsAppApi.connectWhatsapp, ({ body, respond }) => {
    requests.push(body.replacePhoneHandle);
    return respond(200, { phoneHandle: body.phoneHandle });
  });
  await open(whatsAppPath + signed("whatsapp"));
  const change = await screen.findByText("Switch to " + requested);
  expect(requests).toStrictEqual([]);
  click(change);
  await expect(
    screen.findByRole("heading", { name: "WhatsApp connected" }),
  ).resolves.toBeInTheDocument();
  expect(new Set(requests)).toStrictEqual(new Set([old]));
});
test("agentphone-connect-page-015 Keyboard connection opens the verified WhatsApp conversation and restores focus on Escape", async () => {
  context.mocks.api(whatsAppApi.getLinkStatus, ({ respond }) => {
    return respond(200, {
      linked: false,
      agentPhoneNumber: service,
      configured: true,
    });
  });
  context.mocks.api(whatsAppApi.createLinkCode, ({ respond }) => {
    return respond(200, code);
  });
  const conversation = "https://wa.me/19039853128";
  context.mocks.http.get(conversation, () => {
    return new Response("<title>Local conversation</title>", {
      headers: { "content-type": "text/html" },
    });
  });
  await open(whatsAppPath);
  const connect = await screen.findByText("Connect", { selector: "button" });
  connect.focus();
  expect(connect).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Connect WhatsApp",
  });
  await within(dialog).findByText(code.code);
  const tabs = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  click(within(dialog).getByText("Open WhatsApp"));
  const tab = tabs.mock.results.at(-1)?.value;
  try {
    await waitFor(() => {
      expect(tab?.url).toBe(conversation + "?text=" + code.code);
      expect(tab?.mainFrame.document.title).toBe("Local conversation");
    });
  } finally {
    await tab?.close();
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(connect).toHaveFocus();
});
