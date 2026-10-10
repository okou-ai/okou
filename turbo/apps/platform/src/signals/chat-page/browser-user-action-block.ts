import {
  BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_BYTES,
  BROWSER_USER_ACTION_MAX_FILES,
  BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH,
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  browserUserActionsContract,
  type BrowserUserActionApplyRequest,
  type BrowserUserActionPrepareFileUploadRequest,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { fetchResource } from "../../lib/resource-fetch.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  onRef,
  onRejection,
  resetSignal,
  settle,
  waitForOperation,
  waitLoopUntil,
} from "../utils.ts";
import {
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
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

const REQUEST_TOKEN_PATTERN = /^vm0_browser_user_action_[A-Za-z0-9_-]{43}$/u;
const RECOVERY_INTERVAL_MS = 2000;
const RECOVERY_MAX_READS = 35;
const RECOVERY_DEADLINE_MS = 90_000;
export const BROWSER_INPUT_CANCELLATION_PROMPT =
  "The user cancelled the browser input request.";

type BrowserInputAction = Extract<
  BrowserUserActionResponse,
  { readonly kind: "input" }
>;
type BrowserUserAction = BrowserInputAction;

export interface BrowserUserActionDescriptor {
  readonly requestToken: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly callbackPrompt: string;
  readonly originalUrl: string;
}

export type BrowserUserActionRequestState =
  | { readonly kind: "action"; readonly action: BrowserUserAction }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable" };

export interface BrowserSelectChoiceDraft {
  readonly optionIndexes: readonly number[];
  readonly optionSetFingerprint: string;
}

export interface BrowserCheckboxDraft {
  readonly checked: boolean;
  readonly observedChecked: boolean;
}

export interface BrowserRadioDraft {
  readonly memberIndex: number;
  readonly observedSelectedIndex: number;
  readonly groupFingerprint: string;
}

export interface BrowserRangeDraft {
  readonly observedValue: string;
  readonly observedMin?: string;
  readonly observedMax?: string;
  readonly observedStep?: string;
  readonly value: string;
}

export interface BrowserColorDraft {
  readonly observedColor: string;
  readonly value: string;
}

export interface BrowserFileDraft {
  readonly operation: "keep" | "replace" | "clear";
  readonly files: readonly File[];
  readonly observedFingerprint: string;
}

export interface BrowserUserActionSignals extends BrowserUserActionDescriptor {
  readonly request$: Computed<Promise<BrowserUserActionRequestState>>;
  readonly draft$: Computed<ReadonlyMap<string, string>>;
  readonly choiceDraft$: Computed<
    ReadonlyMap<string, BrowserSelectChoiceDraft>
  >;
  readonly checkboxDraft$: Computed<ReadonlyMap<string, BrowserCheckboxDraft>>;
  readonly radioDraft$: Computed<ReadonlyMap<string, BrowserRadioDraft>>;
  readonly rangeDraft$: Computed<ReadonlyMap<string, BrowserRangeDraft>>;
  readonly updateRangeDraft$: Command<void, [string, BrowserRangeDraft]>;
  readonly removeRangeDraft$: Command<void, [string]>;
  readonly colorDraft$: Computed<ReadonlyMap<string, BrowserColorDraft>>;
  readonly updateColorDraft$: Command<void, [string, BrowserColorDraft]>;
  readonly removeColorDraft$: Command<void, [string]>;
  readonly fileDraft$: Computed<ReadonlyMap<string, BrowserFileDraft>>;
  readonly updateFileDraft$: Command<void, [string, BrowserFileDraft]>;
  readonly removeFileDraft$: Command<void, [string]>;
  readonly callbackDelivered$: Computed<boolean>;
  readonly callbackFailed$: Computed<boolean>;
  readonly busy$: Computed<boolean>;
  readonly entryState$: Computed<
    "idle" | "checking" | "ready" | "unavailable" | "invalid"
  >;
  readonly entryAction$: Computed<BrowserInputAction | null>;
  readonly beginEntry$: Command<Promise<void>, [AbortSignal]>;
  readonly invalidateEntry$: Command<void, []>;
  readonly startStandaloneEntry$: Command<Promise<void>, [AbortSignal]>;
  readonly retryStandaloneRequest$: Command<Promise<void>, [AbortSignal]>;
  readonly refresh$: Command<void, [signal?: AbortSignal]>;
  readonly recoveryState$: Computed<"idle" | "checking" | "exhausted">;
  readonly recover$: Command<void, []>;
  readonly recoveryRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  readonly updateDraft$: Command<void, [string, string]>;
  readonly updateChoiceDraft$: Command<
    void,
    [string, readonly number[], string]
  >;
  readonly removeChoiceDraft$: Command<void, [string]>;
  readonly updateCheckboxDraft$: Command<void, [string, boolean, boolean]>;
  readonly removeCheckboxDraft$: Command<void, [string]>;
  readonly updateRadioDraft$: Command<void, [string, BrowserRadioDraft]>;
  readonly removeRadioDraft$: Command<void, [string]>;
  readonly removeDraft$: Command<void, [string]>;
  readonly clearDraft$: Command<void, []>;
  readonly clearDraftRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  readonly resumeRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  readonly dialogRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  readonly formRef$: Command<
    (() => void) | undefined,
    [HTMLFormElement | null]
  >;
  readonly submit$: Command<Promise<void>, [AbortSignal]>;
  readonly cancel$: Command<Promise<void>, [AbortSignal]>;
  readonly continue$: Command<Promise<void>, [AbortSignal]>;
}

function createEntrySignals(
  descriptor: BrowserUserActionDescriptor,
  refresh$: BrowserUserActionSignals["refresh$"],
): Pick<
  BrowserUserActionSignals,
  "entryState$" | "entryAction$" | "beginEntry$" | "invalidateEntry$"
> {
  const internalState$ = state<
    "idle" | "checking" | "ready" | "unavailable" | "invalid"
  >("idle");
  const internalAction$ = state<BrowserInputAction | null>(null);
  const resetEntrySignal$ = resetSignal();
  const beginEntry$ = command(async ({ get, set }, signal: AbortSignal) => {
    const operationSignal = set(resetEntrySignal$, signal);
    set(internalState$, "checking");
    set(internalAction$, null);
    const checked = await settle(
      accept(
        get(apiClient$)(browserUserActionsContract).preflight({
          params: { requestToken: descriptor.requestToken },
          body: {},
          fetchOptions: { signal: operationSignal },
        }),
        [200, 403, 404, 409, 410, 502, 503],
        operationSignal,
      ),
      operationSignal,
    );
    signal.throwIfAborted();
    operationSignal.throwIfAborted();
    if (!checked.ok) {
      set(internalState$, "unavailable");
      return;
    }
    if (
      checked.value.status === 200 &&
      actionMatches(checked.value.body, descriptor) &&
      checked.value.body.kind === "input" &&
      checked.value.body.state === "pending"
    ) {
      set(internalAction$, checked.value.body);
      set(internalState$, "ready");
      return;
    }
    set(internalState$, "unavailable");
    const status: number = checked.value.status;
    if (status !== 502 && status !== 503) {
      set(refresh$);
    }
  });
  const invalidateEntry$ = command(({ set }) => {
    set(internalAction$, null);
    set(internalState$, "invalid");
  });
  return {
    entryState$: computed((get) => {
      return get(internalState$);
    }),
    entryAction$: computed((get) => {
      return get(internalAction$);
    }),
    beginEntry$,
    invalidateEntry$,
  };
}

function createStandaloneEntrySignals(
  request$: BrowserUserActionSignals["request$"],
  refresh$: BrowserUserActionSignals["refresh$"],
  beginEntry$: BrowserUserActionSignals["beginEntry$"],
): Pick<
  BrowserUserActionSignals,
  "startStandaloneEntry$" | "retryStandaloneRequest$"
> {
  const startStandaloneEntry$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const loaded = await settle(get(request$), signal);
      if (!loaded.ok) {
        return;
      }
      const request = loaded.value;
      if (
        request.kind === "action" &&
        request.action.kind === "input" &&
        request.action.state === "pending"
      ) {
        await set(beginEntry$, signal);
      }
    },
  );
  const retryStandaloneRequest$ = command(
    async ({ set }, signal: AbortSignal) => {
      set(refresh$, signal);
      await set(startStandaloneEntry$, signal);
    },
  );
  return { startStandaloneEntry$, retryStandaloneRequest$ };
}

