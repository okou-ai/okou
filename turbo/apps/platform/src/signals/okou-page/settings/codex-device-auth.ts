import { command, computed, state, type Command, type State } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  codexDeviceAuthContract,
  type CodexDeviceAuthMode,
  type CodexDeviceAuthScope,
} from "@okouai/api-contracts/contracts/codex-device-auth";

import { accept } from "../../../lib/accept.ts";
import { i18n } from "../../../i18n/index.ts";
import { now } from "../../../lib/time.ts";
import { apiClient$ } from "../../api-client.ts";
import { brandName$, type BrandName } from "../../branding.ts";
import { reloadOrgModelProviders$ } from "../../external/org-model-providers.ts";
import {
  bestEffort,
  resetSignal,
  waitLoopUntil,
  tapError,
} from "../../utils.ts";
import { writeToClipboard } from "../clipboard.ts";
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
  readonly status: "pending" | "polling";
  readonly requestId: string;
  readonly sessionToken: string;
  readonly browserUrl: string;
  readonly verificationCode: string;
  readonly expiresAtMs: number;
  readonly pollIntervalMs: number;
  readonly approvalOpened: boolean;
  readonly codeCopied: boolean;
  readonly errorMessage: string | null;
};

type CodexDeviceAuthFlowState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly requestId: string }
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

function openApprovalPage(browserUrl: string): boolean {
  const approvalWindow = window.open(browserUrl, "_blank");
  if (!approvalWindow) {
    return false;
  }
  approvalWindow.opener = null;
  return true;
}

async function copyCodeAndOpenApprovalPage(
  current: ActiveCodexDeviceAuthFlowState,
): Promise<{ readonly opened: boolean; readonly copied: boolean }> {
  const copyPromise = writeToClipboard(current.verificationCode);
  const opened = openApprovalPage(current.browserUrl);
  const copied = await copyPromise;
  return { opened, copied };
}

function approvalAttemptErrorMessage(args: {
  readonly opened: boolean;
  readonly copied: boolean;
}): string | null {
  if (args.opened && args.copied) {
    return null;
  }
  if (!args.opened && !args.copied) {
    return i18n.t(($) => {
      return $.settings.models.deviceAuth.codex.copyAndOpenError;
    });
  }
  if (!args.opened) {
    return i18n.t(($) => {
      return $.settings.models.deviceAuth.codex.openError;
    });
  }
  return i18n.t(($) => {
    return $.settings.models.deviceAuth.codex.copyError;
  });
}

function isCurrentStarting(
  stateValue: CodexDeviceAuthFlowState,
  requestId: string,
): boolean {
  return stateValue.status === "starting" && stateValue.requestId === requestId;
}

function isCurrentActive(
  stateValue: CodexDeviceAuthFlowState,
  requestId: string,
): stateValue is ActiveCodexDeviceAuthFlowState {
  return (
    (stateValue.status === "pending" || stateValue.status === "polling") &&
    stateValue.requestId === requestId
  );
}

function isActive(
  stateValue: CodexDeviceAuthFlowState,
): stateValue is ActiveCodexDeviceAuthFlowState {
  return stateValue.status === "pending" || stateValue.status === "polling";
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
      [200, 400, 404, 503],
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
  scope: CodexDeviceAuthScope;
  reloadProviders$: Command<void, []>;
  internalDialogState$: State<CodexDeviceAuthDialogState>;
  internalFlowState$: State<CodexDeviceAuthFlowState>;
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

          set(ctx.internalFlowState$, { ...current, status: "polling" });
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

function createCodexRunFlow$(
  ctx: CodexDeviceAuthSignalContext,
  pollFlow$: ReturnType<typeof createCodexPollFlow$>,
) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const requestId = createRequestId(ctx.scope);
      set(ctx.internalFlowState$, { status: "starting", requestId });

      const dialog = get(ctx.internalDialogState$);
      const startArgs: {
        readonly scope: CodexDeviceAuthScope;
        readonly mode?: CodexDeviceAuthMode;
        readonly modelProviderId?: string;
      } =
        ctx.scope === "personal"
          ? {
              scope: ctx.scope,
              mode: dialog.mode === "reconnect" ? "reconnect" : "add",
              ...(dialog.modelProviderId
                ? { modelProviderId: dialog.modelProviderId }
                : {}),
            }
          : { scope: ctx.scope };

      const started = await tapError(
        set(startCodexDeviceAuth$, startArgs, signal),
      );
      signal.throwIfAborted();

      if (!isCurrentStarting(get(ctx.internalFlowState$), requestId)) {
        return false;
      }
      if (!started) {
        set(ctx.internalFlowState$, {
          status: "error",
          message: i18n.t(($) => {
            return $.settings.models.deviceAuth.codex.error;
          }),
        });
        return false;
      }

      const expiresAtMs = now() + secondsToMilliseconds(started.expiresIn);
      const pollIntervalMs = Math.max(
        secondsToMilliseconds(started.interval),
        CODEX_DEVICE_AUTH_MIN_POLL_MS,
      );

      set(ctx.internalFlowState$, {
        status: "pending",
        requestId,
        sessionToken: started.sessionToken,
        browserUrl: started.browserUrl,
        verificationCode: started.verificationCode,
        expiresAtMs,
        pollIntervalMs,
        approvalOpened: false,
        codeCopied: false,
        errorMessage: null,
      });

      return await set(pollFlow$, requestId, signal);
    },
  );
}

