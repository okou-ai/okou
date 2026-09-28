import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

async function setupStartCards(subscriptionPinned: boolean): Promise<void> {
  mockTemplateChat();
  context.mocks.data.personalModelProviders([]);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: false,
      [FeatureSwitchKey.StartCardModelSubscription]: subscriptionPinned,
    },
  });
  await findComposerEditor();
}

function subscriptionCard(): HTMLElement {
  return screen.getByTestId("start-card-subscription");
}

function subscriptionButton(label: string): HTMLElement {
  const button = queryAllByRoleFast("button", subscriptionCard()).find(
    (item) => {
      return item.textContent?.trim() === label;
    },
  );
  if (!button) {
    throw new Error(`Expected subscription button ${label}`);
  }
  return button;
}

test("The subscription card leads the start cards without growing the row", async () => {
  await setupStartCards(true);
  const row = screen.getByTestId("start-cards");
  expect(row.children).toHaveLength(3);
  expect(row.firstElementChild).toBe(subscriptionCard());
  expect(subscriptionCard()).toHaveTextContent("Bring your subscription");
});

test("The Codex button opens the Codex sign-in from the start card", async () => {
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  await setupStartCards(true);

  click(subscriptionButton("Codex"));

  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(dialog).toHaveTextContent("ABCD-EFGH");
});

test("The Claude button opens the Claude sign-in from the start card", async () => {
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  await setupStartCards(true);

  click(subscriptionButton("Claude"));

  const inputs = await screen.findAllByTestId("claude-code-device-auth-code");
  expect(inputs).not.toHaveLength(0);
});

test("The start cards stay unchanged while the subscription card is off", async () => {
  await setupStartCards(false);
  expect(screen.getByTestId("start-cards").children).toHaveLength(3);
  expect(screen.queryByTestId("start-card-subscription")).toBeNull();
});
