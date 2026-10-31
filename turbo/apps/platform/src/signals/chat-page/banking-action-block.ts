import { bankingUserContract } from "@okouai/api-contracts/client/banking";
import type {
  BankingAccessRequestStatusResponse,
  BankingConnectSessionRequest,
  BankingGrantDuration,
} from "@okouai/api-contracts/contracts/banking";
import { command, computed, state, type Command, type Computed } from "ccstate";

import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
  type ChatActionCallbackIds,
} from "./action-callback.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
  type ChatActionParseResult,
} from "./chat-action-context.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

export interface BankingActionDescriptor {
  readonly agentId: string;
  readonly reason: string;
  readonly originalUrl: string;
  readonly callbackPrompt: string;
  readonly threadId: string;
}

type BankingCardAction =
  | {
      readonly type: "connect";
      readonly mode: BankingConnectSessionRequest["mode"];
      readonly institutionLoginId?: string;
    }
  | {
      readonly type: "save";
      readonly accountIds: readonly string[];
      readonly duration: BankingGrantDuration;
    }
  | { readonly type: "revoke" | "continue" };

export interface BankingCardUiState {
  readonly selectedAccountIds: readonly string[] | null;
  readonly duration: BankingGrantDuration;
  readonly editing: boolean | null;
  readonly confirmingRevoke: boolean;
}

export interface BankingSignals extends BankingActionDescriptor {
  readonly status$: Computed<Promise<BankingAccessRequestStatusResponse>>;
  readonly subscribe$: Command<void, [AbortSignal]>;
  readonly uiState$: Computed<BankingCardUiState>;
  readonly runAction$: Command<Promise<void>, [BankingCardAction, AbortSignal]>;
  readonly updateUiState$: Command<void, [Partial<BankingCardUiState>]>;
}

type BankingCardSignalsRegistry = CardSignalsRegistry<
  BankingActionDescriptor,
  BankingSignals
>;

export function bankingActionResourceKey(
  descriptor: BankingActionDescriptor,
): string {
  return descriptor.originalUrl;
}

export function parseBankingActionUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<BankingActionDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  if (!url) {
    return { status: "unrelated" };
  }
  const match = url.pathname.match(/^\/agents\/([^/]+)\/banking$/u);
  if (!match) {
    return { status: "unrelated" };
  }
  const agentId = match[1] ?? "";
  const reason = url.searchParams.get("reason")?.trim() ?? "";
  const callback = context ? chatActionCallbackFromUrl(url, context) : null;
  if (
    !context ||
    !agentId ||
    !chatActionIdMatches(agentId, context.agentId) ||
    !reason ||
    reason.length > 500 ||
    !callback?.callbackPrompt ||
    !callback.threadId
  ) {
    return { status: "invalid", originalUrl: value };
  }
  return {
    status: "valid",
    descriptor: {
      agentId: context.agentId,
      reason,
      originalUrl: value,
      callbackPrompt: callback.callbackPrompt,
      threadId: callback.threadId,
    },
  };
}

function createBankingStatusSignals(descriptor: BankingActionDescriptor) {
  const reload$ = state(0);
  const status$ = computed(async (get) => {
    get(reload$);
    const client = get(apiClient$)(bankingUserContract);
    const result = await accept(
      client.accessRequestStatus({
        params: { agentId: descriptor.agentId },
      }),
      [200],
    );
    return result.body;
  });
  const refresh$ = command(({ set }) => {
    set(reload$, (version) => {
      return version + 1;
    });
  });
  return { status$, refresh$ };
}

