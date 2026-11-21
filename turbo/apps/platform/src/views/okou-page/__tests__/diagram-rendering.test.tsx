import mermaid from "@okouai/mermaid-lite";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
warmMermaidParser();

const FAILING = "flowchart LR\n  Intake --> Triage";
const SURVIVING = "flowchart LR\n  Draft --> Review";

function expandActions(): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === "Expand diagram";
  });
}

test("A failed Mermaid layout leaves its source readable and other diagrams usable", async () => {
  // The browser layout engine cannot lay out the first diagram.
  const render = mermaid.render;
  vi.spyOn(mermaid, "render").mockImplementation((id, code) => {
    return code === FAILING
      ? Promise.reject(new Error("Diagram layout failed"))
      : render(id, code);
  });
  installCapabilityChat({
    events: completedConversation(
      [
        "Two process views:",
        "",
        "```mermaid",
        FAILING,
        "```",
        "",
        "```mermaid",
        SURVIVING,
        "```",
      ].join("\n"),
    ),
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const failedSource = await screen.findByText(/Intake --> Triage/u);
  expect(failedSource.closest("code, pre")).not.toBeNull();
  // Only the surviving diagram rendered, so it alone offers expansion.
  const expand = await waitFor(() => {
    const actions = expandActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toBeEnabled();
    return actions[0] as HTMLElement;
  });

  click(expand);

  await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
});
