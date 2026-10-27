import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const COMPLIANCE_TITLE = "Okou’s compliance, built for your trust";

function mountedAgent(): void {
  const agent: AgentResponse = {
    agentId: AGENT_ID,
    isDefaultAgent: false,
    ownerId: "test-user-123",
    displayName: "Nova",
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
}

test("The chat home lists the compliance statuses", async () => {
  mountedAgent();

  await setupPage({
    context,
    locale: "en-US",
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ChatHomeCompliance]: true },
  });

  const region = await screen.findByRole("region", { name: COMPLIANCE_TITLE });
  const statuses = within(region)
    .getAllByRole("listitem")
    .map((item) => {
      return item.textContent;
    });
  // SOC 2 must read as in progress, never as certified.
  expect(statuses).toStrictEqual([
    "SOC 2 Type IIIn progress",
    "CCPA / CPRACompliant",
    "GDPRCompliant",
    "HIPAAAligned",
    "ISO/IEC 27001Aligned",
  ]);
});

test("The chat home shows no compliance row while the switch is off", async () => {
  mountedAgent();

  await setupPage({
    context,
    locale: "en-US",
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByTestId("chat-tagline");
  expect(
    screen.queryByRole("region", { name: COMPLIANCE_TITLE }),
  ).not.toBeInTheDocument();
});