function createCodexRun$(
  ctx: CodexDeviceAuthSignalContext,
  runFlow$: ReturnType<typeof createCodexRunFlow$>,
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

function createCodexOpenApprovalPage$(ctx: CodexDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const current = get(ctx.internalFlowState$);
      if (!isActive(current)) {
        return false;
      }
      const result = await copyCodeAndOpenApprovalPage(current);
      signal.throwIfAborted();
      const latest = get(ctx.internalFlowState$);
      if (!isCurrentActive(latest, current.requestId)) {
        return result.opened;
      }
      set(ctx.internalFlowState$, {
        ...latest,
        approvalOpened: result.opened || latest.approvalOpened,
        codeCopied: result.copied || latest.codeCopied,
        errorMessage: approvalAttemptErrorMessage(result),
      });
      return result.opened;
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

    if (!sessionToken) {
      return;
    }

    await bestEffort(set(cancelCodexDeviceAuth$, sessionToken, signal), signal);
    signal.throwIfAborted();
  });
}

function createCodexDeviceAuthSignals(
  scope: CodexDeviceAuthScope,
  reloadProviders$: Command<void, []>,
) {
  const ctx: CodexDeviceAuthSignalContext = {
    scope,
    reloadProviders$,
    internalDialogState$: state(createInitialDialogState()),
    internalFlowState$: state<CodexDeviceAuthFlowState>(createIdleFlowState()),
    resetFlowSignal$: resetSignal(),
  };
  const pollFlow$ = createCodexPollFlow$(ctx);
  const runFlow$ = createCodexRunFlow$(ctx, pollFlow$);
  const run$ = createCodexRun$(ctx, runFlow$);

  return {
    dialogState$: computed((get) => {
      return get(ctx.internalDialogState$);
    }),
    flowState$: computed((get) => {
      return get(ctx.internalFlowState$);
    }),
    open$: createCodexOpen$(ctx, run$),
    openApprovalPage$: createCodexOpenApprovalPage$(ctx),
    close$: createCodexClose$(ctx),
    run$,
  };
}

export const {
  dialogState$: codexDeviceAuthDialogState$,
  flowState$: codexDeviceAuthFlowState$,
  open$: openCodexDeviceAuthDialog$,
  openApprovalPage$: openCodexDeviceAuthApprovalPage$,
  close$: closeCodexDeviceAuthDialog$,
  run$: runCodexDeviceAuth$,
} = createCodexDeviceAuthSignals("org", reloadOrgModelProviders$);

const personalCodexDeviceAuthSignals = createCodexDeviceAuthSignals(
  "personal",
  reloadPersonalModelProvider$,
);

export const codexDeviceAuthDialogStatePersonal$ =
  personalCodexDeviceAuthSignals.dialogState$;
export const codexDeviceAuthFlowStatePersonal$ =
  personalCodexDeviceAuthSignals.flowState$;
export const openCodexDeviceAuthDialogPersonal$: Command<
  Promise<boolean>,
  [OpenPersonalCodexDeviceAuthArgs, AbortSignal]
> = personalCodexDeviceAuthSignals.open$;
export const openCodexDeviceAuthApprovalPagePersonal$ =
  personalCodexDeviceAuthSignals.openApprovalPage$;
export const closeCodexDeviceAuthDialogPersonal$ =
  personalCodexDeviceAuthSignals.close$;
export const runCodexDeviceAuthPersonal$ = personalCodexDeviceAuthSignals.run$;

export type { CodexDeviceAuthFlowState };
