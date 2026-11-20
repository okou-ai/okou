import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { thinkingBrandMotionImg } from "../platform-assets.ts";
import {
  createChatRunFixtures,
  findButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

test("Show the brand thinking artwork during a run", async () => {
  const runAccepted = context.mocks.deferred<void>();
  const lifecycle = installRunChat({ sendGate: runAccepted.promise });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await sendText("Verify event data collection");

  const label = await screen.findByText("Thinking...");
  // The artwork is decorative; the adjacent thinking label owns its meaning.
  const artwork = label
    .closest('[data-role="assistant-thinking"]')
    ?.querySelector("[data-thinking-loader] img");
  expect(artwork).toHaveAttribute("src", thinkingBrandMotionImg);
  expect(artwork).toHaveAttribute("alt", "");

  runAccepted.resolve(undefined);
  await expect(findButton("Stop")).resolves.toBeInTheDocument();
  lifecycle.completeRun("Event data collection is verified.");

  await expect(
    screen.findByText("Event data collection is verified."),
  ).resolves.toBeInTheDocument();
  await expect(findButton("Send")).resolves.toBeInTheDocument();
});
