import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockAutoRunModel,
  mockSubscriptionRunModel,
} from "../../../mocks/handlers/api-run-models.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  NEW_CHAT_PATH,
  createChatRunFixtures,
  findButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const FIXTURE_DATE = "2026-08-18T09:00:00.000Z";
const ACTIVE_CODEX_ID = "f1000000-0000-4000-a000-000000000101";
const INACTIVE_CODEX_ID = "f1000000-0000-4000-a000-000000000102";
const CODEX_ROUTE_ID = "f1000000-0000-4000-a000-000000000103";

/**
 * The API reports a personal Codex model as available only while the member
 * has a usable active Codex account.
 */
function configureCodexRoute(args: {
  readonly model: string;
  readonly modelLabel: string;
  readonly modelProviderId: string | null;
  readonly providers: () => readonly ModelProviderResponse[];
}): void {
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    const usable = args.providers().some((candidate) => {
      return candidate.isActive !== false && !candidate.needsReconnect;
    });
    return respond(200, {
      models: [
        mockAutoRunModel(),
        mockSubscriptionRunModel(args.model, {
          modelLabel: args.modelLabel,
          providerType: "codex-oauth-token",
          modelProviderId: args.modelProviderId,
          availability: usable ? "available" : "reconnect_required",
        }),
      ],
    });
  });
}

function codexAccount(args: {
  readonly id: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly needsReconnect?: boolean;
}): ModelProviderResponse {
  return {
    id: args.id,
    modelProviderId: CODEX_ROUTE_ID,
    isActive: args.isActive,
    type: "codex-oauth-token",
    framework: "codex",
    accountEmail: args.email,
    workspaceName: args.email,
    planType: "pro",
    needsReconnect: args.needsReconnect ?? false,
    lastRefreshErrorCode:
      args.needsReconnect === true ? "refresh_token_expired" : null,
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
  };
}

function installCodexAccounts(initial: readonly ModelProviderResponse[]): {
  readonly current: () => readonly ModelProviderResponse[];
  readonly replace: (providers: readonly ModelProviderResponse[]) => void;
} {
  let providers = [...initial];
  context.mocks.api(thirdPartySubscriptionsMainContract.list, ({ respond }) => {
    return respond(200, { subscriptions: providers });
  });
  return {
    current: () => {
      return providers;
    },
    replace: (next) => {
      providers = [...next];
    },
  };
}

function buttonNamed(name: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button ${name} was not visible`);
  }
  return button;
}

test("Connect Codex before sending with a personal route", async () => {
  const connected = codexAccount({
    id: ACTIVE_CODEX_ID,
    email: "active.codex@example.com",
    isActive: true,
  });
  const accounts = installCodexAccounts([]);
  const approval = context.mocks.deferred<void>();
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWriteText();
  installRunChat({ selectedModel: "gpt-5.6-luna" });
  configureCodexRoute({
    model: "gpt-5.6-luna",
    modelLabel: "GPT 5.6 Luna",
    modelProviderId: null,
    providers: accounts.current,
  });
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "personal-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ respond, withSignal }) => {
      await withSignal(approval.promise);
      accounts.replace([connected]);
      return respond(200, {
        status: "complete",
        provider: connected,
        created: true,
      });
    },
  );

  await setupPage({ context, path: NEW_CHAT_PATH });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await expect(composerModelTrigger("GPT 5.6 Luna")).resolves.toBeVisible();
  await user.click(composer);
  await user.keyboard("Hello");

  const send = await findButton("Send");
  expect(send).toBeDisabled();
  click(send);
  click(await findButton("Configure model"));

  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(within(dialog).getByText("ABCD-EFGH")).toBeVisible();
  const approvalLink = within(dialog).getByTestId("codex-device-auth-open");
  expect(queryAllByRoleFast("link", dialog)).toContain(approvalLink);
  expect(approvalLink).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );

  click(buttonNamed("Copy to clipboard", dialog));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual(["ABCD-EFGH"]);
  });

  approval.resolve();

  await expect(screen.findByText("ChatGPT connected")).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Configure model")).toBeNull();
  });
});

test("Reconnect the personal provider used by the selected model", async () => {
  const startBodies: unknown[] = [];
  const accounts = installCodexAccounts([
    codexAccount({
      id: INACTIVE_CODEX_ID,
      email: "inactive.codex@example.com",
      isActive: false,
    }),
    codexAccount({
      id: ACTIVE_CODEX_ID,
      email: "active.codex@example.com",
      isActive: true,
      needsReconnect: true,
    }),
  ]);
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  configureCodexRoute({
    model: "gpt-5.6-sol",
    modelLabel: "GPT 5.6 Sol",
    modelProviderId: CODEX_ROUTE_ID,
    providers: accounts.current,
  });
  context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
    startBodies.push(body);
    return respond(200, {
      sessionToken: "reconnect-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "RCNX-CODE",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await expect(composerModelTrigger("GPT 5.6 Sol")).resolves.toBeVisible();
  click(await findButton("Configure model"));

  const dialog = await screen.findByRole("dialog", {
    name: "Re-connect Codex",
  });
  expect(dialog).toBeVisible();
  await expect(within(dialog).findByText("RCNX-CODE")).resolves.toBeVisible();
  expect(startBodies).toStrictEqual([
    {
      scope: "personal",
      mode: "reconnect",
      modelProviderId: ACTIVE_CODEX_ID,
    },
  ]);
  expect(dialog).not.toHaveTextContent("inactive.codex@example.com");
});
