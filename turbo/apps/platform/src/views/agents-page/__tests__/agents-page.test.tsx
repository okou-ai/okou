import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each(["direct", "message-port"] as const)(
  "An Agents bookmark opens My Okou settings (%s)",
  async (sharedWorkerTestTransport) => {
    await setupPage({ context, path: "/agents", sharedWorkerTestTransport });
    await expect(
      screen.findByRole("dialog", { name: "Settings" }),
    ).resolves.toBeVisible();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  },
);
