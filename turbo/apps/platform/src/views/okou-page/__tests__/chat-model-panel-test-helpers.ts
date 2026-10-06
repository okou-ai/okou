import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

type ModelOptionLabel = string | RegExp | ((name: string) => boolean);

/**
 * Open the composer's model panel from its trigger. The trigger is matched by
 * its full name ("Model, Effort, Fast") or by the model name alone.
 */
export async function openModelPanel(
  triggerLabel: string,
): Promise<HTMLElement> {
  click(await composerModelTrigger(triggerLabel));
  return await screen.findByRole("dialog", { name: "Chat models" });
}

/**
 * The panel is a popover: changing the model, effort or Fast keeps it open, so
 * tests close it the way a user does.
 */
export async function closeModelPanel(): Promise<void> {
  const panel = screen.queryByRole("dialog", { name: "Chat models" });
  if (!panel) {
    return;
  }
  fireEvent.keyDown(panel, { key: "Escape" });
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Chat models" }),
    ).not.toBeInTheDocument();
  });
}

/** A model row in the panel, matched by its visible text. */
export function queryModelOption(
  label: ModelOptionLabel,
  container: ParentNode = document,
): HTMLElement | null {
  return (
    queryAllByRoleFast("radio", container).find((option) => {
      const name = option.textContent?.replace(/\s+/gu, " ").trim() ?? "";
      if (typeof label === "function") {
        return label(name);
      }
      return typeof label === "string" ? name === label : label.test(name);
    }) ?? null
  );
}

export function modelOption(
  label: ModelOptionLabel,
  container: ParentNode = document,
): HTMLElement {
  const option = queryModelOption(label, container);
  if (!option) {
    throw new Error(`Expected model option ${label}`);
  }
  return option;
}

export async function findModelOption(
  label: ModelOptionLabel,
  container: ParentNode = document,
): Promise<HTMLElement> {
  return await waitFor(() => {
    return modelOption(label, container);
  });
}
