import {
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { recoveryPage, sol, luna } from "./model-recovery-account-fixtures.ts";
const context = testContext();
async function selectLuna(card: HTMLElement) {
  const picker = await within(card).findByRole("combobox");
  click(picker);
  click(await screen.findByRole("option", { name: /GPT 5.6 Luna/ }));
}
const errors = [
  {
    id: "chat-run-models-054",
    reason: "unsupported_model",
    error: "Model is no longer available",
    heading: "Selected model isn't available",
  },
  {
    id: "chat-run-models-055",
    reason: "provider_bad_request",
    error:
      'Bad Request: {"error":{"message":"invalid request","type":"invalid_request_error"}}',
    heading: "The model provider returned an error",
  },
] as const;
test.each(errors)(
  "$id Retry waits for the replacement model after $heading",
  async ({ reason, error, heading }) => {
    const { sent } = await recoveryPage(context, { reason, error });
    const card = await screen.findByTestId("assistant-error-recovery");
    await expect(within(card).findByText(heading)).resolves.toBeVisible();
    const pending = context.mocks.deferred<void>(),
      release = context.mocks.deferred<void>();
    let selected = sol;
    context.mocks.api(
      chatThreadModelSelectionContract.update,
      async ({ body, respond }) => {
        pending.resolve();
        await release.promise;
        selected = body.model ?? sol;
        return respond(204);
      },
    );
    context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: "Recovery",
        selectedModel: selected,
        serviceTier: null,
        modelSettings: {},
        pinnedAt: null,
        archived: false,
        muted: false,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
      });
    });
    await selectLuna(card);
    await pending.promise;
    const retry = await findFastControl("button", "Try again", card);
    expect(retry).toBeDisabled();
    expect(sent).toStrictEqual([]);
    release.resolve();
    await waitFor(() => {
      return expect(retry).toBeEnabled();
    });
    click(retry);
    await expect(screen.findByText("continue")).resolves.toBeVisible();
    expect(sent).toStrictEqual([
      expect.objectContaining({
        prompt: "continue",
        parts: expect.arrayContaining([
          expect.objectContaining({ type: "model", selectedModel: luna }),
        ]),
      }),
    ]);
  },
);
test("chat-run-models-043 Both exhausted windows stay visible while the account details, model switch and reset remain usable", async () => {
  const { sent } = await recoveryPage(context, { weekly: true, remaining: 2 });
  const card = await screen.findByTestId("assistant-error-recovery");
  const trigger = await findFastControl("button", "View details", card);
  const checkWindows = (container: HTMLElement) => {
    expect(container).toHaveTextContent(/5h resets.*Aug 2, 2026/i);
    expect(container).toHaveTextContent(/Week resets.*Aug 8, 2026/i);
  };
  checkWindows(card);
  const user = userEvent.setup({ delay: null });
  trigger.focus();
  await user.keyboard("{Enter}");
  let dialog = await screen.findByRole("dialog");
  checkWindows(dialog);
  expect(dialog).toHaveTextContent("current@example.com");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  await user.keyboard("{Enter}");
  dialog = await screen.findByRole("dialog");
  checkWindows(dialog);
  await user.keyboard("{Escape}");
  await expect(
    findFastControl("button", "Try again", card),
  ).resolves.toBeEnabled();
  await selectLuna(card);
  await waitFor(() => {
    return expect(within(card).getByRole("combobox")).toHaveAttribute(
      "aria-label",
      "GPT 5.6 Luna",
    );
  });
  await expect(
    findFastControl("button", "Try again", card),
  ).resolves.toBeEnabled();
  click(await findFastControl("button", /Reset.*2 left/, card));
  await screen.findByText("continue");
  expect(sent).toContainEqual(expect.objectContaining({ prompt: "continue" }));
});
