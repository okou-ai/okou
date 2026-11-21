import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const RUN_ID = "d0000000-0000-4000-a000-000000000d81";

/** The value shown beside the activity's Duration label. */
function durationValue(): string | undefined {
  const label = screen.getByText("Duration");
  return label.nextElementSibling?.textContent?.trim();
}

test("French uses local number formatting", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: RUN_ID,
      sessionId: null,
      agentId: "c0000000-0000-4000-a000-000000000d81",
      displayName: "Quarterly summary",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Summarize the quarter",
      appendSystemPrompt: null,
      createdAt: "2026-11-21T09:00:00.000Z",
      startedAt: "2026-11-21T09:00:01.000Z",
      completedAt: "2026-11-21T09:00:02.200Z",
    });
  });
  await setupPage({
    context,
    path: `/activities/${RUN_ID}?settings=preference`,
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(durationValue()).toBe("1.2s");
  const user = userEvent.setup({ delay: null });

  await user.click(
    within(settings).getByRole("combobox", { name: "Language" }),
  );
  await user.click(await screen.findByRole("option", { name: "Français" }));
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
  });
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(settings).not.toBeInTheDocument();
  });
  expect(durationValue()).toBe("1,2s");
});
