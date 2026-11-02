import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/client/claude-code-device-auth";
import type {
  ClaudeCodeDeviceAuthMode,
  ClaudeCodeDeviceAuthScope,
} from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command, computed, state, type Command, type State } from "ccstate";

import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import { apiClient$ } from "../../api-client.ts";
import { resetSignal, withCleanup } from "../../utils.ts";
import { reloadPersonalModelProvider$ } from "../model-first-personal-oauth.ts";

type ClaudeCodeDeviceAuthDialogMode = "connect" | "reconnect";

interface ClaudeCodeDeviceAuthDialogState {
  open: boolean;
  mode: ClaudeCodeDeviceAuthDialogMode;
  modelProviderId: string | null;
}

type OpenClaudeCodeDeviceAuthArgs =
  | ClaudeCodeDeviceAuthDialogMode
  | {
      readonly mode: ClaudeCodeDeviceAuthDialogMode;
      readonly modelProviderId?: string;
    };

type OpenPersonalClaudeCodeDeviceAuthArgs =
  | { readonly mode: "connect" }
  | { readonly mode: "reconnect"; readonly modelProviderId: string };

type ActiveClaudeCodeDeviceAuthFlowState = {
  readonly status: "pending";
  readonly requestId: string;
  readonly sessionToken: string;
  readonly browserUrl: string;
  readonly expiresAtMs: number;
  readonly authorizationCode: string;
  readonly errorMessage: string | null;
};

type ClaudeCodeDeviceAuthFlowState =
  | { readonly status: "idle" }
  | ActiveClaudeCodeDeviceAuthFlowState
  | { readonly status: "expired"; readonly message: string };

function createInitialDialogState(): ClaudeCodeDeviceAuthDialogState {
  return {
    open: false,
    mode: "connect",
    modelProviderId: null,
  };
}

function createIdleFlowState(): ClaudeCodeDeviceAuthFlowState {
  return { status: "idle" };
}

function createRequestId(scope: ClaudeCodeDeviceAuthScope): string {
  return `${scope}-claude-code-device-auth-${now()}-${Math.random().toString(36).slice(2)}`;
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1000;
}

function isCurrentActive(
  stateValue: ClaudeCodeDeviceAuthFlowState,
  requestId: string,
): stateValue is ActiveClaudeCodeDeviceAuthFlowState {
  return stateValue.status === "pending" && stateValue.requestId === requestId;
}

function isActive(
  stateValue: ClaudeCodeDeviceAuthFlowState,
): stateValue is ActiveClaudeCodeDeviceAuthFlowState {
  return stateValue.status === "pending";
}

