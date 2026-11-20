import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("Trusted preview access reaches the matching preview API", async () => {
  const secret = "preview-secret-431";
  const statusRequest: {
    latest: { origin: string; bypass: string | null } | null;
  } = { latest: null };
  context.mocks.api(userExportContract.get, ({ request, respond }) => {
    statusRequest.latest = {
      origin: new URL(request.url).origin,
      bypass: request.headers.get("x-vercel-protection-bypass"),
    };
    return respond(200, { job: null, canExport: true, nextExportAt: null });
  });

  await setupPage({
    context,
    path: `/export?x-vercel-protection-bypass=${secret}`,
    host: "pr-431-app.omby.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "Export data" }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Export my data"),
  ).resolves.toBeInTheDocument();
  expect(statusRequest.latest).toStrictEqual({
    origin: "https://pr-431-api.vm6.ai",
    bypass: secret,
  });
});
