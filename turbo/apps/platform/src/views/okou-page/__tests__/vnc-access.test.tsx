import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createComposerConnectorHelpers } from "./chat-composer-connectors-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { mockRemoteInventory } from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

test("Chat VNC setup appears and filters", async () => {
  installComposerConnectorFixture();
  // No SSH or VNC connections are configured yet.
  mockRemoteInventory(context);
  await setupPage({ context, path: "/" });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const catalog = search.closest<HTMLElement>('[role="dialog"]');
  if (!catalog) {
    throw new Error("Expected the connector catalog dialog");
  }
  await expect(
    findFastControl("link", "Manage SSH hosts", catalog),
  ).resolves.toBeInTheDocument();

  await fill(search, "vnc");

  // Filtering drops the SSH entry while the VNC entry stays.
  await waitFor(() => {
    expect(
      queryFastControl("link", "Manage SSH hosts", catalog),
    ).not.toBeInTheDocument();
  });
  expect(queryFastControl("link", "Manage VNC", catalog)).toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&type=vnc",
  );
});
