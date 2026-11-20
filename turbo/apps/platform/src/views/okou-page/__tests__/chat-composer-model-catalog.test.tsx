import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { getMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import {
  mockSubscriptionRunModel,
  mockAutoRunModel,
} from "../../../mocks/handlers/api-run-models.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";
import { createChatRunFixtures } from "./chat-run-test-fixtures.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const context = testContext();

async function newChatChoices() {
  await setupPage({ context, path: "/" });
  const panel = await openModelPanel("Auto");
  await within(panel).findByText("GPT 6 Luna");
  return queryAllByRoleFast("radio", panel).map((option) => {
    return option.textContent?.trim();
  });
}

test("chat-composer-model-catalog-001 orders eligible choices by their catalog entries", async () => {
  createChatRunFixtures(context).installRunChat({ selectedModel: null });
  installConnectedPersonalSubscriptions(context);
  const available = ["gpt-6-luna", "claude-fable-5", "claude-sonnet-5"].map(
    (model) => {
      return mockSubscriptionRunModel(model, { modelLabel: model });
    },
  );
  context.mocks.data.availableRunModels(available);
  await expect(newChatChoices()).resolves.toStrictEqual([
    "Auto",
    "Claude Sonnet 5",
    "GPT 6 Luna",
  ]);
});

test("chat-composer-model-catalog-002 shows the canonical Auto preference beside the available subscription", async () => {
  const catalog = getMockModelCatalog();
  const luna = "gpt-6-luna";
  const auto = catalog.models.find((entry) => {
    return entry.model === catalog.systemDefaultModel;
  })!;
  const builtin = catalog.routes.find((entry) => {
    return entry.model === auto.model;
  })!;
  const subscription = catalog.models.find((entry) => {
    return entry.model === luna;
  })!;
  context.mocks.api(modelCatalogContract.get, ({ respond }) => {
    return respond(200, {
      systemDefaultModel: AUTO_SELECTED_MODEL,
      models: [
        {
          ...auto,
          model: AUTO_SELECTED_MODEL,
          resolvedModel: AUTO_SELECTED_MODEL,
        },
        subscription,
      ],
      routes: [
        { ...builtin, model: AUTO_SELECTED_MODEL },
        ...catalog.routes.filter((entry) => {
          return entry.model === luna;
        }),
      ],
    });
  });
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, {
      models: [
        { ...mockAutoRunModel(), model: AUTO_SELECTED_MODEL },
        mockSubscriptionRunModel(luna),
      ],
    });
  });
  createChatRunFixtures(context).installRunChat();
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.userModelPreference({
    selectedModel: AUTO_SELECTED_MODEL,
    modelSettings: {},
    serviceTier: null,
    selectedImageModel: null,
    updatedAt: null,
  });
  await expect(newChatChoices()).resolves.toStrictEqual(["Auto", "GPT 6 Luna"]);
});