type BrowserUserActionCardSignalsRegistry = CardSignalsRegistry<
  BrowserUserActionDescriptor,
  BrowserUserActionSignals
>;

function hasExactQuery(url: URL): boolean {
  const expected = ["agentId", "threadId", "callbackPrompt"] as const;
  return (
    [...url.searchParams.keys()].every((key) => {
      return expected.includes(key as (typeof expected)[number]);
    }) &&
    expected.every((key) => {
      return url.searchParams.getAll(key).length === 1;
    })
  );
}

function hasValidBrowserUserActionClaims(
  agentId: string,
  threadId: string,
  context: ChatActionContext | undefined,
): boolean {
  if (
    !chatActionIdMatches(agentId, agentId) ||
    !chatActionIdMatches(threadId, threadId)
  ) {
    return false;
  }
  return (
    !context ||
    (chatActionIdMatches(agentId, context.agentId) &&
      chatActionIdMatches(threadId, context.threadId))
  );
}

function hasValidBrowserUserActionParts(args: {
  readonly requestToken: string;
  readonly callbackPrompt: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly url: URL;
  readonly context: ChatActionContext | undefined;
}): boolean {
  return (
    REQUEST_TOKEN_PATTERN.test(args.requestToken) &&
    hasExactQuery(args.url) &&
    hasValidBrowserUserActionClaims(
      args.agentId,
      args.threadId,
      args.context,
    ) &&
    args.callbackPrompt.trim() !== "" &&
    args.callbackPrompt.length <= BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH
  );
}

export function parseBrowserUserActionUrl(
  value: string,
  context?: ChatActionContext,
): ChatActionParseResult<BrowserUserActionDescriptor> {
  const url = parseTrustedPlatformActionUrl(value);
  if (!url) {
    return { status: "unrelated" };
  }
  const match = url.pathname.match(/^\/browser\/actions\/([^/]+)$/u);
  if (!match) {
    return url.pathname.startsWith("/browser/actions/")
      ? { status: "invalid", originalUrl: value }
      : { status: "unrelated" };
  }

  const requestToken = match[1] ?? "";
  const agentId = url.searchParams.get("agentId") ?? "";
  const threadId = url.searchParams.get("threadId") ?? "";
  const callbackPrompt = url.searchParams.get("callbackPrompt") ?? "";
  if (
    url.hash !== "" ||
    !hasValidBrowserUserActionParts({
      requestToken,
      callbackPrompt,
      agentId,
      threadId,
      url,
      context,
    })
  ) {
    return { status: "invalid", originalUrl: value };
  }

  return {
    status: "valid",
    descriptor: {
      requestToken,
      agentId: context?.agentId ?? agentId,
      threadId: context?.threadId ?? threadId,
      callbackPrompt,
      originalUrl: value,
    },
  };
}

export function browserUserActionResourceKey(
  descriptor: BrowserUserActionDescriptor,
): string {
  return JSON.stringify([
    descriptor.requestToken,
    descriptor.agentId.toLowerCase(),
    descriptor.threadId.toLowerCase(),
    descriptor.callbackPrompt,
  ]);
}

function actionMatches(
  action: BrowserUserActionResponse,
  descriptor: BrowserUserActionDescriptor,
): action is BrowserUserAction {
  return (
    action.requestToken === descriptor.requestToken &&
    chatActionIdMatches(action.agentId, descriptor.agentId) &&
    chatActionIdMatches(action.threadId, descriptor.threadId)
  );
}

async function readBrowserUserAction(
  client: ApiClientFactory,
  descriptor: BrowserUserActionDescriptor,
  signal?: AbortSignal,
): Promise<BrowserUserActionRequestState> {
  signal?.throwIfAborted();
  const result = await accept(
    client(browserUserActionsContract).get({
      params: { requestToken: descriptor.requestToken },
      fetchOptions: { signal },
    }),
    [200, 403, 404, 409, 410],
    signal,
    { showErrorToast: false },
  );
  signal?.throwIfAborted();
  const status: number = result.status;
  if (status === 410) {
    return { kind: "expired" };
  }
  if (status !== 200 || !actionMatches(result.body, descriptor)) {
    return { kind: "unavailable" };
  }
  return { kind: "action", action: result.body };
}

function createRequestSignals(descriptor: BrowserUserActionDescriptor) {
  // Owned reads publish their Promise, never a late resolved snapshot.
  const refreshedRequest$ =
    state<Promise<BrowserUserActionRequestState> | null>(null);
  const resetRead$ = resetSignal();
  const request$ = computed(
    async (get): Promise<BrowserUserActionRequestState> => {
      if (get(featureSwitch$)[FeatureSwitchKey.BrowserNativeInput] !== true) {
        return { kind: "unavailable" };
      }
      return await (get(refreshedRequest$) ??
        readBrowserUserAction(get(apiClient$), descriptor));
    },
  );
  const refresh$ = command(({ get, set }, parentSignal?: AbortSignal) => {
    const signal = set(resetRead$, parentSignal ?? get(pageSignal$));
    signal.throwIfAborted();
    if (get(featureSwitch$)[FeatureSwitchKey.BrowserNativeInput] !== true) {
      return;
    }
    set(
      refreshedRequest$,
      readBrowserUserAction(get(apiClient$), descriptor, signal),
    );
  });
  return { request$, refresh$ };
}

