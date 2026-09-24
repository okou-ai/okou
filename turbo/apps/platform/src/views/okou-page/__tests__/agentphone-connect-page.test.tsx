import { screen } from "@testing-library/react";
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
  return `/agentphone/connect?${search.toString()}`;
}

function findConnectButton(): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === "Connect";
  });
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
