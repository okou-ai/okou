import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";

import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  closeModelPanel,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import {
  findButton,
  NEW_CHAT_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const MODEL = "gpt-5.6-sol";

function runModelFixture(
  personal: boolean,
  restricted = false,
): AvailableRunModel {
  return {
    model: MODEL,
    modelLabel: "GPT 5.6 Sol",
    modelProviderId: null,
    memberEffective: {
      providerType: "codex-oauth-token",
      runtimeProviderType: "codex-oauth-token",
      credentialScope: "member",
      availability: restricted ? "reconnect_required" : "available",
      accountSelection: "capture_required",
    },
    subscriptionOptions: {
      efforts: personal
        ? ["low", "high", "max"]
        : ["low", "medium", "high", "xhigh", "max"],
      serviceTier: "priority",
    },
  };
}

async function openChat(
  transport: "direct" | "message-port" = "direct",
  desktop = false,
): Promise<void> {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(min-width: 640px)" ||
      (desktop && query === "(min-width: 48rem)")
    );
  });
  await setupPage({
    context,
    path: `${NEW_CHAT_PATH}?compose=1`,
    sharedWorkerTestTransport: transport,
  });
  await expect(
    composerModelTrigger("GPT 5.6 Sol"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "runModelsChanged",
      ),
    ).toBeTruthy();
  });
}

async function personalOption(): Promise<HTMLElement> {
  return await waitFor(() => {
    const option = modelOption(/GPT 5\.6 Sol/u);
    expect(option).not.toBeDisabled();
    return option;
  });
}

function notice(): void {
  act(() => {
    context.mocks.ably.triggerOnChannel(
      "user:test-user-123",
      "runModelsChanged",
      null,
    );
  });
}

async function setupHeldProjectionRefresh() {
  let failRefresh = false;
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  installRunChat({ selectedModel: MODEL });
  context.mocks.api(
    runModelsMainContract.list,
    async ({ respond, withSignal }) => {
      if (failRefresh) {
        started.resolve();
        await withSignal(release.promise);
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Routing refresh unavailable",
          },
        });
      }
      return respond(200, {
        models: [runModelFixture(false)],
      });
    },
  );
  await openChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Keep this unsent draft");
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  const slider = within(panel).getByRole("slider", { name: "Effort" });
  slider.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Home}");
  await expect(findButton("GPT 5.6 Sol, Low")).resolves.toBeInTheDocument();
  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  await expect(
    findButton("GPT 5.6 Sol, Low, Fast"),
  ).resolves.toBeInTheDocument();
  await personalOption();

  failRefresh = true;
  notice();
  await started.promise;
  return { composer, release };
}

async function finishFailedProjectionRefresh(release: {
  readonly resolve: () => void;
}): Promise<void> {
  release.resolve();
  await expect(
    screen.findByText("Routing refresh unavailable"),
  ).resolves.toBeInTheDocument();
}

test("Keep the draft through a held and failed projection refresh", async () => {
  const { composer, release } = await setupHeldProjectionRefresh();
  expect(composer).toHaveTextContent("Keep this unsent draft");
  await finishFailedProjectionRefresh(release);
  expect(composer).toHaveTextContent("Keep this unsent draft");
});

test("Keep effort through a held and failed projection refresh", async () => {
  const { release } = await setupHeldProjectionRefresh();
  await expect(
    composerModelTrigger("GPT 5.6 Sol, Low"),
  ).resolves.toBeInTheDocument();
  await finishFailedProjectionRefresh(release);
  await expect(
    composerModelTrigger("GPT 5.6 Sol, Low"),
  ).resolves.toBeInTheDocument();
});

test("Keep Fast through a failed projection refresh", async () => {
  const { release } = await setupHeldProjectionRefresh();
  await finishFailedProjectionRefresh(release);
  await expect(
    findButton("GPT 5.6 Sol, Low, Fast"),
  ).resolves.toBeInTheDocument();
  await closeModelPanel();
  const panel = await openModelPanel("GPT 5.6 Sol, Low, Fast");
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeChecked();
});
