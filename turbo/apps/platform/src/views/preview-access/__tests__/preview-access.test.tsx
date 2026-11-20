import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const PREVIEW_ACCESS_HEADER = "x-vercel-protection-bypass";

test("Trusted preview access reaches the matching preview API", async () => {
  let requestedService = "";
  let forwardedAccess: string | null = null;
  context.mocks.api(userExportContract.get, ({ request, respond }) => {
    requestedService = new URL(request.url).hostname;
    forwardedAccess = request.headers.get(PREVIEW_ACCESS_HEADER);
    return respond(200, { job: null, canExport: true, nextExportAt: null });
  });

  await setupPage({
    context,
    path: "/export?x-vercel-protection-bypass=preview-secret",
    host: "pr-431-app.omby.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "Export data" }),
  ).resolves.toBeVisible();
  expect(requestedService).toBe("pr-431-api.vm6.ai");
  expect(forwardedAccess).toBe("preview-secret");
});
