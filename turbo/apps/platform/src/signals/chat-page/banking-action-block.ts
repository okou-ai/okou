import {
  bankingUserContract,
  type BankingAccessRequestStatusResponse,
  type BankingConnectSessionRequest,
  type BankingGrantDuration,
} from "@okouai/api-contracts/contracts/banking";
import { command, computed, state, type Command, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { onRef, setLoop } from "../utils.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
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

export type BankingBusyAction =
  | "connect"
  | "save"
  | "revoke"
  | "continue"
  | null;

export interface BankingCardUiState {
  readonly selectedAccountIds: readonly string[] | null;
  readonly duration: BankingGrantDuration;
  readonly editing: boolean | null;
  readonly confirmingRevoke: boolean;
  readonly busy: BankingBusyAction;
  readonly localError: string | null;
}

export interface BankingSignals extends BankingActionDescriptor {
  readonly status$: Computed<Promise<BankingAccessRequestStatusResponse>>;
  readonly refresh$: Command<void, []>;
  readonly startSession$: Command<
    Promise<string>,
    [
      {
        readonly mode: BankingConnectSessionRequest["mode"];
        readonly institutionLoginId?: string;
      },
      AbortSignal,
    ]
  >;
  readonly saveGrant$: Command<
    Promise<BankingAccessRequestStatusResponse>,
    [
      {
        readonly accountIds: readonly string[];
        readonly duration: BankingGrantDuration;
      },
      AbortSignal,
    ]
  >;
  readonly revokeGrant$: Command<
    Promise<BankingAccessRequestStatusResponse>,
    [AbortSignal]
  >;
  readonly continue$: Command<Promise<void>, [AbortSignal]>;
  readonly pendingSessionPollerRef$: Command<
    void | (() => void),
    [HTMLElement | null]
  >;
  readonly uiState$: Computed<BankingCardUiState>;
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
  refresh$: BankingSignals["refresh$"],
): Pick<BankingSignals, "startSession$" | "saveGrant$" | "revokeGrant$"> {
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

function createBankingContinueSignal(
  descriptor: BankingActionDescriptor,
): BankingSignals["continue$"] {
  return command(async ({ set }, signal: AbortSignal) => {
    await set(
      runChatActionCallback$,
      {
        threadId: descriptor.threadId,
        agentId: descriptor.agentId,
        callbackPrompt: descriptor.callbackPrompt,
      },
      signal,
    );
  });
}

function createPendingSessionPoller(
  status$: BankingSignals["status$"],
  refresh$: BankingSignals["refresh$"],
): BankingSignals["pendingSessionPollerRef$"] {
  const pollPendingSession$ = command(
    ({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      setLoop(
        async () => {
          const status = await get(status$);
          signal.throwIfAborted();
          if (status.session?.status !== "pending") {
            return true;
          }
          set(refresh$);
          return false;
        },
        2000,
        signal,
        { retryTransientErrors: true, logTransientErrors: false },
      );
    },
  );
  return onRef(pollPendingSession$);
}

function initialBankingCardUiState(): BankingCardUiState {
  return {
    selectedAccountIds: null,
    duration: "7d",
    editing: null,
    confirmingRevoke: false,
    busy: null,
    localError: null,
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
  return {
    ...descriptor,
    ...statusSignals,
    ...mutationSignals,
    ...uiSignals,
    continue$: createBankingContinueSignal(descriptor),
    pendingSessionPollerRef$: createPendingSessionPoller(
      statusSignals.status$,
      statusSignals.refresh$,
    ),
  };
}

export function createBankingCardSignalsRegistry(): BankingCardSignalsRegistry {
  return createCardSignalsRegistry(
    bankingActionResourceKey,
    createBankingSignals,
  );
}
