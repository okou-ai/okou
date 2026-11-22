import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import {
  composerModelTrigger,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";

const context = testContext();

async function openComposer(fast = false) {
  const sol = "gpt-5.6-sol";
  accountModels(
    context,
    [sol],
    sol,
    { [sol]: { effort: "low" } },
    fast ? "priority" : null,
  );
  await setupPage({ context, path: "/" });
  const label = fast ? "GPT 5.6 Sol, Low, Fast" : "GPT 5.6 Sol, Low";
  await composerModelTrigger(label);
  return label;
}
async function holdRefresh() {
  const gate = context.mocks.deferred<void>(),
    arrived = context.mocks.deferred<void>();
  context.mocks.api(runModelsMainContract.list, async ({ respond }) => {
    arrived.resolve();
    await gate.promise;
    return respond(500, {
      error: {
        code: "INTERNAL_ERROR",
        message: "Routing refresh unavailable",
      },
    });
  });
  context.mocks.ably.trigger("runModelsChanged", {});
  await arrived.promise;
  expect(screen.queryByText("Routing refresh unavailable")).toBeNull();
  return async () => {
    gate.resolve();
    await screen.findByText("Routing refresh unavailable");
  };
}
test("chat-model-projection-refresh-002 the unsent draft survives a pending and a rejected model refresh", async () => {
  await openComposer();
  const editor = await findComposerEditor();
  await fill(editor, "Keep this unsent draft");
  const deliver = await holdRefresh();
  expect(editor).toHaveTextContent("Keep this unsent draft");
  await deliver();
  expect(editor).toHaveTextContent("Keep this unsent draft");
});
test("chat-model-projection-refresh-003 the Low model selection remains during refresh and after its error", async () => {
  const label = await openComposer();
  const deliver = await holdRefresh();
  await expect(composerModelTrigger(label)).resolves.toBeInTheDocument();
  await deliver();
  await expect(composerModelTrigger(label)).resolves.toBeInTheDocument();
});
test("chat-model-projection-refresh-004 the failed refresh preserves Fast mode in the model panel", async () => {
  const label = await openComposer(true);
  const deliver = await holdRefresh();
  await deliver();
  const panel = await openModelPanel(label);
  await expect(
    within(panel).findByRole("switch", { name: "Fast mode" }),
  ).resolves.toBeChecked();
});
