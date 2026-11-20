import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

const context = testContext();
const NOVA_AGENT_ID = "c0000000-0000-4000-a000-000000000d71";

test("The chat home lists the compliance statuses", async () => {
  context.mocks.data.agents([
    { agentId: NOVA_AGENT_ID, displayName: "Nova", visibility: "public" },
  ]);
  context.mocks.browser.matchMedia((query) => {
    return [SIDEBAR_DESKTOP_MEDIA_QUERY, "(min-width: 1280px)"].includes(query);
  });

  await setupPage({ context, path: `/agents/${NOVA_AGENT_ID}/chat` });

  const compliance = await screen.findByRole("region", {
    name: "Okou’s compliance, built for your trust",
  });
  expect(
    [...compliance.querySelectorAll("li")].map((item) => {
      // Each item names the framework, then its status.
      return [...item.querySelectorAll(":scope > span > span")].map((part) => {
        return part.textContent?.trim();
      });
    }),
  ).toStrictEqual([
    ["SOC 2 Type II", "In progress"],
    ["CCPA / CPRA", "Compliant"],
    ["GDPR", "Compliant"],
    ["HIPAA", "Aligned"],
    ["ISO/IEC 27001", "Aligned"],
  ]);
  expect(compliance).not.toHaveTextContent(/certified/iu);
});