function createBankingMutationSignals(
  descriptor: BankingActionDescriptor,
  refresh$: ReturnType<typeof createBankingStatusSignals>["refresh$"],
) {
  const startSession$ = command(
    async (
      { get, set },
      args: {
        readonly mode: BankingConnectSessionRequest["mode"];
        readonly institutionLoginId?: string;
      },
      signal: AbortSignal,
    ): Promise<string> => {
      const client = get(apiClient$)(bankingUserContract);
      const result = await accept(
        client.createConnectSession({
          body: {
            agentId: descriptor.agentId,
            mode: args.mode,
            ...(args.institutionLoginId
              ? { institutionLoginId: args.institutionLoginId }
              : {}),
          },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(refresh$);
      return result.body.url;
    },
  );
  const saveGrant$ = command(
    async (
      { get, set },
      args: {
        readonly accountIds: readonly string[];
        readonly duration: BankingGrantDuration;
      },
      signal: AbortSignal,
    ): Promise<BankingAccessRequestStatusResponse> => {
      const client = get(apiClient$)(bankingUserContract);
      const result = await accept(
        client.saveAgentGrant({
          body: {
            agentId: descriptor.agentId,
            accountIds: [...args.accountIds],
            duration: args.duration,
            purpose: descriptor.reason,
          },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(refresh$);
      return result.body;
    },
  );
  const revokeGrant$ = command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<BankingAccessRequestStatusResponse> => {
      const client = get(apiClient$)(bankingUserContract);
      const result = await accept(
        client.revokeAgentGrant({
          body: { agentId: descriptor.agentId },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(refresh$);
      return result.body;
    },
  );
  return { startSession$, saveGrant$, revokeGrant$ };
}

function createBankingContinueSignal(descriptor: BankingActionDescriptor) {
  const callbackIds$ = state<ChatActionCallbackIds | null>(null);
  return command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    let callbackIds = get(callbackIds$);
    if (!callbackIds) {
      callbackIds = {
        clientEventId: crypto.randomUUID(),
        chatThreadSortEventId: crypto.randomUUID(),
      };
      set(callbackIds$, callbackIds);
    }
    await set(
      runChatActionCallback$,
      {
        threadId: descriptor.threadId,
        agentId: descriptor.agentId,
        callbackPrompt: descriptor.callbackPrompt,
        callbackIds,
      },
      signal,
    );
  });
}

function createBankingSubscription(
  refresh$: ReturnType<typeof createBankingStatusSignals>["refresh$"],
): BankingSignals["subscribe$"] {
  const invalidate$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  return command(({ set }, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      { topic: "bankingAccessChanged", loopCommand$: invalidate$ },
      signal,
    );
  });
}

function initialBankingCardUiState(): BankingCardUiState {
  return {
    selectedAccountIds: null,
    duration: "7d",
    editing: null,
    confirmingRevoke: false,
  };
}

function createBankingUiSignals(): Pick<
  BankingSignals,
  "uiState$" | "updateUiState$"
> {
  const internalUiState$ = state(initialBankingCardUiState());
  const uiState$ = computed((get): BankingCardUiState => {
    return get(internalUiState$);
  });
  const updateUiState$ = command(
    ({ set }, patch: Partial<BankingCardUiState>): void => {
      set(internalUiState$, (current) => {
        return { ...current, ...patch };
      });
    },
  );
  return { uiState$, updateUiState$ };
}

function createBankingSignals(
  descriptor: BankingActionDescriptor,
): BankingSignals {
  const statusSignals = createBankingStatusSignals(descriptor);
  const mutationSignals = createBankingMutationSignals(
    descriptor,
    statusSignals.refresh$,
  );
  const uiSignals = createBankingUiSignals();
  const continue$ = createBankingContinueSignal(descriptor);
  const performAction$ = command(
    async ({ set }, action: BankingCardAction, signal: AbortSignal) => {
      signal.throwIfAborted();
      switch (action.type) {
        case "connect": {
          const popup = window.open("about:blank", "_blank");
          if (!popup) {
            throw new Error(
              i18n.t(($) => {
                return $.chat.banking.popupBlocked;
              }),
            );
          }
          popup.opener = null;
          const url = await set(mutationSignals.startSession$, action, signal);
          signal.throwIfAborted();
          popup.location.replace(url);
          return;
        }
        case "save": {
          await set(mutationSignals.saveGrant$, action, signal);
          signal.throwIfAborted();
          set(uiSignals.updateUiState$, { editing: false });
          return;
        }
        case "revoke": {
          await set(mutationSignals.revokeGrant$, signal);
          signal.throwIfAborted();
          set(uiSignals.updateUiState$, {
            confirmingRevoke: false,
            editing: true,
            selectedAccountIds: [],
          });
          return;
        }
        case "continue": {
          await set(continue$, signal);
        }
      }
    },
  );
  return {
    ...descriptor,
    status$: statusSignals.status$,
    ...uiSignals,
    subscribe$: createBankingSubscription(statusSignals.refresh$),
    runAction$: performAction$,
  };
}

export function createBankingCardSignalsRegistry(): BankingCardSignalsRegistry {
  return createCardSignalsRegistry(
    bankingActionResourceKey,
    createBankingSignals,
    (signals) => {
      return signals.subscribe$;
    },
  );
}
