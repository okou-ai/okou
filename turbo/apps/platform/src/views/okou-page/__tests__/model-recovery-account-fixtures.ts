import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import { connectedPersonalCodexProvider } from "./sidebar-account-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { promptEvent } from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
export const sol = "gpt-5.6-sol",
  luna = "gpt-5.6-luna";
export async function recoveryPage(
  context: TestContext,
  options: {
    selected?: string | null;
    reason?: string;
    error?: string;
    accountGate?: Promise<void>;
    disconnected?: boolean;
    remaining?: number;
    noReset?: boolean;
    live?: boolean;
    weekly?: boolean;
    account?: string;
  } = {},
) {
  const thread = crypto.randomUUID(),
    run = crypto.randomUUID();
  const selected = options.selected === undefined ? sol : options.selected;
  const { codex } = accountModels(context, [sol, luna], selected);
  const provider = connectedPersonalCodexProvider({
    id: codex.id,
    isActive: true,
    accountEmail: options.account ?? "current@example.com",
    needsReconnect: options.disconnected ?? false,
    subscriptionResetCredits: options.remaining ?? 1,
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 100,
        remainingPercent: 0,
        windowSeconds: 18_000,
        resetAt: options.weekly
          ? "2026-08-02T12:00:00.000Z"
          : "2026-08-01T12:00:00.000Z",
      },
      ...(options.weekly
        ? {
            weekly: {
              usedPercent: 100,
              remainingPercent: 0,
              windowSeconds: 604_800,
              resetAt: "2026-08-08T12:00:00.000Z",
            },
          }
        : { weekly: null }),
    },
  });
  context.mocks.data.personalModelProviders([provider]);
  const sent: {
      prompt: string;
      model: string | null | undefined;
      parts: unknown;
    }[] = [],
    reset: string[] = [];
  const message = promptEvent({
    id: crypto.randomUUID(),
    runId: run,
    seqId: 1,
    text: "Prepare the findings",
    ...(selected ? { model: selected } : {}),
  });
  const failure: MockChatEventInput = {
    id: crypto.randomUUID(),
    role: "assistant",
    eventType: "run.failed",
    content: options.error ?? "Account usage limit reached",
    runId: run,
    runLifecycleEvent: "failed",
    failureReason: options.reason ?? "usage_limit",
    seqId: 2,
    createdAt: "2026-08-01T10:00:02.000Z",
  };
  const previousFailure: MockChatEventInput =
    options.error === "AUTONOMY_BUDGET_EXHAUSTED"
      ? {
          id: failure.id,
          role: "assistant",
          eventType: "output.error",
          runId: run,
          seqId: 2,
          createdAt: failure.createdAt,
          content: null,
          error: options.error,
        }
      : failure;
  const lifecycle = mockChatLifecycle(context, {
    threadId: thread,
    selectedModel: selected,
    chatEvents: options.live ? [] : [message, previousFailure],
    onSendRequest: (b) => {
      sent.push({
        prompt: b.prompt,
        model: b.model,
        parts: b.userMessage?.parts,
      });
    },
  });
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      await options.accountGate;
      return respond(200, { subscriptions: [provider] });
    },
  );
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ params, respond }) => {
      reset.push(params.id);
      return options.noReset
        ? respond(404, {
            error: { code: "NOT_FOUND", message: "Subscription unavailable" },
          })
        : respond(200, { outcome: "reset" });
    },
  );
  await setupPage({ context, path: "/chats/" + thread });
  return { sent, reset, provider, lifecycle };
}
