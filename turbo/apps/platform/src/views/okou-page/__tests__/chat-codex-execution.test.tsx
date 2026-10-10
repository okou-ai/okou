import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { createMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import { buildRunModel } from "./chat-composer-test-helpers.ts";
import {
  closeModelPanel,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const MODEL = "gpt-6.1-sol";

function configureModel(): void {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels([buildRunModel({ model: MODEL })]);
}

test.each([
  { enabled: false, effort: "Max" },
  { enabled: true, effort: "Ultra" },
])(
  "shows catalog-supported $effort for a saved Ultra preference when Codex execution is $enabled",
  async ({ enabled, effort }) => {
    const updates: { reasoningEffort?: string | null }[] = [];
    installRunChat({
      selectedModel: MODEL,
      reasoningEffort: "ultra",
      onModelSelectionUpdate: (body) => {
        updates.push(body);
      },
    });
    configureModel();
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.CodexExecution]: enabled },
    });
    await readyChat();
    const panel = await openModelPanel(`GPT 6.1 Sol, ${effort}`);
    expect(
      within(panel).getByRole("slider", { name: "Effort" }),
    ).toHaveAttribute("aria-valuetext", effort);
    expect(updates).toStrictEqual([]);
  },
);

test("does not expand the catalog's efforts when Codex execution is enabled", async () => {
  installRunChat({ selectedModel: MODEL, reasoningEffort: "ultra" });
  configureModel();
  const catalog = createMockModelCatalog();
  context.mocks.api(modelCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...catalog,
      routes: catalog.routes.map((route) => {
        return route.model === MODEL
          ? {
              ...route,
              efforts: route.efforts.filter((effort) => {
                return effort !== "ultra";
              }),
            }
          : route;
      }),
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.CodexExecution]: true },
  });
  await readyChat();
  const panel = await openModelPanel("GPT 6.1 Sol, Max");
  expect(within(panel).getByRole("slider", { name: "Effort" })).toHaveAttribute(
    "aria-valuetext",
    "Max",
  );
  expect(within(panel).queryByText("Ultra")).not.toBeInTheDocument();
});

test("sends a new Codex chat with the catalog-supported Ultra effort selected in the model panel", async () => {
  const user = userEvent.setup({ delay: null });
  const creates: { model?: string | null; reasoningEffort?: string }[] = [];
  installRunChat({
    selectedModel: MODEL,
    onThreadCreate: (body) => {
      creates.push(body);
    },
  });
  configureModel();
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.CodexExecution]: true },
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const panel = await openModelPanel("GPT 6.1 Sol, Max");
  within(panel).getByRole("slider", { name: "Effort" }).focus();
  await user.keyboard("{End}");
  await expect(findButton("GPT 6.1 Sol, Ultra")).resolves.toBeInTheDocument();
  await closeModelPanel();
  await user.click(composer);
  await fillComposer(composer, "Run this through Codex at Ultra effort");
  click(await findButton("Send"));
  await waitFor(() => {
    expect(creates).toContainEqual(
      expect.objectContaining({ model: MODEL, reasoningEffort: "ultra" }),
    );
  });
});
