import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { recoveryPage, sol, luna } from "./model-recovery-account-fixtures.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";
import { sendText } from "./chat-run-test-fixtures.ts";
const context = testContext();
const card = () => {
  return screen.findByTestId("assistant-error-recovery");
};
test("chat-run-models-032 Auto is the first and only automatic choice above the selected subscription model", async () => {
  await recoveryPage(context, { selected: luna, live: true });
  const panel = await openModelPanel("GPT 5.6 Luna");
  const rows = within(panel).getAllByRole("radio");
  const choices = rows.map((r) => {
    return r.textContent?.trim();
  });
  expect(choices[0]).toMatch(/^Auto\b/);
  expect(
    choices.filter((name) => {
      return name?.match(/^Auto\b/);
    }),
  ).toHaveLength(1);
  expect(choices).toContain("GPT 5.6 Luna");
});
test("chat-run-models-042 The same two-row failure card gains its account details after classification", async () => {
  const gate = context.mocks.deferred<void>();
  await recoveryPage(context, { accountGate: gate.promise });
  const pending = await screen.findByTestId("assistant-error-card-loading"),
    shell = pending.closest('[data-testid="assistant-error-card-shell"]');
  expect(shell).toBeInTheDocument();
  const description = within(pending).getByTestId(
    "assistant-error-description",
  );
  expect(description).toHaveAttribute("aria-hidden", "true");
  expect(description.parentElement?.children).toHaveLength(2);
  gate.resolve();
  const settled = await card();
  expect(settled.closest('[data-testid="assistant-error-card-shell"]')).toBe(
    shell,
  );
  const subtitle = within(settled).getByTestId("assistant-error-description");
  expect(subtitle.parentElement?.children).toHaveLength(2);
  expect(subtitle).toBeVisible();
  expect(subtitle.previousElementSibling).toHaveTextContent(
    "Model provider limit reached",
  );
  expect(settled).toHaveTextContent("current@example.com");
  await expect(
    findFastControl("button", "Try again", settled),
  ).resolves.toBeEnabled();
});
test("chat-run-models-044 The recovery card for a newly failed run identifies its account and five-hour reset", async () => {
  const { lifecycle } = await recoveryPage(context, { live: true });
  await sendText("Check the new account quota");
  await screen.findByText("Check the new account quota");
  lifecycle.failRun("Current subscription limit reached", "usage_limit");
  const recovery = await card();
  expect(recovery).toHaveTextContent("current@example.com");
  expect(recovery).toHaveTextContent(/Aug(?:ust)? 1,? 2026/i);
  expect(
    within(recovery).getByTestId("assistant-error-description"),
  ).toBeVisible();
});
test("chat-run-models-047 The last reset credit applies to the current account before continuing", async () => {
  const { sent, reset, provider } = await recoveryPage(context);
  const recovery = await card();
  expect(recovery).toHaveTextContent("current@example.com");
  const details = await findFastControl("button", /details/i, recovery);
  click(details);
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("current@example.com");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(sent).toStrictEqual([]);
  click(await findFastControl("button", /Reset.*1 left/, recovery));
  await waitFor(() => {
    return expect(sent).toContainEqual(
      expect.objectContaining({ prompt: "continue" }),
    );
  });
  expect(reset).toStrictEqual([provider.id]);
  await expect(screen.findByText("continue")).resolves.toBeVisible();
});
test("chat-run-models-048 A disconnected personal account offers retry without a reset action", async () => {
  await recoveryPage(context, { disconnected: true });
  const recovery = await card();
  expect(recovery).toHaveTextContent("Personal subscription disconnected");
  expect(queryFastControl("button", /Reset/, recovery)).toBeNull();
  await expect(
    findFastControl("button", "Try again", recovery),
  ).resolves.toBeEnabled();
});
test("chat-run-models-049 A limit with no selected model has no personal account or reset action", async () => {
  await recoveryPage(context, { selected: null });
  const recovery = await card();
  expect(recovery).toHaveTextContent("Model provider limit reached");
  expect(recovery).not.toHaveTextContent(
    /personal subscription|current@example.com/i,
  );
  expect(queryFastControl("button", /Reset/, recovery)).toBeNull();
  await expect(
    findFastControl("button", "Try again", recovery),
  ).resolves.toBeEnabled();
});
test("chat-run-models-050 An unavailable subscription leaves the composer usable and sends no continuation", async () => {
  const { sent } = await recoveryPage(context, { noReset: true });
  const recovery = await card();
  click(await findFastControl("button", /Reset.*1 left/, recovery));
  await expect(
    screen.findByText(/subscription unavailable/i),
  ).resolves.toBeVisible();
  expect(sent).toStrictEqual([]);
  const editor = document.querySelector<HTMLElement>(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  expect(editor).toBeVisible();
  expect(editor).not.toHaveAttribute("aria-disabled", "true");
});
const limits = [
  {
    id: "chat-run-models-051",
    reason: "execution_timeout",
    error: "Run execution time limit reached",
  },
  {
    id: "chat-run-models-052",
    reason: "unknown",
    error: "AUTONOMY_BUDGET_EXHAUSTED",
  },
] as const;
test.each(limits)(
  "$id Continue on $error uses the chat model without offering a picker or a subscription reset",
  async ({ reason, error }) => {
    const { sent } = await recoveryPage(context, { reason, error });
    const recovery = await card();
    expect(
      queryFastControl("button", /Reset|GPT 5.6 Sol|Select model/, recovery),
    ).toBeNull();
    click(await findFastControl("button", "Continue", recovery));
    await screen.findByText("continue");
    expect(sent).toStrictEqual([
      expect.objectContaining({
        prompt: "continue",
        parts: expect.arrayContaining([
          expect.objectContaining({ type: "model", selectedModel: sol }),
        ]),
      }),
    ]);
  },
);
