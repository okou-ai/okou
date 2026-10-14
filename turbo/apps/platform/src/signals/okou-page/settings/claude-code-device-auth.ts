import {
  claudeCodeDeviceAuthContract,
  type ClaudeCodeDeviceAuthMode,
  type ClaudeCodeDeviceAuthScope,
} from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command, computed, state, type Command, type State } from "ccstate";

import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import { apiClient$ } from "../../api-client.ts";
import { bestEffort, resetSignal, tapError } from "../../utils.ts";
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
  | { readonly status: "starting"; readonly requestId: string }
  | ActiveClaudeCodeDeviceAuthFlowState
  | { readonly status: "expired"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

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

function isCurrentStarting(
  stateValue: ClaudeCodeDeviceAuthFlowState,
  requestId: string,
): boolean {
  return stateValue.status === "starting" && stateValue.requestId === requestId;
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
  resetFlowSignal$: ReturnType<typeof resetSignal>;
}

function createClaudeCodeRunFlow$(ctx: ClaudeCodeDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const requestId = createRequestId(ctx.scope);
      set(ctx.internalFlowState$, { status: "starting", requestId });

      const dialog = get(ctx.internalDialogState$);
      const startArgs: {
        readonly scope: ClaudeCodeDeviceAuthScope;
        readonly mode?: ClaudeCodeDeviceAuthMode;
        readonly modelProviderId?: string;
      } = {
        scope: "personal",
        mode: dialog.mode === "reconnect" ? "reconnect" : "add",
        ...(dialog.modelProviderId
          ? { modelProviderId: dialog.modelProviderId }
          : {}),
      };

      const started = await tapError(
        set(startClaudeCodeDeviceAuth$, startArgs, signal),
      );
      signal.throwIfAborted();

      if (!isCurrentStarting(get(ctx.internalFlowState$), requestId)) {
        return false;
      }
      if (!started) {
        set(ctx.internalFlowState$, {
          status: "error",
          message: i18n.t(($) => {
            return $.settings.models.deviceAuth.claude.error;
          }),
        });
        return false;
      }

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
  runFlow$: ReturnType<typeof createClaudeCodeRunFlow$>,
) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const flowSignal = set(ctx.resetFlowSignal$, signal);
      flowSignal.addEventListener(
        "abort",
        () => {
          if (get(ctx.internalFlowState$).status === "starting") {
            set(ctx.internalFlowState$, createIdleFlowState());
          }
        },
        { once: true },
      );
      return await set(runFlow$, flowSignal);
    },
  );
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
      const completed = await set(
        completeClaudeCodeDeviceAuth$,
        current.sessionToken,
        current.authorizationCode,
        signal,
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

      set(ctx.reloadProviders$);
      toast.success(
        i18n.t(($) => {
          return $.settings.models.deviceAuth.claude.connectedToast;
        }),
      );
      set(ctx.internalDialogState$, createInitialDialogState());
      set(ctx.internalFlowState$, createIdleFlowState());
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

    if (!sessionToken) {
      return;
    }

    await bestEffort(
      set(cancelClaudeCodeDeviceAuth$, sessionToken, signal),
      signal,
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
    resetFlowSignal$: resetSignal(),
  };
  const runFlow$ = createClaudeCodeRunFlow$(ctx);
  const run$ = createClaudeCodeRun$(ctx, runFlow$);

  return {
    dialogState$: computed((get) => {
      return get(ctx.internalDialogState$);
    }),
    flowState$: computed((get) => {
      return get(ctx.internalFlowState$);
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
