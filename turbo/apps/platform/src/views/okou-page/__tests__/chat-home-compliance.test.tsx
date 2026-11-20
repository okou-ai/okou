import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const COMPLIANCE_TITLE = "Okou’s compliance, built for your trust";

test("The chat home lists the compliance statuses", async () => {
  await setupPage({
    context,
    locale: "en-US",
    path: "/",
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
