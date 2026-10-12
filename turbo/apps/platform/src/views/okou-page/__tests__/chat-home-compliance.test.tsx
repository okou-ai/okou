import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
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

test("The chat home lists the compliance statuses with a security link", async () => {
  mountedAgent();

  await setupPage({
    context,
    locale: "en-US",
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ChatHomeCompliance]: true },
  });

  const region = await screen.findByRole("region", { name: COMPLIANCE_TITLE });
  const badges = Array.from(region.querySelectorAll('[data-slot="badge"]')).map(
    (badge) => {
      return badge.textContent;
    },
  );
  // SOC 2 must read as in progress, never as certified.
  expect(badges).toStrictEqual([
    "SOC 2 Type IIIn progress",
    "CCPA / CPRACompliant",
    "GDPRCompliant",
    "HIPAAAligned",
    "ISO/IEC 27001Aligned",
  ]);
  const link = queryAllByRoleFast("link", region).find((candidate) => {
    return candidate.textContent?.trim() === "Security details";
  });
  expect(link).toHaveAttribute(
    "href",
    "https://www.okou.ai/en/security#security-compliance-title",
  );
});

test("The chat home shows no compliance row while the switch is off", async () => {
  mountedAgent();

  await setupPage({
    context,
    locale: "en-US",
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByTestId("chat-tagline");
  expect(screen.queryByText(COMPLIANCE_TITLE)).not.toBeInTheDocument();
});

test("Every locale links to the English compliance section", async () => {
  mountedAgent();

  await setupPage({
    context,
    locale: "ja-JP",
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ChatHomeCompliance]: true },
  });

  // Only the English security page carries the compliance section, so a
  // Japanese app still links there.
  const region = await screen.findByRole("region", {
    name: COMPLIANCE_TITLE,
  });
  const link = queryAllByRoleFast("link", region).find((candidate) => {
    return candidate.textContent?.trim() === "Security details";
  });
  expect(link).toHaveAttribute(
    "href",
    "https://www.okou.ai/en/security#security-compliance-title",
  );
});
