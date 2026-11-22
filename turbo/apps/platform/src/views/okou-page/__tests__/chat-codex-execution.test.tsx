import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const sol = "gpt-6.1-sol";
test.each([
  ["001", false],
  ["004", true],
] as const)(
  "chat-codex-execution-%s the saved Ultra effort falls back to the maximum available to this execution route",
  async (_id, codex) => {
    const { rows } = accountModels(context, [sol], null);
    if (codex) {
      context.mocks.data.availableRunModels(
        rows.map((row) => {
          return {
            ...row,
            subscriptionOptions: {
              ...row.subscriptionOptions!,
              efforts: ["low", "medium", "high", "xhigh", "max"],
            },
          };
        }),
      );
    }
    mockChatLifecycle(context, {
      threadId: RUN_THREAD_ID,
      selectedModel: sol,
      reasoningEffort: "ultra",
    });
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.CodexExecution]: codex },
    });
    const panel = await openModelPanel("GPT 6.1 Sol, Max");
    const slider = within(panel).getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
    expect(within(panel).queryByText("Ultra")).toBeNull();
    slider.focus();
    await userEvent.keyboard("{End}");
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  },
);
