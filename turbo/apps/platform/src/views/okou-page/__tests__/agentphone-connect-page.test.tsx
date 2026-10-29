import userEvent from "@testing-library/user-event";
import { act, screen, waitFor } from "@testing-library/react";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { integrationsWhatsappContract } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const PHONE_HANDLE = "+15555550123";
const AGENT_ID = "agt_provider_identity";
const TIMESTAMP = 1_784_880_000;
const SIGNATURE = "a".repeat(64);

function connectPath(signature: string): string {
  const search = new URLSearchParams({
    handle: PHONE_HANDLE,
    agent: AGENT_ID,
    ts: String(TIMESTAMP),
    sig: signature,
    channel: "sms",
  });
  return `/settings/agentphone?${search.toString()}`;
}

function findConnectButton(): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === "Connect";
  });
}

function getControl(role: "button" | "link", text: string): HTMLElement {
  const control = queryAllByRoleFast(role).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === text;
  });
  if (!control) {
    throw new Error(`Expected ${role} named "${text}"`);
  }
  return control;
}

function getConnectButton(): HTMLElement {
  const button = findConnectButton();
  if (!button) {
    throw new Error('Expected button named "Connect"');
  }
  return button;
}

test("rejects connection links with a malformed signature", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: connectPath("not-a-signature"),
  });

  await expect(
    screen.findByText("The signature on this link is not valid."),
  ).resolves.toBeInTheDocument();
  expect(findConnectButton()).toBeUndefined();
});

test("connects a signed link without sending brand fields", async () => {
  const requests: unknown[] = [];
  context.mocks.api(
    integrationsAgentPhoneContract.connectAgentPhone,
    ({ body, respond }) => {
      requests.push(body);
      return respond(200, { phoneHandle: PHONE_HANDLE });
    },
  );
  await setupPage({
    context,
    host: "app.okou.ai",
    path: connectPath(SIGNATURE),
  });

  await expect(
    screen.findByText("Connect phone number"),
  ).resolves.toBeInTheDocument();
  click(getConnectButton());

  await expect(
    screen.findByText("Phone number connected"),
  ).resolves.toBeInTheDocument();
  expect(getControl("link", "Open Messages")).toHaveAttribute(
    "href",
    "sms:+19039853128",
  );
  expect(getControl("link", "Back to settings")).toHaveAttribute(
    "href",
    "/works",
  );
  expect(requests).toStrictEqual([
    {
      phoneHandle: PHONE_HANDLE,
      agentphoneAgentId: AGENT_ID,
      timestamp: TIMESTAMP,
      signature: SIGNATURE,
      channel: "sms",
    },
  ]);
});

function connectedTo(phoneHandle: string) {
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
}

test("shows the existing connection without another Connect action", async () => {
  connectedTo(PHONE_HANDLE);
  await setupPage({ context, path: connectPath(SIGNATURE) });
  await expect(
    screen.findByText("Phone number connected"),
  ).resolves.toBeInTheDocument();
  expect(findConnectButton()).toBeUndefined();
});

test("offers an explicit switch and sends the confirmed previous number", async () => {
  const previousPhone = "+15555550456";
  connectedTo(previousPhone);
  const requests: unknown[] = [];
  context.mocks.api(
    integrationsAgentPhoneContract.connectAgentPhone,
    ({ body, respond }) => {
      requests.push(body);
      return respond(200, { phoneHandle: PHONE_HANDLE });
    },
  );
  await setupPage({ context, path: connectPath(SIGNATURE) });
  const switchButton = await waitFor(() => {
    return getControl("button", `Switch to ${PHONE_HANDLE}`);
  });
  expect(getControl("link", `Keep ${previousPhone}`)).toHaveAttribute(
    "href",
    "/works",
  );
  expect(requests).toHaveLength(0);
  click(switchButton);
  await expect(
    screen.findByText("Phone number connected"),
  ).resolves.toBeInTheDocument();
  expect(requests).toStrictEqual([
    {
      phoneHandle: PHONE_HANDLE,
      agentphoneAgentId: AGENT_ID,
      timestamp: TIMESTAMP,
      signature: SIGNATURE,
      channel: "sms",
      replacePhoneHandle: previousPhone,
    },
  ]);
});

