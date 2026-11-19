import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { getMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";
import { NEW_CHAT_PATH } from "./chat-run-test-fixtures.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const context = testContext();

async function openNewChatModels(): Promise<HTMLElement> {
  await setupPage({ context, path: NEW_CHAT_PATH });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  return await openModelPanel("Auto");
}

function optionNames(panel: HTMLElement): (string | undefined)[] {
  return queryAllByRoleFast("radio", panel).map((option) => {
    return option.textContent?.trim();
  });
}

test("Offer the active catalog models in catalog order with catalog names", async () => {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    ["gpt-6-luna", "claude-fable-5", "claude-sonnet-5"].map((model) => {
      return buildRunModel({ model });
    }),
  );

  const panel = await openNewChatModels();

  expect(optionNames(panel)).toStrictEqual([
    "Auto",
    "Claude Sonnet 5",
    "GPT 6 Luna",
  ]);
});

test("Offer Auto from canonical available-model and catalog responses", async () => {
  installConnectedPersonalSubscriptions(context);
  const catalog = getMockModelCatalog();
  context.mocks.api(modelCatalogContract.get, ({ respond }) => {
    return respond(200, {
      systemDefaultModel: "auto",
      models: catalog.models.map((model) => {
        return model.model === "okou-1.0"
          ? { ...model, model: "auto", resolvedModel: "auto" }
          : model;
      }),
      routes: catalog.routes.map((route) => {
        return route.model === "okou-1.0" ? { ...route, model: "auto" } : route;
      }),
    });
  });
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, {
      models: [
        { ...buildRunModel({ model: null }), model: "auto" },
        buildRunModel({ model: "gpt-6-luna" }),
      ],
    });
  });
  context.mocks.data.userModelPreference({
    selectedModel: "auto",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-09-30T09:00:00.000Z",
  });

  const panel = await openNewChatModels();

  expect(optionNames(panel)).toStrictEqual(["Auto", "GPT 6 Luna"]);
});
