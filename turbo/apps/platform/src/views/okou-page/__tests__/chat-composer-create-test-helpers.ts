import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockPersonalModelRoutes,
} from "./chat-composer-test-helpers.ts";

export function setupModels(): void {
  mockAgent();
  mockPersonalModelRoutes();
  mockBillingCapabilities({
    restrictedBuiltInModels: false,
  });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
}

export function button(
  label: string,
  container: ParentNode = document,
): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((item) => {
    return (
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label
    );
  });
  if (!result) {
    throw new Error(`Expected button ${label}`);
  }
  return result;
}

export async function setupComposer(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  return await findComposerEditor();
}

/** The panel's rows act on mousedown, which only a full pointer sequence fires. */
export async function clickPanelRow(
  label: string,
  menu: HTMLElement,
): Promise<void> {
  await userEvent.setup({ delay: null }).click(button(label, menu));
  await closeTemplatePicker();
}

/** The panel row that enters a create mode, and the chip it leaves behind. */
export const CREATE_MODE_ROWS = {
  presentation: { row: "Presentation", task: "Presentation" },
  image: { row: "Illustration", task: "Image" },
} as const;

/** The footer chip is the type, and its accessible name is how to leave it. */
export function taskChip(task: "Presentation" | "Image"): HTMLElement {
  return button(`Remove ${task}`);
}

/**
 * A panel row opens the template picker as well as entering the mode, and the
 * open dialog covers the composer. Close it to go on reading the composer.
 */
async function closeTemplatePicker(): Promise<void> {
  const dialog = await screen.findByRole("dialog");
  await userEvent.setup({ delay: null }).click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

/** Lands the composer on a create mode from an already open slash panel. */
export async function enterCreateMode(
  command: keyof typeof CREATE_MODE_ROWS,
  menu: HTMLElement,
): Promise<void> {
  const { row, task } = CREATE_MODE_ROWS[command];
  await clickPanelRow(row, menu);
  await waitFor(() => {
    expect(taskChip(task)).toBeInTheDocument();
  });
}

export async function chooseCommand(
  editor: HTMLElement,
  text: string,
  command: keyof typeof CREATE_MODE_ROWS,
): Promise<void> {
  await fill(editor, text);
  await enterCreateMode(
    command,
    await screen.findByTestId("slash-workflow-menu"),
  );
}

export const createTemplateScenarios = [
  {
    mode: "image",
    commandLabel: "Create image",
    pickerLabel: "Add style",
    selectLabel: "Select template",
    previewLabel: "Preview template",
    templates: ILLUSTRATION_TEMPLATE_ITEMS.map((template) => {
      return {
        ...template,
        request: {
          type: "illustration" as const,
          selection: { illustrationStyleId: template.illustrationStyleId },
        },
      };
    }),
  },
  {
    mode: "presentation",
    commandLabel: "Create presentation",
    pickerLabel: "Add template",
    selectLabel: "Select template",
    previewLabel: "Preview template",
    templates: PRESENTATION_TEMPLATE_PICKER_ITEMS.map((template) => {
      return {
        ...template,
        request: {
          type: "presentation" as const,
          selection: {
            templateId: template.templateId,
            colorSystemId: template.colorSystemId,
          },
        },
      };
    }),
  },
] as const;