const startClaudeCodeDeviceAuth$ = command(
  async (
    { get },
    args: {
      readonly scope: ClaudeCodeDeviceAuthScope;
      readonly mode?: ClaudeCodeDeviceAuthMode;
      readonly modelProviderId?: string;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(claudeCodeDeviceAuthContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.start({
        body: args,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

const completeClaudeCodeDeviceAuth$ = command(
  async (
    { get },
    sessionToken: string,
    authorizationCode: string,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(claudeCodeDeviceAuthContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.complete({
        body: {
          sessionToken,
          authorizationCode,
        },
        fetchOptions: { signal },
      }),
      [200, 400],
    );
    signal.throwIfAborted();
    return result;
  },
);

const cancelClaudeCodeDeviceAuth$ = command(
  async ({ get }, sessionToken: string, signal: AbortSignal) => {
    const client = get(apiClient$)(claudeCodeDeviceAuthContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.cancel({
        body: { sessionToken },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

interface ClaudeCodeDeviceAuthSignalContext {
  scope: "personal";
  reloadProviders$: Command<void, []>;
  internalDialogState$: State<ClaudeCodeDeviceAuthDialogState>;
  internalFlowState$: State<ClaudeCodeDeviceAuthFlowState>;
  internalStartOperation$: State<Promise<boolean> | null>;
  resetFlowSignal$: ReturnType<typeof resetSignal>;
}

function createClaudeCodeStartFlow$(ctx: ClaudeCodeDeviceAuthSignalContext) {
  return command(
    async (
      { get, set },
      requestId: string,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const dialog = get(ctx.internalDialogState$);
      const started = await set(
        startClaudeCodeDeviceAuth$,
        {
          scope: ctx.scope,
          mode: dialog.mode === "reconnect" ? "reconnect" : "add",
          ...(dialog.modelProviderId
            ? { modelProviderId: dialog.modelProviderId }
            : {}),
        },
        signal,
      );
      signal.throwIfAborted();
      set(ctx.internalFlowState$, {
        status: "pending",
        requestId,
        sessionToken: started.sessionToken,
        browserUrl: started.browserUrl,
        expiresAtMs: now() + secondsToMilliseconds(started.expiresIn),
        authorizationCode: "",
        errorMessage: null,
      });
      return true;
    },
  );
}

function createClaudeCodeRun$(
  ctx: ClaudeCodeDeviceAuthSignalContext,
  startFlow$: ReturnType<typeof createClaudeCodeStartFlow$>,
) {
  return command(async ({ set }, signal: AbortSignal): Promise<boolean> => {
    const flowSignal = set(ctx.resetFlowSignal$, signal);
    // Startup stays short; the real session owner can still end later through
    // navigation, a new authorization session or close. Invalidate account truth then.
    flowSignal.addEventListener(
      "abort",
      () => {
        set(ctx.reloadProviders$);
      },
      { once: true },
    );
    set(ctx.internalFlowState$, createIdleFlowState());
    const operation = set(startFlow$, createRequestId(ctx.scope), flowSignal);
    // Retain the actual startup result for this authorization session.
    set(ctx.internalStartOperation$, operation);
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    return await withCleanup(operation, () => {
      set(ctx.reloadProviders$);
    });
  });
}

function createClaudeCodeOpen$(
  ctx: ClaudeCodeDeviceAuthSignalContext,
  run$: ReturnType<typeof createClaudeCodeRun$>,
) {
  return command(
    async (
      { set },
      args: OpenClaudeCodeDeviceAuthArgs,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const normalized = typeof args === "string" ? { mode: args } : args;
      set(ctx.internalDialogState$, {
        open: true,
        mode: normalized.mode,
        modelProviderId: normalized.modelProviderId ?? null,
      });
      return await set(run$, signal);
    },
  );
}

function createClaudeCodeSetAuthorizationCode$(
  ctx: ClaudeCodeDeviceAuthSignalContext,
) {
  return command(({ get, set }, authorizationCode: string) => {
    const current = get(ctx.internalFlowState$);
    if (!isActive(current)) {
      return;
    }
    set(ctx.internalFlowState$, {
      ...current,
      authorizationCode,
      errorMessage: null,
    });
  });
}

function createClaudeCodeSubmit$(ctx: ClaudeCodeDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const current = get(ctx.internalFlowState$);
      if (!isActive(current)) {
        return false;
      }
      if (current.expiresAtMs <= now()) {
        set(ctx.reloadProviders$);
        set(ctx.internalFlowState$, {
          status: "expired",
          message: i18n.t(($) => {
            return $.settings.models.deviceAuth.claude.expired;
          }),
        });
        return false;
      }
      if (!current.authorizationCode.trim()) {
        set(ctx.internalFlowState$, {
          ...current,
          errorMessage: i18n.t(($) => {
            return $.settings.models.deviceAuth.claude.codeRequired;
          }),
        });
        return false;
      }

      set(ctx.internalFlowState$, { ...current, errorMessage: null });
      // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
      const completed = await withCleanup(
        set(
          completeClaudeCodeDeviceAuth$,
          current.sessionToken,
          current.authorizationCode,
          signal,
        ),
        () => {
          set(ctx.reloadProviders$);
        },
      );
      signal.throwIfAborted();

      const latest = get(ctx.internalFlowState$);
      if (!isCurrentActive(latest, current.requestId)) {
        return false;
      }
      if (completed.status === 400) {
        set(ctx.internalFlowState$, {
          ...latest,
          errorMessage: completed.body.error.message,
        });
        return false;
      }

      set(ctx.resetFlowSignal$);
      toast.success(
        i18n.t(($) => {
          return $.settings.models.deviceAuth.claude.connectedToast;
        }),
      );
      set(ctx.internalDialogState$, createInitialDialogState());
      set(ctx.internalFlowState$, createIdleFlowState());
      set(ctx.internalStartOperation$, null);
      return true;
    },
  );
}

function createClaudeCodeClose$(ctx: ClaudeCodeDeviceAuthSignalContext) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(ctx.internalFlowState$);
    const sessionToken = isActive(current) ? current.sessionToken : null;
    set(ctx.resetFlowSignal$);
    set(ctx.internalDialogState$, createInitialDialogState());
    set(ctx.internalFlowState$, createIdleFlowState());
    set(ctx.internalStartOperation$, null);

    if (!sessionToken) {
      set(ctx.reloadProviders$);
      return;
    }

    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      set(cancelClaudeCodeDeviceAuth$, sessionToken, signal),
      () => {
        set(ctx.reloadProviders$);
      },
    );
    signal.throwIfAborted();
  });
}

function createClaudeCodeDeviceAuthSignals(
  scope: "personal",
  reloadProviders$: Command<void, []>,
) {
  const ctx: ClaudeCodeDeviceAuthSignalContext = {
    scope,
    reloadProviders$,
    internalDialogState$: state(createInitialDialogState()),
    internalFlowState$: state<ClaudeCodeDeviceAuthFlowState>(
      createIdleFlowState(),
    ),
    internalStartOperation$: state<Promise<boolean> | null>(null),
    resetFlowSignal$: resetSignal(),
  };
  const startFlow$ = createClaudeCodeStartFlow$(ctx);
  const run$ = createClaudeCodeRun$(ctx, startFlow$);

  return {
    dialogState$: computed((get) => {
      return get(ctx.internalDialogState$);
    }),
    flowState$: computed((get) => {
      return get(ctx.internalFlowState$);
    }),
    startOperation$: computed((get) => {
      return get(ctx.internalStartOperation$);
    }),
    open$: createClaudeCodeOpen$(ctx, run$),
    setAuthorizationCode$: createClaudeCodeSetAuthorizationCode$(ctx),
    submit$: createClaudeCodeSubmit$(ctx),
    close$: createClaudeCodeClose$(ctx),
    run$,
  };
}

const personalClaudeCodeDeviceAuthSignals = createClaudeCodeDeviceAuthSignals(
  "personal",
  reloadPersonalModelProvider$,
);

export const claudeCodeDeviceAuthDialogStatePersonal$ =
  personalClaudeCodeDeviceAuthSignals.dialogState$;
export const claudeCodeDeviceAuthFlowStatePersonal$ =
  personalClaudeCodeDeviceAuthSignals.flowState$;
export const claudeCodeDeviceAuthStartOperationPersonal$ =
  personalClaudeCodeDeviceAuthSignals.startOperation$;
export const openClaudeCodeDeviceAuthDialogPersonal$: Command<
  Promise<boolean>,
  [OpenPersonalClaudeCodeDeviceAuthArgs, AbortSignal]
> = personalClaudeCodeDeviceAuthSignals.open$;
export const setClaudeCodeDeviceAuthAuthorizationCodePersonal$ =
  personalClaudeCodeDeviceAuthSignals.setAuthorizationCode$;
export const submitClaudeCodeDeviceAuthPersonal$ =
  personalClaudeCodeDeviceAuthSignals.submit$;
export const closeClaudeCodeDeviceAuthDialogPersonal$ =
  personalClaudeCodeDeviceAuthSignals.close$;
export const runClaudeCodeDeviceAuthPersonal$ =
  personalClaudeCodeDeviceAuthSignals.run$;

export type { ClaudeCodeDeviceAuthFlowState };
