import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { getFeatureSwitchMetadata } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { createMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import {
  closeModelPanel,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import {
  findButton,
  NEW_CHAT_PATH,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

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
    installRunChat({ selectedModel: MODEL, reasoningEffort: "ultra" });
    configureModel();
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.CodexExecution]: enabled },
    });
    const panel = await openModelPanel(`GPT 6.1 Sol, ${effort}`);
    expect(
      within(panel).getByRole("slider", { name: "Effort" }),
    ).toHaveAttribute("aria-valuetext", effort);
  },
);

test("enabling Codex in Lab preserves a saved Ultra preference that Pi cannot use", async () => {
  installRunChat({ selectedModel: MODEL, reasoningEffort: "ultra" });
  configureModel();
  let switches: Record<string, boolean> = {
    [FeatureSwitchKey.CodexExecution]: false,
    [FeatureSwitchKey.Lab]: true,
  };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches, effectiveSwitches: switches });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    switches = { ...switches, ...body.switches };
    return respond(200, { switches, effectiveSwitches: switches });
  });
  await setupPage({ context, path: RUN_PATH });
  await expect(findButton("GPT 6.1 Sol, Max")).resolves.toBeInTheDocument();

  click(await findButton("Test User"));
  click(await screen.findByText("Lab"));
  const maintainer = getFeatureSwitchMetadata()[
    FeatureSwitchKey.CodexExecution
  ].maintainer.replace(/@.*$/u, "");
  const maintainerFilter = await screen.findByText(maintainer);
  click(maintainerFilter);
  expect(maintainerFilter.closest("button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const row = (await screen.findByText("Codex execution (test only)")).closest(
    "li",
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error("Codex execution test switch row was not found");
  }
  const toggle = within(row).getByRole("switch");
  expect(toggle).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    expect(toggle).toBeChecked();
  });
  click(await screen.findByText("Run conversation"));
  await expect(findButton("GPT 6.1 Sol, Ultra")).resolves.toBeInTheDocument();
});

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
