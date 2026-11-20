import { screen } from "@testing-library/react";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { expect, test } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { testContext } from "./test-helpers.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

const context = testContext();

async function waitForReadyPage(): Promise<void> {
  await screen.findByText("Oops! Something went sideways");
}

function client() {
  return context.store.get(apiClient$)(userBuiltinConnectorsContract);
}

test("An empty service error still gives the user a useful status", async () => {
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "" },
    });
  });

  await setupPage({ context, path: "/_/error" });

  await waitForReadyPage();

  await expect(
    accept(client().get({ params: { id: AGENT_ID } }), [200]),
  ).rejects.toThrow("HTTP 403");

  await screen.findByText("HTTP 403");
});

test("The update dialog appears only when an update is required", async () => {
  context.mocks.http.get("*/api/agents/:id/user-connectors", () => {
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });

  await setupPage({ context, path: "/_/error" });

  await waitForReadyPage();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await client().get({ params: { id: AGENT_ID } });

  const dialog = await screen.findByRole("dialog", {
    name: "Update required",
  });
  expect(dialog).toHaveTextContent(
    "We've released new features in Okou. Refresh to get the latest version.",
  );
});
