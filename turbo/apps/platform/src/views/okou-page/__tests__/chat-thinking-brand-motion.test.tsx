import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  thinkingBrandMotionImg,
  thinkingSpinnerImg,
} from "../platform-assets.ts";
import {
  createChatRunFixtures,
  findButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

test.each([
  { enabled: false, image: thinkingSpinnerImg },
  { enabled: true, image: thinkingBrandMotionImg },
])(
  "Show the selected thinking artwork during a run (brand motion: $enabled)",
  async ({ enabled, image }) => {
    const runAccepted = context.mocks.deferred<void>();
    const lifecycle = installRunChat({ sendGate: runAccepted.promise });

    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: {
        [FeatureSwitchKey.ChatThinkingBrandMotion]: enabled,
      },
    });
    await readyChat();
    await sendText("Verify event data collection");

    const label = await screen.findByText("Thinking...");
    // The artwork is decorative; the adjacent thinking label owns its meaning.
    const artwork = label
      .closest('[data-role="assistant-thinking"]')
      ?.querySelector("[data-thinking-loader] img");
    expect(artwork).toHaveAttribute("src", image);
    expect(artwork).toHaveAttribute("alt", "");

    runAccepted.resolve(undefined);
    await expect(findButton("Stop")).resolves.toBeInTheDocument();
    lifecycle.completeRun("Event data collection is verified.");

    await expect(
      screen.findByText("Event data collection is verified."),
    ).resolves.toBeInTheDocument();
    await expect(findButton("Send")).resolves.toBeInTheDocument();
  },
);
