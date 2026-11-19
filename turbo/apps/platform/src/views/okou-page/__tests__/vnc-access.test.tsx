import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  SCOUT_AGENT_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

test("Chat VNC setup appears and filters", async () => {
  installComposerConnectorFixture();
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const dialog = search.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Missing connector dialog");
  }
  await findFastControl("link", "Manage VNC", dialog);
  await fill(search, "vnc");
  await expect(
    findFastControl("link", "Manage VNC", dialog),
  ).resolves.toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&type=vnc",
  );
  expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
});
