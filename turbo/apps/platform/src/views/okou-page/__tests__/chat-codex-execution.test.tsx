import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
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

test("chat-codex-execution-003 returning from Lab restores the saved Ultra effort when Codex becomes available", async () => {
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    selectedModel: sol,
    reasoningEffort: "ultra",
  });
  const { rows } = accountModels(context, [sol], sol);
  context.mocks.data.availableRunModels(
    rows.map((row) => {
      return {
        ...row,
        subscriptionOptions: {
          ...row.subscriptionOptions!,
          efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      };
    }),
  );
  let codexEnabled = false;
  function savedLabSettings() {
    const switches = {
      [FeatureSwitchKey.Lab]: true,
      [FeatureSwitchKey.CodexExecution]: codexEnabled,
    };
    return { switches, effectiveSwitches: switches };
  }
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, savedLabSettings());
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    codexEnabled =
      body.switches[FeatureSwitchKey.CodexExecution] ?? codexEnabled;
    return respond(200, savedLabSettings());
  });
  await setupPage({
    context,
    path: RUN_PATH,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: {
          id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
          name: "Lab workspace",
        },
        memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
      },
    },
  });
  await screen.findByLabelText("GPT 6.1 Sol, Max");
  click(await findFastControl("button", "Test User"));
  click(await screen.findByText("Lab", { selector: '[role="menuitem"] *' }));
  const control = await screen.findByRole("switch", {
    name: /^Codex execution/i,
  });
  expect(control).not.toBeChecked();
  click(control);
  await waitFor(() => {
    expect(control).toBeChecked();
  });
  act(() => {
    history.back();
  });
  await waitFor(() => {
    expect(location.pathname).toBe(RUN_PATH);
  });
  await screen.findByLabelText("GPT 6.1 Sol, Ultra");
});
