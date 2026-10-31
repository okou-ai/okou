import { codexDeviceAuthContract } from "@okouai/api-contracts/client/codex-device-auth";
import type {
  CodexDeviceAuthMode,
  CodexDeviceAuthScope,
} from "@okouai/api-contracts/contracts/codex-device-auth";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command, computed, state, type Command, type State } from "ccstate";
import { delay } from "signal-timers";

import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import { apiClient$ } from "../../api-client.ts";
import { brandName$, type BrandName } from "../../branding.ts";
import { resetSignal, waitLoopUntil, withCleanup } from "../../utils.ts";
import { reloadPersonalModelProvider$ } from "../model-first-personal-oauth.ts";

type CodexDeviceAuthDialogMode = "connect" | "reconnect";

interface CodexDeviceAuthDialogState {
  open: boolean;
  mode: CodexDeviceAuthDialogMode;
  modelProviderId: string | null;
}

type OpenCodexDeviceAuthArgs =
  | CodexDeviceAuthDialogMode
  | {
      readonly mode: CodexDeviceAuthDialogMode;
      readonly modelProviderId?: string;
    };

type OpenPersonalCodexDeviceAuthArgs =
  | { readonly mode: "connect" }
  | { readonly mode: "reconnect"; readonly modelProviderId: string };

type ActiveCodexDeviceAuthFlowState = {
  readonly status: "pending";
  readonly requestId: string;
  readonly sessionToken: string;
  readonly browserUrl: string;
  readonly verificationCode: string;
  readonly expiresAtMs: number;
  readonly pollIntervalMs: number;
  readonly errorMessage: string | null;
};

