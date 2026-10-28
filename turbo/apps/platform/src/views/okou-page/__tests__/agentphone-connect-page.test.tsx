import { screen, waitFor } from "@testing-library/react";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
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

test("opens the phone settings without a signed link", async () => {
  connectedTo(PHONE_HANDLE);
  await setupPage({ context, path: "/settings/agentphone" });
  await expect(
    screen.findByTestId("agentphone-connected-indicator"),
  ).resolves.toHaveTextContent(PHONE_HANDLE);
});