function createRecoverySignals(
  request$: BrowserUserActionSignals["request$"],
  refresh$: BrowserUserActionSignals["refresh$"],
  beginEntry$: BrowserUserActionSignals["beginEntry$"],
) {
  const internalState$ = state<"idle" | "checking" | "exhausted">("idle");
  const ownerCount$ = state(0);
  const resetRecovery$ = resetSignal();
  const recoveryState$ = computed((get) => {
    return get(internalState$);
  });
  const recover$ = command(({ set }) => {
    set(internalState$, "checking");
  });
  const recoveryRef$ = onRef(
    command(
      async (
        { get, set },
        _element: HTMLDivElement,
        ownerSignal: AbortSignal,
      ) => {
        ownerSignal.throwIfAborted();
        set(ownerCount$, (count) => {
          return count + 1;
        });
        ownerSignal.addEventListener(
          "abort",
          () => {
            set(ownerCount$, (count) => {
              return Math.max(0, count - 1);
            });
            if (get(ownerCount$) === 0) {
              set(resetRecovery$);
            }
          },
          { once: true },
        );
        if (get(ownerCount$) > 1) {
          return;
        }
        // Duplicate cards share one loop, cancelled when their last owner leaves.
        const signal = set(resetRecovery$, get(pageSignal$));
        set(internalState$, "checking");
        const recoverySignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(RECOVERY_DEADLINE_MS),
        ]);
        let reads = 0;
        let reconciled = false;
        await settle(
          waitLoopUntil(
            async () => {
              set(refresh$, recoverySignal);
              const result = await settle(
                waitForOperation(get(request$), recoverySignal),
                recoverySignal,
              );
              if (
                result.ok &&
                (result.value.kind !== "action" ||
                  result.value.action.state !== "applying")
              ) {
                if (
                  result.value.kind === "action" &&
                  result.value.action.state === "pending"
                ) {
                  await set(beginEntry$, recoverySignal);
                  recoverySignal.throwIfAborted();
                }
                reconciled = true;
                return true;
              }
              reads += 1;
              return reads >= RECOVERY_MAX_READS;
            },
            RECOVERY_INTERVAL_MS,
            recoverySignal,
            { retryTransientErrors: false },
          ),
          signal,
        );
        signal.throwIfAborted();
        set(internalState$, reconciled ? "idle" : "exhausted");
      },
    ),
  );
  return { recoveryState$, recover$, recoveryRef$ };
}

