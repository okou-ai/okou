import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockAutoRunModel } from "../../../mocks/handlers/api-run-models.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import {
  closeModelPanel,
  findModelOption,
  modelOption,
  openModelPanel,
  queryModelOption,
} from "./chat-model-panel-test-helpers.ts";
import {
  RUN_PATH,
  createChatRunFixtures,
  readyChat,
  sendText,
} from "./chat-run-test-fixtures.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

function runModelFixture(model: string, index: number): AvailableRunModel {
  return buildRunModel({
    model,
    modelProviderId: `e4000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
  });
}

function configureRunModels(models: readonly string[]): void {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    models.map((model, index) => {
      return runModelFixture(model, index + 1);
    }),
  );
}

test("Edit only the model for an existing thread", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "claude-opus-5" });
  configureRunModels(["claude-opus-5", "claude-sonnet-5"]);
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(composerModelTrigger("Claude Opus 5")).resolves.toBeVisible();

  const panel = await openModelPanel("Claude Opus 5");
  await user.click(modelOption(/^Claude Sonnet 5/iu, panel));
  await closeModelPanel();

  await expect(composerModelTrigger("Claude Sonnet 5")).resolves.toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();
});

test("Switch only the thread to Auto when its model is no longer selectable", async () => {
  const threadModels: (string | null | undefined)[] = [];
  const sentModels: (string | null | undefined)[] = [];
  installRunChat({
    selectedModel: "deepseek-v4.1-flash",
    onModelSelectionUpdate: (body) => {
      threadModels.push(body.model);
    },
    onSendRequest: (body) => {
      sentModels.push(body.model);
    },
  });
  context.mocks.data.availableRunModels([
    {
      ...runModelFixture("gpt-6-sol", 2),
      subscriptionOptions: { efforts: ["low", "high"], serviceTier: null },
    },
  ]);
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  const panel = await openModelPanel("Auto");
  await expect(findModelOption(/^GPT 6 Sol/iu, panel)).resolves.toBeVisible();
  expect(queryModelOption(/DeepSeek/iu, panel)).not.toBeInTheDocument();
  await closeModelPanel();
  await sendText("Run on the model shown");

  await waitFor(() => {
    expect(threadModels).toStrictEqual([null]);
    expect(sentModels).toStrictEqual([undefined]);
  });
});

test.each([null, "auto"])(
  "Send without repairing an Auto thread storing %s",
  async (selectedModel) => {
    const requests: string[] = [];
    installRunChat({
      selectedModel,
      onModelSelectionUpdate: () => {
        requests.push("repair model");
      },
      onSendRequest: () => {
        requests.push("send");
      },
    });
    installConnectedPersonalSubscriptions(context);
    context.mocks.api(runModelsMainContract.list, ({ respond }) => {
      return respond(200, {
        models: [
          { ...mockAutoRunModel(), model: selectedModel },
          runModelFixture("claude-opus-5", 1),
        ],
      });
    });
    await setupPage({ context, path: RUN_PATH });
    await readyChat();
    const panel = await openModelPanel("Auto");
    expect(modelOption(/^Auto/u, panel)).toBeChecked();
    await closeModelPanel();

    await sendText("Continue on Auto");

    await expect(screen.findByText("Continue on Auto")).resolves.toBeVisible();
    expect(requests).toStrictEqual(["send"]);
  },
);

test("Keep the stored selection when sending on an available model", async () => {
  const sentModels: (string | null | undefined)[] = [];
  const selectionUpdates: unknown[] = [];
  installRunChat({
    selectedModel: "claude-opus-5",
    onModelSelectionUpdate: (body) => {
      selectionUpdates.push(body);
    },
    onSendRequest: (body) => {
      sentModels.push(body.model);
    },
  });
  configureRunModels(["claude-opus-5"]);
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(composerModelTrigger("Claude Opus 5")).resolves.toBeVisible();

  await sendText("Run on the pinned model");

  await waitFor(() => {
    expect(sentModels).toStrictEqual([undefined]);
  });
  await expect(
    screen.findByText("Run on the pinned model"),
  ).resolves.toBeVisible();
  expect(selectionUpdates).toStrictEqual([]);
  await expect(composerModelTrigger("Claude Opus 5")).resolves.toBeVisible();
});
