import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { within, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import { getMockModelCatalog } from "../../../mocks/handlers/api-model-catalog.ts";
import {
  mockSubscriptionRunModel,
  mockAutoRunModel,
} from "../../../mocks/handlers/api-run-models.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { buildProvider } from "./chat-model-builders.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

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

const account = buildProvider({
  type: "codex-oauth-token",
  framework: "codex",
  id: "0207463a-8a96-4f33-a03f-f59846061a4d",
  isActive: true,
});

const approvalUrl = "https://auth.example.test/device";

function deviceSession(code: string) {
  return {
    sessionToken: "local-device-session",
    scope: "personal" as const,
    type: "codex" as const,
    status: "pending" as const,
    verificationCode: code,
    browserUrl: approvalUrl,
    interval: 1,
    expiresIn: 600,
  };
}

test("chat-composer-model-recovery-001 restores the drafted chat after approving the Codex device code", async () => {
  createChatRunFixtures(context).installRunChat({
    selectedModel: "gpt-5.6-luna",
  });
  context.mocks.data.personalModelProviders([]);
  context.mocks.data.availableRunModels([
    mockSubscriptionRunModel("gpt-5.6-luna", {
      availability: "reconnect_required",
    }),
  ]);
  const approve = context.mocks.deferred<void>();
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, deviceSession("ABCD-EFGH"));
  });
  context.mocks.api(codexDeviceAuthContract.complete, async ({ respond }) => {
    await approve.promise;
    context.mocks.data.personalModelProviders([account]);
    context.mocks.data.availableRunModels([
      mockSubscriptionRunModel("gpt-5.6-luna", { modelProviderId: account.id }),
    ]);
    context.mocks.ably.trigger("runModelsChanged");
    return respond(200, {
      status: "complete",
      provider: account,
      created: true,
    });
  });
  await setupPage({ context, path: "/" });
  await composerModelTrigger("GPT 5.6 Luna");
  await fill(screen.getByRole("textbox", { name: "Message" }), "Hello.");
  const send = await screen.findByLabelText("Send");
  expect(send).toBeDisabled();
  click(send);
  click(await findEnabledButton("Configure model"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  await within(dialog).findByText("ABCD-EFGH");
  expect(
    queryAllByRoleFast("link", dialog).find((link) => {
      return link.textContent === "Open approval page";
    }),
  ).toHaveAttribute("href", approvalUrl);
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(await findEnabledButton("Copy to clipboard", dialog));
  await waitFor(() => {
    return expect(clipboard.writes).toContain("ABCD-EFGH");
  });
  approve.resolve();
  await screen.findByText("ChatGPT connected");
  await findEnabledButton("Send");
  expect(queryButton("Configure model")).not.toBeInTheDocument();
});

test("chat-composer-model-recovery-003 starts device authorization for the active matching subscription", async () => {
  const inactive = {
    ...account,
    id: "14be7243-4a6b-49e4-8084-4055c0acdd78",
    accountEmail: "previous@example.test",
    isActive: false,
  };
  const active = {
    ...account,
    accountEmail: "current@example.test",
    needsReconnect: true,
  };
  createChatRunFixtures(context).installRunChat({
    selectedModel: "gpt-5.6-sol",
  });
  context.mocks.data.personalModelProviders([inactive, active]);
  context.mocks.data.availableRunModels([
    mockSubscriptionRunModel("gpt-5.6-sol", {
      modelProviderId: active.id,
      availability: "reconnect_required",
    }),
  ]);
  context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
    return respond(
      200,
      deviceSession(
        body.mode === "reconnect" && body.modelProviderId === active.id
          ? "ACTIVE-PAIR"
          : "OTHER-PAIR",
      ),
    );
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
  await setupPage({ context, path: "/" });
  await composerModelTrigger("GPT 5.6 Sol");
  click(await findEnabledButton("Configure model"));
  const dialog = await screen.findByRole("dialog", {
    name: "Re-connect Codex",
  });
  await within(dialog).findByText("ACTIVE-PAIR");
  expect(dialog).not.toHaveTextContent("previous@example.test");
});
