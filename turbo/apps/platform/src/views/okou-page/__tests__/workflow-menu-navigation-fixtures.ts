import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  composerWorkflow,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
const thread = "b0000000-0000-4000-a000-000000000900";
export async function slashMenu(
  context: TestContext,
  options: {
    desktop?: boolean;
    actions?: boolean;
    many?: boolean;
    geometry?: (editor: HTMLElement) => void;
  } = {},
) {
  const names = options.many
    ? Array.from({ length: 12 }, (_, index) => {
        return "daily-" + (index + 1);
      })
    : ["axiom-red", "axiom-status", "axiom-traces"];
  const catalog = names.map((name) => {
    return composerWorkflow(
      name,
      "Inspect " + name + "; additional usage instructions.",
    );
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, catalog);
  });
  context.mocks.browser.matchMedia(options.desktop ?? true);
  accountModels(
    context,
    ["claude-fable-5-1", "claude-sonnet-5"],
    "claude-fable-5-1",
  );
  mockChatLifecycle(context, {
    threadId: thread,
    selectedModel: "claude-fable-5-1",
  });
  await setupPage({
    context,
    path: "/chats/" + thread,
    featureSwitches: {
      [FeatureSwitchKey.SlashActions]: options.actions ?? false,
    },
  });
  const editor = await findComposerEditor();
  options.geometry?.(editor);
  await fill(editor, "Draft /");
  const panel = await screen.findByTestId("slash-workflow-menu");
  return { editor, panel };
}
export function move(editor: HTMLElement, key: string) {
  fireEvent.keyDown(editor, { key });
}
export function active(panel: HTMLElement) {
  return Array.from(
    panel.querySelectorAll<HTMLElement>('button[data-active="true"]'),
  ).at(-1);
}
export function moveTo(editor: HTMLElement, panel: HTMLElement, name: string) {
  const count = panel.querySelectorAll("button").length;
  for (let step = 0; step <= count; step++) {
    if (active(panel)?.textContent?.trim().startsWith(name)) {
      return;
    }
    move(editor, "ArrowDown");
  }
  throw new Error(
    "Unable to select " +
      name +
      " with the keyboard. Current choice: " +
      active(panel)?.textContent,
  );
}
export async function closed(panel: HTMLElement) {
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
}