test("shows an occupied number before offering a connection", async () => {
  context.mocks.api(
    integrationsAgentPhoneContract.getConnectStatus,
    ({ respond }) => {
      return respond(200, { kind: "phone_in_use" });
    },
  );
  await setupPage({ context, path: connectPath(SIGNATURE) });
  await expect(
    screen.findByText("Phone number already connected"),
  ).resolves.toBeInTheDocument();
  expect(findConnectButton()).toBeUndefined();
});

test("keeps the switch confirmation when its signed link expires", async () => {
  const previousPhone = "+15555550456";
  connectedTo(previousPhone);
  context.mocks.api(
    integrationsAgentPhoneContract.connectAgentPhone,
    ({ respond }) => {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid or expired connection link. Send /connect again.",
        },
      });
    },
  );
  await setupPage({ context, path: connectPath(SIGNATURE) });
  click(
    await waitFor(() => {
      return getControl("button", `Switch to ${PHONE_HANDLE}`);
    }),
  );
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Invalid or expired connection link",
  );
  expect(getControl("link", `Keep ${previousPhone}`)).toBeInTheDocument();
});

test("shows a connection-status read failure without a Connect action", async () => {
  context.mocks.api(
    integrationsAgentPhoneContract.getConnectStatus,
    ({ respond }) => {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: "This connection link has expired.",
        },
      });
    },
  );
  await setupPage({ context, path: connectPath(SIGNATURE) });
  await expect(
    screen.findByText("This connection link has expired.", { selector: "p" }),
  ).resolves.toBeInTheDocument();
  expect(findConnectButton()).toBeUndefined();
});

test.each([PHONE_HANDLE, "sender@example.com"])(
  "shows the connected overview and opens the official conversation for %s",
  async (phone) => {
    connectedTo(phone);
    await setupPage({ context, path: "/settings/agentphone" });
    await expect(
      screen.findByText("Phone number connected"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        `${phone} is connected. Send a text message to start chatting with Okou.`,
      ),
    ).toBeInTheDocument();
    expect(getControl("link", "Open Messages")).toHaveAttribute(
      "href",
      "sms:+19039853128",
    );
    expect(getControl("link", "Back to settings")).toHaveAttribute(
      "href",
      "/works",
    );
  },
);

test("opens the shared connection dialog from the unlinked overview and shows completion", async () => {
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: "12345678",
        expiresAt: "2026-10-28T10:00:00Z",
      });
    },
  );
  await setupPage({ context, path: "/settings/agentphone" });
  await expect(
    screen.findByText("Connect phone number"),
  ).resolves.toBeInTheDocument();
  click(getConnectButton());
  await screen.findByRole("dialog");
  await expect(
    screen.findByTestId("agentphone-link-qr"),
  ).resolves.toHaveAttribute("data-sms-href", "sms:+19039853128?body=12345678");
  connectedTo(PHONE_HANDLE);
  act(() => {
    return context.mocks.ably.trigger("agentphone:changed");
  });
  await expect(
    screen.findByText("Phone number connected"),
  ).resolves.toBeInTheDocument();
  expect(getControl("link", "Open Messages")).toHaveAttribute(
    "href",
    "sms:+19039853128",
  );
});

test("shows when phone connection is unavailable", async () => {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    configured: false,
    agentPhoneNumber: null,
  });
  await setupPage({ context, path: "/settings/agentphone" });
  await expect(
    screen.findByText("Phone connection is currently unavailable."),
  ).resolves.toBeInTheDocument();
  expect(findConnectButton()).toBeUndefined();
  expect(getControl("link", "Back to settings")).toBeInTheDocument();
});

function whatsappPath() {
  return connectPath(SIGNATURE)
    .replace("/settings/agentphone", "/settings/whatsapp")
    .replace("channel=sms", "channel=whatsapp");
}