type CodexDeviceAuthFlowState =
  | { readonly status: "idle" }
  | ActiveCodexDeviceAuthFlowState
  | { readonly status: "expired"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

const CODEX_DEVICE_AUTH_MIN_POLL_MS = 1000;

function createInitialDialogState(): CodexDeviceAuthDialogState {
  return {
    open: false,
    mode: "connect",
    modelProviderId: null,
  };
}

function createIdleFlowState(): CodexDeviceAuthFlowState {
  return { status: "idle" };
}

function createRequestId(scope: CodexDeviceAuthScope): string {
  return `${scope}-codex-device-auth-${now()}-${Math.random().toString(36).slice(2)}`;
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1000;
}

function codexDeviceAuthErrorMessage(
  error: {
    readonly code: string;
    readonly message: string;
  },
  brandName: BrandName,
): string {
  if (error.code === "CODEX_AUTH_JSON_SHAPE_INVALID") {
    return i18n.t(
      ($) => {
        return $.settings.models.deviceAuth.codex.invalidTokenFormat;
      },
      { brandName },
    );
  }
  if (error.code === "CODEX_FREE_PLAN_REJECTED") {
    return i18n.t(
      ($) => {
        return $.settings.models.deviceAuth.codex.freePlanRejected;
      },
      { brandName },
    );
  }
  return error.message;
}

function isCurrentActive(
  stateValue: CodexDeviceAuthFlowState,
  requestId: string,
): stateValue is ActiveCodexDeviceAuthFlowState {
  return stateValue.status === "pending" && stateValue.requestId === requestId;
}

function isActive(
  stateValue: CodexDeviceAuthFlowState,
): stateValue is ActiveCodexDeviceAuthFlowState {
  return stateValue.status === "pending";
}

function activeFlowOrExpired(
  flow: CodexDeviceAuthFlowState,
  requestId: string,
): number {
  return isCurrentActive(flow, requestId) ? flow.expiresAtMs : 0;
}

const startCodexDeviceAuth$ = command(
  async (
    { get },
    args: {
      readonly scope: CodexDeviceAuthScope;
      readonly mode?: CodexDeviceAuthMode;
      readonly modelProviderId?: string;
    },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(codexDeviceAuthContract, {
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

const completeCodexDeviceAuth$ = command(
  async ({ get }, sessionToken: string, signal: AbortSignal) => {
    const client = get(apiClient$)(codexDeviceAuthContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.complete({
        body: { sessionToken },
        fetchOptions: { signal },
      }),
      [200, 400, 404],
    );
    signal.throwIfAborted();
    return result;
  },
);

const cancelCodexDeviceAuth$ = command(
  async ({ get }, sessionToken: string, signal: AbortSignal) => {
    const client = get(apiClient$)(codexDeviceAuthContract, {
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

interface CodexDeviceAuthSignalContext {
  scope: "personal";
  reloadProviders$: Command<void, []>;
  internalDialogState$: State<CodexDeviceAuthDialogState>;
  internalFlowState$: State<CodexDeviceAuthFlowState>;
  internalStartOperation$: State<Promise<boolean> | null>;
  internalRunOperation$: State<Promise<boolean> | null>;
  resetFlowSignal$: ReturnType<typeof resetSignal>;
}

function createCodexPollFlow$(ctx: CodexDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, requestId: string, signal: AbortSignal) => {
      let completed = false;
      let expired = false;

      await waitLoopUntil(
        async (loopSignal) => {
          const remainingMs =
            activeFlowOrExpired(get(ctx.internalFlowState$), requestId) - now();
          if (remainingMs <= 0) {
            expired = true;
            return true;
          }

          const current = get(ctx.internalFlowState$);
          if (!isCurrentActive(current, requestId)) {
            return true;
          }

          const completion = await set(
            completeCodexDeviceAuth$,
            current.sessionToken,
            loopSignal,
          );
          loopSignal.throwIfAborted();

          const latest = get(ctx.internalFlowState$);
          if (!isCurrentActive(latest, requestId)) {
            return true;
          }

          if (completion.status !== 200) {
            set(ctx.internalFlowState$, {
              status: "error",
              message: codexDeviceAuthErrorMessage(
                completion.body.error,
                get(brandName$),
              ),
            });
            return true;
          }

          if (completion.body.status === "complete") {
            set(ctx.reloadProviders$);
            toast.success(
              i18n.t(($) => {
                return $.settings.models.deviceAuth.codex.connectedToast;
              }),
            );
            set(ctx.internalDialogState$, createInitialDialogState());
            set(ctx.internalFlowState$, createIdleFlowState());
            set(ctx.internalStartOperation$, null);
            completed = true;
            return true;
          }

          set(ctx.internalFlowState$, {
            ...latest,
            status: "pending",
            errorMessage: completion.body.errorMessage,
          });

          const nextRemainingMs = latest.expiresAtMs - now();
          if (nextRemainingMs <= 0) {
            expired = true;
            return true;
          }
          await delay(Math.min(latest.pollIntervalMs, nextRemainingMs), {
            signal: loopSignal,
          });
          loopSignal.throwIfAborted();
          return false;
        },
        0,
        signal,
      );

      const latest = get(ctx.internalFlowState$);
      if (expired && isCurrentActive(latest, requestId)) {
        set(ctx.internalFlowState$, {
          status: "expired",
          message: i18n.t(($) => {
            return $.settings.models.deviceAuth.codex.expired;
          }),
        });
      }
      return completed;
    },
  );
}

function createCodexStartFlow$(ctx: CodexDeviceAuthSignalContext) {
  return command(
    async (
      { get, set },
      requestId: string,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const dialog = get(ctx.internalDialogState$);
      const started = await set(
        startCodexDeviceAuth$,
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
        verificationCode: started.verificationCode,
        expiresAtMs: now() + secondsToMilliseconds(started.expiresIn),
        pollIntervalMs: Math.max(
          secondsToMilliseconds(started.interval),
          CODEX_DEVICE_AUTH_MIN_POLL_MS,
        ),
        errorMessage: null,
      });
      return true;
    },
  );
}

function createCodexRun$(
  ctx: CodexDeviceAuthSignalContext,
  startFlow$: ReturnType<typeof createCodexStartFlow$>,
  pollFlow$: ReturnType<typeof createCodexPollFlow$>,
) {
  const execute$ = command(
    async ({ set }, signal: AbortSignal): Promise<boolean> => {
      const flowSignal = set(ctx.resetFlowSignal$, signal);
      set(ctx.internalFlowState$, createIdleFlowState());
      const requestId = createRequestId(ctx.scope);
      const operation = set(startFlow$, requestId, flowSignal);
      // Retain the actual startup result for this authorization session.
      set(ctx.internalStartOperation$, operation);
      if (!(await operation)) {
        return false;
      }
      flowSignal.throwIfAborted();
      return await set(pollFlow$, requestId, flowSignal);
    },
  );
  return command(({ set }, signal: AbortSignal) => {
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    const operation = withCleanup(set(execute$, signal), () => {
      set(ctx.reloadProviders$);
    });
    set(ctx.internalRunOperation$, operation);
    return operation;
  });
}

function createCodexOpen$(
  ctx: CodexDeviceAuthSignalContext,
  run$: ReturnType<typeof createCodexRun$>,
) {
  return command(
    async (
      { set },
      args: OpenCodexDeviceAuthArgs,
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

function createCodexClose$(ctx: CodexDeviceAuthSignalContext) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(ctx.internalFlowState$);
    const sessionToken = isActive(current) ? current.sessionToken : null;
    set(ctx.resetFlowSignal$);
    set(ctx.internalDialogState$, createInitialDialogState());
    set(ctx.internalFlowState$, createIdleFlowState());
    set(ctx.internalStartOperation$, null);
    set(ctx.internalRunOperation$, null);

    if (!sessionToken) {
      set(ctx.reloadProviders$);
      return;
    }

    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(set(cancelCodexDeviceAuth$, sessionToken, signal), () => {
      set(ctx.reloadProviders$);
    });
    signal.throwIfAborted();
  });
}

function createCodexDeviceAuthSignals(
  scope: "personal",
  reloadProviders$: Command<void, []>,
) {
  const ctx: CodexDeviceAuthSignalContext = {
    scope,
    reloadProviders$,
    internalDialogState$: state(createInitialDialogState()),
    internalFlowState$: state<CodexDeviceAuthFlowState>(createIdleFlowState()),
    internalStartOperation$: state<Promise<boolean> | null>(null),
    internalRunOperation$: state<Promise<boolean> | null>(null),
    resetFlowSignal$: resetSignal(),
  };
  const pollFlow$ = createCodexPollFlow$(ctx);
  const startFlow$ = createCodexStartFlow$(ctx);
  const run$ = createCodexRun$(ctx, startFlow$, pollFlow$);

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
    runOperation$: computed((get) => {
      return get(ctx.internalRunOperation$);
    }),
    open$: createCodexOpen$(ctx, run$),
    close$: createCodexClose$(ctx),
    run$,
  };
}

const personalCodexDeviceAuthSignals = createCodexDeviceAuthSignals(
  "personal",
  reloadPersonalModelProvider$,
);

export const codexDeviceAuthDialogStatePersonal$ =
  personalCodexDeviceAuthSignals.dialogState$;
export const codexDeviceAuthFlowStatePersonal$ =
  personalCodexDeviceAuthSignals.flowState$;
export const codexDeviceAuthStartOperationPersonal$ =
  personalCodexDeviceAuthSignals.startOperation$;
export const codexDeviceAuthRunOperationPersonal$ =
  personalCodexDeviceAuthSignals.runOperation$;
export const openCodexDeviceAuthDialogPersonal$: Command<
  Promise<boolean>,
  [OpenPersonalCodexDeviceAuthArgs, AbortSignal]
> = personalCodexDeviceAuthSignals.open$;
export const closeCodexDeviceAuthDialogPersonal$ =
  personalCodexDeviceAuthSignals.close$;
export const runCodexDeviceAuthPersonal$ = personalCodexDeviceAuthSignals.run$;

export type { CodexDeviceAuthFlowState };