function createCheckboxDraftSignals() {
  const internalCheckboxDraft$ = state<
    ReadonlyMap<string, BrowserCheckboxDraft>
  >(new Map());
  const checkboxDraft$ = computed((get) => {
    return get(internalCheckboxDraft$);
  });
  const updateCheckboxDraft$ = command(
    (
      { set },
      key: string,
      checked: boolean,
      observedChecked: boolean,
    ): void => {
      set(internalCheckboxDraft$, (current) => {
        return new Map(current).set(key, { checked, observedChecked });
      });
    },
  );
  const removeCheckboxDraft$ = command(({ set }, key: string): void => {
    set(internalCheckboxDraft$, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });
  return {
    internalCheckboxDraft$,
    checkboxDraft$,
    updateCheckboxDraft$,
    removeCheckboxDraft$,
  };
}

function createRadioDraftSignals() {
  const internalRadioDraft$ = state<ReadonlyMap<string, BrowserRadioDraft>>(
    new Map(),
  );
  const radioDraft$ = computed((get) => {
    return get(internalRadioDraft$);
  });
  const updateRadioDraft$ = command(
    ({ set }, key: string, choice: BrowserRadioDraft): void => {
      set(internalRadioDraft$, (current) => {
        return new Map(current).set(key, choice);
      });
    },
  );
  const removeRadioDraft$ = command(({ set }, key: string): void => {
    set(internalRadioDraft$, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });
  return {
    internalRadioDraft$,
    radioDraft$,
    updateRadioDraft$,
    removeRadioDraft$,
  };
}

function createRangeDraftSignals() {
  const internalRangeDraft$ = state<ReadonlyMap<string, BrowserRangeDraft>>(
    new Map(),
  );
  const rangeDraft$ = computed((get) => {
    return get(internalRangeDraft$);
  });
  const updateRangeDraft$ = command(
    ({ set }, key: string, choice: BrowserRangeDraft): void => {
      set(internalRangeDraft$, (current) => {
        return new Map(current).set(key, choice);
      });
    },
  );
  const removeRangeDraft$ = command(({ set }, key: string): void => {
    set(internalRangeDraft$, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });
  return {
    internalRangeDraft$,
    rangeDraft$,
    updateRangeDraft$,
    removeRangeDraft$,
  };
}

function createColorDraftSignals() {
  const internalColorDraft$ = state<ReadonlyMap<string, BrowserColorDraft>>(
    new Map(),
  );
  const colorDraft$ = computed((get) => {
    return get(internalColorDraft$);
  });
  const updateColorDraft$ = command(
    ({ set }, key: string, choice: BrowserColorDraft): void => {
      set(internalColorDraft$, (current) => {
        return new Map(current).set(key, choice);
      });
    },
  );
  const removeColorDraft$ = command(({ set }, key: string): void => {
    set(internalColorDraft$, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });
  return {
    internalColorDraft$,
    colorDraft$,
    updateColorDraft$,
    removeColorDraft$,
  };
}

function createScalarDraftUpdater(
  internalDraft$: State<ReadonlyMap<string, string>>,
) {
  return command(({ set }, key: string, value: string): void => {
    const boundedValue = value.slice(0, BROWSER_USER_ACTION_MAX_VALUE_LENGTH);
    set(internalDraft$, (current) => {
      const next = new Map(current);
      next.set(key, boundedValue);
      return next;
    });
  });
}

function createSelectDraftSignals() {
  const internalChoiceDraft$ = state<
    ReadonlyMap<string, BrowserSelectChoiceDraft>
  >(new Map());
  const choiceDraft$ = computed((get) => {
    return get(internalChoiceDraft$);
  });
  const updateChoiceDraft$ = command(
    (
      { set },
      key: string,
      indices: readonly number[],
      optionSetFingerprint: string,
    ): void => {
      set(internalChoiceDraft$, (current) => {
        return new Map(current).set(key, {
          optionIndexes: [...indices],
          optionSetFingerprint,
        });
      });
    },
  );
  const removeChoiceDraft$ = command(({ set }, key: string): void => {
    set(internalChoiceDraft$, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });
  return {
    internalChoiceDraft$,
    choiceDraft$,
    updateChoiceDraft$,
    removeChoiceDraft$,
  };
}

function createFileDraftSignals() {
  const internalFileDraft$ = state<ReadonlyMap<string, BrowserFileDraft>>(
    new Map(),
  );
  const fileDraft$ = computed((get) => {
    return get(internalFileDraft$);
  });
  const updateFileDraft$ = command(
    ({ set }, key: string, value: BrowserFileDraft) => {
      set(internalFileDraft$, (current) => {
        return new Map(current).set(key, value);
      });
    },
  );
  const removeFileDraft$ = command(({ set }, key: string) => {
    set(internalFileDraft$, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });
  return { internalFileDraft$, fileDraft$, updateFileDraft$, removeFileDraft$ };
}

type BrowserDraftSignals = Pick<
  BrowserUserActionSignals,
  | "draft$"
  | "choiceDraft$"
  | "checkboxDraft$"
  | "radioDraft$"
  | "rangeDraft$"
  | "updateRangeDraft$"
  | "removeRangeDraft$"
  | "colorDraft$"
  | "updateColorDraft$"
  | "removeColorDraft$"
  | "fileDraft$"
  | "updateFileDraft$"
  | "removeFileDraft$"
  | "updateRadioDraft$"
  | "removeRadioDraft$"
  | "updateCheckboxDraft$"
  | "removeCheckboxDraft$"
  | "updateDraft$"
  | "updateChoiceDraft$"
  | "removeChoiceDraft$"
  | "removeDraft$"
  | "clearDraft$"
  | "clearDraftRef$"
  | "formRef$"
>;

function createDraftSignals(): BrowserDraftSignals {
  const internalDraft$ = state<ReadonlyMap<string, string>>(new Map());
  const selectSignals = createSelectDraftSignals();
  const checkboxSignals = createCheckboxDraftSignals();
  const radioSignals = createRadioDraftSignals();
  const rangeSignals = createRangeDraftSignals();
  const colorSignals = createColorDraftSignals();
  const fileSignals = createFileDraftSignals();
  const ownerCount$ = state(0);
  const draft$ = computed((get) => {
    return get(internalDraft$);
  });
  const updateDraft$ = createScalarDraftUpdater(internalDraft$);
  const clearDraft$ = command(({ set }): void => {
    set(internalDraft$, new Map());
    set(selectSignals.internalChoiceDraft$, new Map());
    set(checkboxSignals.internalCheckboxDraft$, new Map());
    set(radioSignals.internalRadioDraft$, new Map());
    set(rangeSignals.internalRangeDraft$, new Map());
    set(colorSignals.internalColorDraft$, new Map());
    set(fileSignals.internalFileDraft$, new Map());
  });
  const removeDraft$ = command(({ set }, key: string): void => {
    set(internalDraft$, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  });
  const clearDraftKeys$ = command(({ set }, keys: readonly string[]): void => {
    if (keys.length === 0) {
      return;
    }
    set(internalDraft$, (current) => {
      const next = new Map(current);
      for (const key of keys) {
        next.delete(key);
      }
      return next;
    });
  });
  const ownForm$ = command(
    ({ set }, form: HTMLFormElement, signal: AbortSignal): void => {
      signal.throwIfAborted();
      const passwordKeys = [...form.elements].flatMap((element) => {
        return element instanceof HTMLInputElement &&
          element.type === "password" &&
          element.name !== ""
          ? [element.name]
          : [];
      });
      set(ownerCount$, (count) => {
        return count + 1;
      });
      signal.addEventListener(
        "abort",
        () => {
          set(ownerCount$, (count) => {
            const next = Math.max(0, count - 1);
            if (next === 0) {
              set(clearDraftKeys$, passwordKeys);
              set(fileSignals.internalFileDraft$, new Map());
            }
            return next;
          });
        },
        { once: true },
      );
    },
  );
  const clearDraftOnMount$ = command(
    ({ set }, _element: HTMLDivElement, signal: AbortSignal): void => {
      signal.throwIfAborted();
      set(clearDraft$);
    },
  );
  return {
    draft$,
    choiceDraft$: selectSignals.choiceDraft$,
    checkboxDraft$: checkboxSignals.checkboxDraft$,
    radioDraft$: radioSignals.radioDraft$,
    rangeDraft$: rangeSignals.rangeDraft$,
    updateRangeDraft$: rangeSignals.updateRangeDraft$,
    removeRangeDraft$: rangeSignals.removeRangeDraft$,
    colorDraft$: colorSignals.colorDraft$,
    updateColorDraft$: colorSignals.updateColorDraft$,
    removeColorDraft$: colorSignals.removeColorDraft$,
    fileDraft$: fileSignals.fileDraft$,
    updateFileDraft$: fileSignals.updateFileDraft$,
    removeFileDraft$: fileSignals.removeFileDraft$,
    updateRadioDraft$: radioSignals.updateRadioDraft$,
    removeRadioDraft$: radioSignals.removeRadioDraft$,
    updateCheckboxDraft$: checkboxSignals.updateCheckboxDraft$,
    removeCheckboxDraft$: checkboxSignals.removeCheckboxDraft$,
    updateDraft$,
    updateChoiceDraft$: selectSignals.updateChoiceDraft$,
    removeChoiceDraft$: selectSignals.removeChoiceDraft$,
    removeDraft$,
    clearDraft$,
    clearDraftRef$: onRef(clearDraftOnMount$),
    formRef$: onRef(ownForm$),
  };
}

function callbackArgs(
  descriptor: BrowserUserActionDescriptor,
  callbackPrompt: string,
  callbackIds: ChatActionCallbackIds,
) {
  return {
    threadId: descriptor.threadId,
    agentId: descriptor.agentId,
    callbackPrompt,
    callbackIds,
  };
}

interface BrowserUserActionMutationContext {
  readonly descriptor: BrowserUserActionDescriptor;
  readonly request$: BrowserUserActionSignals["request$"];
  readonly refresh$: BrowserUserActionSignals["refresh$"];
  readonly recover$: BrowserUserActionSignals["recover$"];
  readonly busy$: BrowserUserActionSignals["busy$"];
  readonly write$: ReturnType<typeof createBrowserMutationSignal>;
  readonly draft$: BrowserUserActionSignals["draft$"];
  readonly choiceDraft$: BrowserUserActionSignals["choiceDraft$"];
  readonly checkboxDraft$: BrowserUserActionSignals["checkboxDraft$"];
  readonly radioDraft$: BrowserUserActionSignals["radioDraft$"];
  readonly rangeDraft$: BrowserUserActionSignals["rangeDraft$"];
  readonly colorDraft$: BrowserUserActionSignals["colorDraft$"];
  readonly fileDraft$: BrowserUserActionSignals["fileDraft$"];
  readonly entryAction$: BrowserUserActionSignals["entryAction$"];
  readonly entryState$: BrowserUserActionSignals["entryState$"];
  readonly invalidateEntry$: BrowserUserActionSignals["invalidateEntry$"];
  readonly clearDraft$: BrowserUserActionSignals["clearDraft$"];
  readonly activeMutation$: State<boolean>;
  readonly deliverCallback$: Command<
    Promise<void>,
    [string, ChatActionCallbackIds, AbortSignal]
  >;
}

function browserSelectSubmissionValue(
  field: BrowserInputAction["fields"][number],
  choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>,
):
  | Extract<
      BrowserUserActionApplyRequest["values"][number],
      { optionIndexes: readonly number[] }
    >
  | null
  | undefined {
  const options = field.control.options;
  const optionSetFingerprint = field.control.optionSetFingerprint;
  if (!options || !optionSetFingerprint) {
    return null;
  }
  const saved = choiceDraft.get(field.key);
  // A fresh preflight may replace the website choices. Ignore a stale draft
  // instead of reusing its indices against the new option set.
  const selection =
    saved?.optionSetFingerprint === optionSetFingerprint
      ? saved.optionIndexes
      : undefined;
  if (selection === undefined) {
    if (!field.required) {
      return field.control.siteRequired &&
        !options.some((option) => {
          return option.selected && !option.disabled && !option.empty;
        })
        ? null
        : undefined;
    }
    const observed = options.filter((option) => {
      return option.selected;
    });
    if (
      observed.length === 0 ||
      observed.some((option) => {
        return option.disabled;
      }) ||
      observed.every((option) => {
        return option.empty;
      })
    ) {
      return null;
    }
    return {
      key: field.key,
      optionIndexes: observed.map((option) => {
        return option.index;
      }),
      optionSetFingerprint,
    };
  }
  if (
    selection.some((index) => {
      return !options[index] || options[index].disabled;
    }) ||
    ((field.required || field.control.siteRequired) &&
      selection.every((index) => {
        return options[index]?.empty;
      }))
  ) {
    return null;
  }
  return {
    key: field.key,
    optionIndexes: [...selection],
    optionSetFingerprint,
  };
}

function browserCheckboxSubmissionValue(
  field: BrowserInputAction["fields"][number],
  checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>,
):
  | Extract<
      BrowserUserActionApplyRequest["values"][number],
      { checked: boolean }
    >
  | null
  | undefined {
  const observedChecked = field.control.checked;
  if (observedChecked === undefined) {
    return null;
  }
  const saved = checkboxDraft.get(field.key);
  const choice = saved?.observedChecked === observedChecked ? saved : undefined;
  if (!choice) {
    if (field.required) {
      return observedChecked
        ? { key: field.key, checked: true, observedChecked }
        : null;
    }
    return field.control.siteRequired && !observedChecked ? null : undefined;
  }
  if ((field.required || field.control.siteRequired) && !choice.checked) {
    return null;
  }
  return { key: field.key, checked: choice.checked, observedChecked };
}

function observedRadioSubmissionValue(
  field: BrowserInputAction["fields"][number],
  options: NonNullable<
    BrowserInputAction["fields"][number]["control"]["radioOptions"]
  >,
  fingerprint: string,
  selectedIndex: number,
):
  | Extract<
      BrowserUserActionApplyRequest["values"][number],
      { memberIndex: number }
    >
  | null
  | undefined {
  if (selectedIndex === -1) {
    return field.required || field.control.siteRequired ? null : undefined;
  }
  if (!field.required) {
    return undefined;
  }
  if (options[selectedIndex]?.disabled) {
    return null;
  }
  return {
    key: field.key,
    memberIndex: selectedIndex,
    observedSelectedIndex: selectedIndex,
    groupFingerprint: fingerprint,
  };
}

function browserRadioSubmissionValue(
  field: BrowserInputAction["fields"][number],
  radioDraft: ReadonlyMap<string, BrowserRadioDraft>,
):
  | Extract<
      BrowserUserActionApplyRequest["values"][number],
      { memberIndex: number }
    >
  | null
  | undefined {
  const options = field.control.radioOptions;
  const fingerprint = field.control.radioGroupFingerprint;
  if (!options || !fingerprint) {
    return null;
  }
  const selectedIndex = options.findIndex((option) => {
    return option.selected;
  });
  const saved = radioDraft.get(field.key);
  const choice =
    saved?.groupFingerprint === fingerprint &&
    saved.observedSelectedIndex === selectedIndex
      ? saved
      : undefined;
  if (!choice) {
    return observedRadioSubmissionValue(
      field,
      options,
      fingerprint,
      selectedIndex,
    );
  }
  if (
    choice.memberIndex >= options.length ||
    (choice.memberIndex >= 0 && options[choice.memberIndex]?.disabled) ||
    (choice.memberIndex === -1 &&
      (field.required ||
        field.control.siteRequired ||
        (selectedIndex !== -1 && options[selectedIndex]?.disabled)))
  ) {
    return null;
  }
  return { key: field.key, ...choice };
}

function validBrowserFileName(name: string): boolean {
  return ![...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 31 || code === 127 || character === "/" || character === "\\"
    );
  });
}

export function fileDraftIsValid(
  field: BrowserInputAction["fields"][number],
  draft: BrowserFileDraft | undefined,
): boolean {
  const fingerprint = field.control.fileSetFingerprint;
  if (
    !fingerprint ||
    !field.control.files ||
    field.control.accept === undefined
  ) {
    return false;
  }
  if (!draft) {
    return field.required
      ? field.control.files.length > 0
      : !field.control.siteRequired || field.control.files.length > 0;
  }
  if (draft.observedFingerprint !== fingerprint) {
    return false;
  }
  if (draft.operation === "keep") {
    return field.control.files.length > 0;
  }
  if (draft.operation === "clear") {
    return !field.required && !field.control.siteRequired;
  }
  return (
    draft.files.length > 0 &&
    draft.files.length <=
      (field.control.multiple ? BROWSER_USER_ACTION_MAX_FILES : 1) &&
    draft.files.reduce((sum, file) => {
      return sum + file.size;
    }, 0) <= BROWSER_USER_ACTION_MAX_FILE_BYTES &&
    draft.files.every((file) => {
      return (
        file.name.length > 0 &&
        file.name.length <= BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH &&
        validBrowserFileName(file.name) &&
        file.type.length <= BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH &&
        !/[^\x20-\x7e]/u.test(file.type)
      );
    })
  );
}

async function browserFileSubmissionValue(
  field: BrowserInputAction["fields"][number],
  draft: BrowserFileDraft | undefined,
  upload: (fieldKey: string, file: File, index: number) => Promise<void>,
): Promise<
  | Extract<BrowserUserActionApplyRequest["values"][number], { files: unknown }>
  | null
  | undefined
> {
  if (!fileDraftIsValid(field, draft)) {
    return null;
  }
  if (!draft) {
    if (!field.required) {
      return undefined;
    }
    const observedFingerprint = field.control.fileSetFingerprint;
    return observedFingerprint
      ? { key: field.key, operation: "keep", observedFingerprint, files: [] }
      : null;
  }
  return {
    key: field.key,
    operation: draft.operation,
    observedFingerprint: draft.observedFingerprint,
    files:
      draft.operation === "replace"
        ? await Promise.all(
            draft.files.map(async (file, index) => {
              await upload(field.key, file, index);
              return { name: file.name, type: file.type, size: file.size };
            }),
          )
        : [],
  };
}

function browserRangeSubmissionValue(
  field: BrowserInputAction["fields"][number],
  rangeDraft: ReadonlyMap<string, BrowserRangeDraft>,
):
  | Extract<
      BrowserUserActionApplyRequest["values"][number],
      { observedValue: string }
    >
  | null
  | undefined {
  const observedValue = field.control.rangeValue;
  if (!observedValue) {
    return null;
  }
  const choice = rangeDraft.get(field.key);
  if (!choice) {
    return field.required || field.control.siteRequired ? null : undefined;
  }
  return choice.observedValue === observedValue &&
    choice.observedMin === field.control.min &&
    choice.observedMax === field.control.max &&
    choice.observedStep === field.control.step &&
    choice.value.length > 0
    ? { key: field.key, ...choice }
    : null;
}

function browserColorSubmissionValue(
  field: BrowserInputAction["fields"][number],
  colorDraft: ReadonlyMap<string, BrowserColorDraft>,
):
  | Extract<
      BrowserUserActionApplyRequest["values"][number],
      { observedColor: string }
    >
  | null
  | undefined {
  const observedColor = field.control.colorValue;
  if (field.control.colorMode !== "opaque-srgb" || !observedColor) {
    return null;
  }
  const choice = colorDraft.get(field.key);
  if (!choice) {
    return field.required || field.control.siteRequired ? null : undefined;
  }
  return choice.observedColor === observedColor &&
    /^#[0-9a-f]{6}$/u.test(choice.value)
    ? { key: field.key, ...choice }
    : null;
}

function browserNativeChoiceSubmissionValue(
  field: BrowserInputAction["fields"][number],
  rangeDraft: ReadonlyMap<string, BrowserRangeDraft>,
  colorDraft: ReadonlyMap<string, BrowserColorDraft>,
) {
  return field.fieldKind === "color"
    ? browserColorSubmissionValue(field, colorDraft)
    : browserRangeSubmissionValue(field, rangeDraft);
}

function browserScalarSubmissionValue(
  field: BrowserInputAction["fields"][number],
  draft: ReadonlyMap<string, string>,
): { key: string; value: string } | null | undefined {
  const value = draft.get(field.key) ?? "";
  if (value === "") {
    if (field.required || field.control.siteRequired) {
      return null;
    }
    if (
      !["number", "date_time"].includes(field.fieldKind) ||
      !draft.has(field.key)
    ) {
      return undefined;
    }
  }
  return { key: field.key, value };
}

async function uploadBrowserInputFile(
  fieldKey: string,
  file: File,
  index: number,
  prepare: (body: BrowserUserActionPrepareFileUploadRequest) => Promise<{
    readonly uploadUrl: string;
  }>,
  signal: AbortSignal,
): Promise<void> {
  const signed = await prepare({ key: fieldKey, index, size: file.size });
  signal.throwIfAborted();
  const uploaded = await fetchResource(
    signed.uploadUrl,
    {
      method: "PUT",
      body: file,
      headers: { "content-type": "application/octet-stream" },
    },
    signal,
  );
  signal.throwIfAborted();
  if (!uploaded.ok) {
    throw new Error("Browser file upload failed");
  }
}

function browserFileUploader(
  clientFactory: ApiClientFactory,
  requestToken: string,
  signal: AbortSignal,
): (fieldKey: string, file: File, index: number) => Promise<void> {
  const client = clientFactory(browserUserActionsContract);
  return (fieldKey, file, index) => {
    return uploadBrowserInputFile(
      fieldKey,
      file,
      index,
      async (body) => {
        const result = await accept(
          client.prepareFileUpload({
            params: { requestToken },
            body,
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        return result.body;
      },
      signal,
    );
  };
}

async function browserInputSubmissionValues(
  action: BrowserInputAction,
  upload: (fieldKey: string, file: File, index: number) => Promise<void>,
  drafts: {
    readonly draft: ReadonlyMap<string, string>;
    readonly choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>;
    readonly checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>;
    readonly radioDraft: ReadonlyMap<string, BrowserRadioDraft>;
    readonly rangeDraft: ReadonlyMap<string, BrowserRangeDraft>;
    readonly colorDraft: ReadonlyMap<string, BrowserColorDraft>;
    readonly fileDraft: ReadonlyMap<string, BrowserFileDraft>;
  },
): Promise<BrowserUserActionApplyRequest["values"] | null> {
  const {
    draft,
    choiceDraft,
    checkboxDraft,
    radioDraft,
    rangeDraft,
    colorDraft,
    fileDraft,
  } = drafts;
  const values: BrowserUserActionApplyRequest["values"][number][] = [];
  for (const field of action.fields) {
    if (field.fieldKind === "color" || field.fieldKind === "range") {
      const choice = browserNativeChoiceSubmissionValue(
        field,
        rangeDraft,
        colorDraft,
      );
      if (choice === null) {
        return null;
      }
      if (choice !== undefined) {
        values.push(choice);
      }
      continue;
    }
    if (field.fieldKind === "file") {
      const file = await browserFileSubmissionValue(
        field,
        fileDraft.get(field.key),
        upload,
      );
      if (file === null) {
        return null;
      }
      if (file !== undefined) {
        values.push(file);
      }
      continue;
    }
    if (field.fieldKind === "radio") {
      const radio = browserRadioSubmissionValue(field, radioDraft);
      if (radio === null) {
        return null;
      }
      if (radio !== undefined) {
        values.push(radio);
      }
      continue;
    }
    if (field.fieldKind === "checkbox") {
      const checkbox = browserCheckboxSubmissionValue(field, checkboxDraft);
      if (checkbox === null) {
        return null;
      }
      if (checkbox !== undefined) {
        values.push(checkbox);
      }
      continue;
    }
    if (field.fieldKind === "select") {
      const selection = browserSelectSubmissionValue(field, choiceDraft);
      if (selection === null) {
        return null;
      }
      if (selection !== undefined) {
        values.push(selection);
      }
      continue;
    }
    const scalar = browserScalarSubmissionValue(field, draft);
    if (scalar === null) {
      return null;
    }
    if (scalar !== undefined) {
      values.push(scalar);
    }
  }
  return values;
}

function isInvalidBrowserInputValueResponse(result: {
  readonly status: number;
  readonly body: unknown;
}): boolean {
  if (
    result.status !== 409 ||
    typeof result.body !== "object" ||
    result.body === null ||
    !("error" in result.body)
  ) {
    return false;
  }
  const error = result.body.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "BROWSER_USER_ACTION_INVALID_VALUE"
  );
}

function entryActionMatches(
  entryAction: BrowserInputAction | null,
  descriptor: BrowserUserActionDescriptor,
): boolean {
  return !entryAction || actionMatches(entryAction, descriptor);
}

function browserInputSubmissionError(error: unknown): Error {
  return error instanceof ApiError
    ? error
    : new Error("Browser file could not be read or uploaded");
}

function createBrowserMutationSignal(
  descriptor: BrowserUserActionDescriptor,
  activeMutation$: State<boolean>,
  recover$: BrowserUserActionSignals["recover$"],
) {
  return command(
    async (
      { get, set },
      mutation:
        | {
            readonly kind: "apply";
            readonly values: BrowserUserActionApplyRequest["values"];
          }
        | { readonly kind: "cancel" },
      signal: AbortSignal,
    ) => {
      const client = get(apiClient$)(browserUserActionsContract);
      const options = {
        params: { requestToken: descriptor.requestToken },
        fetchOptions: { signal },
      };
      const request =
        mutation.kind === "apply"
          ? client.apply({ ...options, body: { values: mutation.values } })
          : client.cancel({ ...options, body: {} });
      return await onRejection(
        accept(request, [200, 403, 404, 409, 410], signal),
        () => {
          signal.throwIfAborted();
          set(recover$);
        },
      ).finally(() => {
        set(activeMutation$, false);
      });
    },
  );
}

function createSubmitSignal({
  descriptor,
  request$,
  refresh$,
  busy$,
  write$,
  draft$,
  choiceDraft$,
  checkboxDraft$,
  radioDraft$,
  rangeDraft$,
  colorDraft$,
  fileDraft$,
  entryAction$,
  entryState$,
  invalidateEntry$,
  clearDraft$,
  activeMutation$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["submit$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (get(busy$)) {
      return;
    }
    const request = await get(request$);
    signal.throwIfAborted();
    if (get(busy$)) {
      return;
    }
    if (
      request.kind !== "action" ||
      request.action.kind !== "input" ||
      request.action.state !== "pending"
    ) {
      return;
    }
    const entryState = get(entryState$);
    if (entryState === "unavailable" || entryState === "invalid") {
      return;
    }
    const entryAction = get(entryAction$);
    if (!entryActionMatches(entryAction, descriptor)) {
      return;
    }
    const action = entryState === "ready" ? entryAction : request.action;
    if (!action || action.state !== "pending") {
      return;
    }
    set(activeMutation$, true);
    signal.addEventListener(
      "abort",
      () => {
        set(activeMutation$, false);
      },
      { once: true },
    );
    const prepared = await settle(
      browserInputSubmissionValues(
        action,
        browserFileUploader(get(apiClient$), descriptor.requestToken, signal),
        {
          draft: get(draft$),
          choiceDraft: get(choiceDraft$),
          checkboxDraft: get(checkboxDraft$),
          radioDraft: get(radioDraft$),
          rangeDraft: get(rangeDraft$),
          colorDraft: get(colorDraft$),
          fileDraft: get(fileDraft$),
        },
      ),
    );
    signal.throwIfAborted();
    if (!prepared.ok) {
      set(activeMutation$, false);
      throw browserInputSubmissionError(prepared.error);
    }
    if (!prepared.value) {
      set(activeMutation$, false);
      return;
    }
    const result = await set(
      write$,
      { kind: "apply", values: prepared.value },
      signal,
    );
    signal.throwIfAborted();
    const status: number = result.status;
    if (isInvalidBrowserInputValueResponse(result)) {
      set(invalidateEntry$);
      return;
    }
    if (status !== 200) {
      set(clearDraft$);
      set(refresh$);
      return;
    }
    if (
      !actionMatches(result.body, descriptor) ||
      result.body.kind !== "input"
    ) {
      set(clearDraft$);
      set(refresh$);
      return;
    }
    if (result.body.state !== "pending") {
      set(clearDraft$);
    }
    if (result.body.state === "succeeded") {
      set(activeMutation$, true);
      await set(
        deliverCallback$,
        descriptor.callbackPrompt,
        result.body.callbackIds.success,
        signal,
      ).finally(() => {
        set(activeMutation$, false);
        if (!signal.aborted) {
          set(refresh$, signal);
        }
      });
      signal.throwIfAborted();
      return;
    }
    set(refresh$);
  });
}

function createCancelSignal({
  descriptor,
  request$,
  refresh$,
  busy$,
  write$,
  clearDraft$,
  activeMutation$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["cancel$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (get(busy$)) {
      return;
    }
    const request = await get(request$);
    signal.throwIfAborted();
    if (get(busy$)) {
      return;
    }
    if (request.kind !== "action" || request.action.state !== "pending") {
      return;
    }
    set(activeMutation$, true);
    const result = await set(write$, { kind: "cancel" }, signal);
    signal.throwIfAborted();
    const status: number = result.status;
    set(clearDraft$);
    if (
      status === 200 &&
      actionMatches(result.body, descriptor) &&
      result.body.kind === request.action.kind &&
      result.body.state === "cancelled"
    ) {
      set(activeMutation$, true);
      await set(
        deliverCallback$,
        BROWSER_INPUT_CANCELLATION_PROMPT,
        result.body.callbackIds.cancellation,
        signal,
      ).finally(() => {
        set(activeMutation$, false);
        if (!signal.aborted) {
          set(refresh$, signal);
        }
      });
      signal.throwIfAborted();
      return;
    }
    set(refresh$);
  });
}

function createContinueSignal({
  descriptor,
  request$,
  refresh$,
  busy$,
  activeMutation$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["continue$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (get(busy$)) {
      return;
    }
    const request = await get(request$);
    signal.throwIfAborted();
    if (get(busy$)) {
      return;
    }
    if (request.kind !== "action") {
      return;
    }
    const callback =
      request.action.state === "succeeded"
        ? {
            prompt: descriptor.callbackPrompt,
            ids: request.action.callbackIds.success,
          }
        : request.action.state === "cancelled"
          ? {
              prompt: BROWSER_INPUT_CANCELLATION_PROMPT,
              ids: request.action.callbackIds.cancellation,
            }
          : null;
    if (!callback) {
      return;
    }
    set(activeMutation$, true);
    await onRejection(
      set(deliverCallback$, callback.prompt, callback.ids, signal),
      () => {
        signal.throwIfAborted();
        set(refresh$, signal);
      },
    ).finally(() => {
      set(activeMutation$, false);
    });
  });
}

function createMutationSignals({
  descriptor,
  request$,
  refresh$,
  recoveryState$,
  recover$,
  draft$,
  choiceDraft$,
  checkboxDraft$,
  radioDraft$,
  rangeDraft$,
  colorDraft$,
  fileDraft$,
  clearDraft$,
  entryAction$,
  entryState$,
  invalidateEntry$,
}: Pick<
  BrowserUserActionMutationContext,
  | "descriptor"
  | "request$"
  | "refresh$"
  | "recover$"
  | "draft$"
  | "choiceDraft$"
  | "checkboxDraft$"
  | "radioDraft$"
  | "rangeDraft$"
  | "colorDraft$"
  | "fileDraft$"
  | "clearDraft$"
  | "entryAction$"
  | "entryState$"
  | "invalidateEntry$"
> &
  Pick<BrowserUserActionSignals, "recoveryState$">): Pick<
  BrowserUserActionSignals,
  | "callbackDelivered$"
  | "callbackFailed$"
  | "busy$"
  | "submit$"
  | "cancel$"
  | "continue$"
> {
  const callbackDeliveredState$ = state(false);
  const callbackFailedState$ = state(false);
  const activeMutation$ = state(false);
  const busy$ = computed((get) => {
    return get(activeMutation$) || get(recoveryState$) !== "idle";
  });
  const write$ = createBrowserMutationSignal(
    descriptor,
    activeMutation$,
    recover$,
  );
  const deliverCallback$ = command(
    async (
      { set },
      callbackPrompt: string,
      callbackIds: ChatActionCallbackIds,
      signal: AbortSignal,
    ): Promise<void> => {
      set(callbackFailedState$, false);
      await onRejection(
        set(
          runChatActionCallback$,
          callbackArgs(descriptor, callbackPrompt, callbackIds),
          signal,
        ),
        () => {
          set(callbackFailedState$, true);
        },
      );
      signal.throwIfAborted();
      set(callbackDeliveredState$, true);
    },
  );
  const context: BrowserUserActionMutationContext = {
    descriptor,
    request$,
    refresh$,
    recover$,
    busy$,
    write$,
    draft$,
    choiceDraft$,
    checkboxDraft$,
    radioDraft$,
    rangeDraft$,
    colorDraft$,
    fileDraft$,
    entryAction$,
    entryState$,
    invalidateEntry$,
    clearDraft$,
    activeMutation$,
    deliverCallback$,
  };

  return {
    callbackDelivered$: computed((get) => {
      return get(callbackDeliveredState$);
    }),
    callbackFailed$: computed((get) => {
      return get(callbackFailedState$);
    }),
    busy$,
    submit$: createSubmitSignal(context),
    cancel$: createCancelSignal(context),
    continue$: createContinueSignal(context),
  };
}

export function createBrowserUserActionSignals(
  descriptor: BrowserUserActionDescriptor,
): BrowserUserActionSignals {
  const requestSignals = createRequestSignals(descriptor);
  const entrySignals = createEntrySignals(descriptor, requestSignals.refresh$);
  const recoverySignals = createRecoverySignals(
    requestSignals.request$,
    requestSignals.refresh$,
    entrySignals.beginEntry$,
  );
  const openDialogCount$ = state(0);
  const pendingReturnRefresh$ = state(false);
  const dialogRef$ = onRef(
    command(({ get, set }, _element: HTMLDivElement, signal: AbortSignal) => {
      set(openDialogCount$, (count) => {
        return count + 1;
      });
      signal.addEventListener(
        "abort",
        () => {
          set(openDialogCount$, (count) => {
            return Math.max(0, count - 1);
          });
          if (get(openDialogCount$) === 0 && get(pendingReturnRefresh$)) {
            set(pendingReturnRefresh$, false);
            set(requestSignals.refresh$);
          }
        },
        { once: true },
      );
    }),
  );
  const resumeRef$ = onRef(
    command(({ get, set }, _element: HTMLDivElement, signal: AbortSignal) => {
      const refresh = () => {
        if (get(recoverySignals.recoveryState$) === "checking") {
          return;
        }
        if (get(recoverySignals.recoveryState$) === "exhausted") {
          set(recoverySignals.recover$);
          return;
        }
        if (get(openDialogCount$) > 0) {
          set(pendingReturnRefresh$, true);
          return;
        }
        set(requestSignals.refresh$);
      };
      window.addEventListener("focus", refresh, { signal });
      document.addEventListener(
        "visibilitychange",
        () => {
          if (document.visibilityState === "visible") {
            refresh();
          }
        },
        { signal },
      );
    }),
  );
  const standaloneEntrySignals = createStandaloneEntrySignals(
    requestSignals.request$,
    requestSignals.refresh$,
    entrySignals.beginEntry$,
  );
  const draftSignals = createDraftSignals();
  const mutationSignals = createMutationSignals({
    descriptor,
    request$: requestSignals.request$,
    refresh$: requestSignals.refresh$,
    recoveryState$: recoverySignals.recoveryState$,
    recover$: recoverySignals.recover$,
    draft$: draftSignals.draft$,
    choiceDraft$: draftSignals.choiceDraft$,
    checkboxDraft$: draftSignals.checkboxDraft$,
    radioDraft$: draftSignals.radioDraft$,
    rangeDraft$: draftSignals.rangeDraft$,
    colorDraft$: draftSignals.colorDraft$,
    fileDraft$: draftSignals.fileDraft$,
    clearDraft$: draftSignals.clearDraft$,
    entryAction$: entrySignals.entryAction$,
    entryState$: entrySignals.entryState$,
    invalidateEntry$: entrySignals.invalidateEntry$,
  });
  return {
    ...descriptor,
    ...requestSignals,
    ...recoverySignals,
    resumeRef$,
    dialogRef$,
    ...entrySignals,
    ...standaloneEntrySignals,
    ...draftSignals,
    ...mutationSignals,
  };
}

export function createBrowserUserActionCardSignalsRegistry(): BrowserUserActionCardSignalsRegistry {
  return createCardSignalsRegistry(
    browserUserActionResourceKey,
    createBrowserUserActionSignals,
  );
}
