import { screen } from "@testing-library/react";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { getMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import { expect, test } from "vitest";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  buildRunModel,
  composerModelTrigger,
} from "./chat-composer-test-helpers.ts";
import {
  findModelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import {
  context,
  installRunChat,
  NEW_CHAT_PATH,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const FIXTURE_DATE = "2026-09-30T09:00:00.000Z";

function configureRunModels(models: readonly string[]): void {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    models.map((model) => {
      return buildRunModel({ model });
    }),
  );
}

function preference(selectedModel: string): void {
  context.mocks.data.userModelPreference({
    selectedModel,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: FIXTURE_DATE,
  } as Parameters<typeof context.mocks.data.userModelPreference>[0]);
}

async function readyComposer(): Promise<void> {
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
}

test("Offer the active catalog models in catalog order with catalog names", async () => {
  configureRunModels(["gpt-6-luna", "claude-fable-5", "claude-sonnet-5"]);

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });
  await readyComposer();

  const panel = await openModelPanel("Auto");
  await expect(findModelOption(/^GPT 6 Luna/u, panel)).resolves.toBeVisible();
  const names = queryAllByRoleFast("radio", panel).map((option) => {
    return option.textContent?.trim();
  });
  expect(names).toStrictEqual(["Auto", "Claude Sonnet 5", "GPT 6 Luna"]);
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
  preference("auto");
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyComposer();
  const panel = await openModelPanel("Auto");
  expect(
    queryAllByRoleFast("radio", panel).map((option) => {
      return option.textContent?.trim();
    }),
  ).toStrictEqual(["Auto", "GPT 6 Luna"]);
});

test("Show the replacement for a thread pinned to a retired model", async () => {
  installRunChat({ selectedModel: "claude-fable-5" });
  configureRunModels(["claude-fable-5-1"]);

  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  await expect(composerModelTrigger("Claude Fable 5.1")).resolves.toBeVisible();
});

test("Resolve a member preference of a retired model to its replacement", async () => {
  configureRunModels(["gpt-6-luna", "claude-sonnet-5"]);
  preference("deepseek-v4-pro");

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });
  await readyComposer();

  await expect(composerModelTrigger("GPT 6 Luna")).resolves.toBeVisible();
});