test("connects a signed WhatsApp link through its own API and opens WhatsApp", async () => {
  const requests: unknown[] = [];
  context.mocks.api(
    integrationsWhatsappContract.getConnectStatus,
    ({ respond }) => {
      return respond(200, { kind: "connect" });
    },
  );
  context.mocks.api(
    integrationsWhatsappContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: false,
        agentPhoneNumber: "+19039853128",
        configured: true,
      });
    },
  );
  context.mocks.api(
    integrationsWhatsappContract.connectWhatsapp,
    ({ body, respond }) => {
      requests.push(body);
      return respond(200, { phoneHandle: PHONE_HANDLE });
    },
  );
  await setupPage({
    context,
    path: whatsappPath(),
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
  await expect(
    screen.findByText("Connect WhatsApp"),
  ).resolves.toBeInTheDocument();
  click(getConnectButton());
  await expect(
    screen.findByText("WhatsApp connected"),
  ).resolves.toBeInTheDocument();
  expect(getControl("link", "Open WhatsApp")).toHaveAttribute(
    "href",
    "https://wa.me/19039853128",
  );
  expect(requests).toStrictEqual([
    {
      phoneHandle: PHONE_HANDLE,
      agentphoneAgentId: AGENT_ID,
      timestamp: TIMESTAMP,
      signature: SIGNATURE,
      channel: "whatsapp",
    },
  ]);
});

test("confirms the current WhatsApp number before replacing it", async () => {
  const previous = "+4915123456789";
  const requests: unknown[] = [];
  context.mocks.api(
    integrationsWhatsappContract.getConnectStatus,
    ({ respond }) => {
      return respond(200, {
        kind: "phone_mismatch",
        currentPhoneHandle: previous,
      });
    },
  );
  context.mocks.api(
    integrationsWhatsappContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: true,
        phoneHandle: previous,
        agentPhoneNumber: "+19039853128",
        configured: true,
      });
    },
  );
  context.mocks.api(
    integrationsWhatsappContract.connectWhatsapp,
    ({ body, respond }) => {
      requests.push(body);
      return respond(200, { phoneHandle: PHONE_HANDLE });
    },
  );
  await setupPage({
    context,
    path: whatsappPath(),
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
  const action = await waitFor(() => {
    return getControl("button", `Switch to ${PHONE_HANDLE}`);
  });
  expect(requests).toHaveLength(0);
  click(action);
  await expect(
    screen.findByText("WhatsApp connected"),
  ).resolves.toBeInTheDocument();
  expect(requests).toStrictEqual([
    expect.objectContaining({
      replacePhoneHandle: previous,
      channel: "whatsapp",
    }),
  ]);
});

test("keeps the WhatsApp connection page unavailable when its switch is off", async () => {
  await setupPage({
    context,
    path: whatsappPath(),
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: false },
  });
  await expect(
    screen.findByText("WhatsApp is not configured yet"),
  ).resolves.toBeInTheDocument();
  expect(findConnectButton()).toBeUndefined();
});

test("offers the existing WhatsApp QR flow from its dedicated settings page", async () => {
  context.mocks.api(
    integrationsWhatsappContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: false,
        agentPhoneNumber: "+19039853128",
        configured: true,
      });
    },
  );
  context.mocks.api(
    integrationsWhatsappContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code: "12345678",
        expiresAt: "2026-10-29T01:10:00.000Z",
      });
    },
  );
  await setupPage({
    context,
    path: "/settings/whatsapp",
    featureSwitches: { [FeatureSwitchKey.WhatsappIntegration]: true },
  });
  await expect(
    screen.findByText("Connect WhatsApp"),
  ).resolves.toBeInTheDocument();
  const connectButton = getConnectButton();
  connectButton.focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    screen.findByRole("dialog", { name: "Connect WhatsApp" }),
  ).resolves.toBeInTheDocument();
  await expect(
    waitFor(() => {
      return getControl("link", "Open WhatsApp");
    }),
  ).resolves.toHaveAttribute("href", "https://wa.me/19039853128?text=12345678");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(connectButton).toHaveFocus();
});
