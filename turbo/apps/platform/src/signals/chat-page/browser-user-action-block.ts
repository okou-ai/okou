import {
  BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_BYTES,
  BROWSER_USER_ACTION_MAX_FILES,
  BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH,
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
} from "@okouai/api-contracts/validators/browser-user-actions";
import { browserUserActionsContract } from "@okouai/api-contracts/client/browser-user-actions";
import type {
  BrowserUserActionApplyRequest,
  BrowserUserActionPrepareFileUploadRequest,
  BrowserUserActionResponse,
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
import { setAblyLoop$ } from "../realtime.ts";
import { onRef, settle } from "../utils.ts";
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
  /**
   * The website check for a pending input form, or null when the website
   * cannot take this input. Evaluated only while a pending form reads it.
   */
  readonly entry$: Computed<Promise<BrowserInputEntry>>;
  readonly refreshEntry$: Command<void, []>;
  readonly subscribe$: Command<void, [AbortSignal]>;
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
  readonly formRef$: Command<
    (() => void) | undefined,
    [HTMLFormElement | null]
  >;
  readonly submit$: Command<Promise<void>, [BrowserInputAction, AbortSignal]>;
  readonly cancel$: Command<Promise<void>, [AbortSignal]>;
}

export type BrowserInputEntry =
  | { readonly kind: "ready"; readonly action: BrowserInputAction }
  | { readonly kind: "unavailable" }
  /** The website refused submitted values; only a fresh check can recover. */
  | { readonly kind: "rejected" };

async function preflightBrowserUserAction(
  client: ApiClientFactory,
  descriptor: BrowserUserActionDescriptor,
): Promise<BrowserInputEntry> {
  const checked = await accept(
    client(browserUserActionsContract).preflight({
      params: { requestToken: descriptor.requestToken },
      body: {},
    }),
    [200, 403, 404, 409, 410, 502, 503],
  );
  return checked.status === 200 &&
    actionMatches(checked.body, descriptor) &&
    checked.body.kind === "input" &&
    checked.body.state === "pending"
    ? { kind: "ready", action: checked.body }
    : { kind: "unavailable" };
}

function createEntrySignals(descriptor: BrowserUserActionDescriptor): Pick<
  BrowserUserActionSignals,
  "entry$" | "refreshEntry$"
> & {
  readonly rejectEntry$: Command<void, []>;
} {
  // Opening the form asks for a fresh check; thread notifications
  // re-read the request without touching the website.
  const check$ = state({ revision: 0, rejected: false });
  const entry$ = computed(async (get): Promise<BrowserInputEntry> => {
    const { rejected } = get(check$);
    const client = get(apiClient$);
    return rejected
      ? { kind: "rejected" }
      : await preflightBrowserUserAction(client, descriptor);
  });
  const refreshEntry$ = command(({ set }) => {
    set(check$, ({ revision }) => {
      return { revision: revision + 1, rejected: false };
    });
  });
  const rejectEntry$ = command(({ set }) => {
    set(check$, ({ revision }) => {
      return { revision, rejected: true };
    });
  });
  return { entry$, refreshEntry$, rejectEntry$ };
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
  if (result.status === 410) {
    return { kind: "expired" };
  }
  if (result.status !== 200 || !actionMatches(result.body, descriptor)) {
    return { kind: "unavailable" };
  }
  return { kind: "action", action: result.body };
}

function createRequestSignals(descriptor: BrowserUserActionDescriptor) {
  const revision$ = state(0);
  const request$ = computed(
    async (get): Promise<BrowserUserActionRequestState> => {
      get(revision$);
      if (get(featureSwitch$)[FeatureSwitchKey.BrowserNativeInput] !== true) {
        return { kind: "unavailable" };
      }
      return await readBrowserUserAction(get(apiClient$), descriptor);
    },
  );
  const refresh$ = command(({ set }) => {
    set(revision$, (revision) => {
      return revision + 1;
    });
  });
  return { request$, refresh$ };
}

function createSubscriptionSignals(
  threadId: string,
  refresh$: ReturnType<typeof createRequestSignals>["refresh$"],
) {
  const invalidate$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  // Re-read on subscribe: cached cards may have missed changes while unowned.
  const subscribe$ = command(({ set }, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      {
        topic: `browserUserActionChanged:${threadId}`,
        loopCommand$: invalidate$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  });
  return { subscribe$ };
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
      const sensitiveKeys = [...form.elements].flatMap((element) => {
        return element instanceof HTMLInputElement &&
          (element.type === "password" ||
            element.autocomplete === "one-time-code") &&
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
              set(clearDraftKeys$, sensitiveKeys);
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
  readonly write$: ReturnType<typeof createBrowserMutationSignal>;
  readonly draft$: BrowserUserActionSignals["draft$"];
  readonly choiceDraft$: BrowserUserActionSignals["choiceDraft$"];
  readonly checkboxDraft$: BrowserUserActionSignals["checkboxDraft$"];
  readonly radioDraft$: BrowserUserActionSignals["radioDraft$"];
  readonly rangeDraft$: BrowserUserActionSignals["rangeDraft$"];
  readonly colorDraft$: BrowserUserActionSignals["colorDraft$"];
  readonly fileDraft$: BrowserUserActionSignals["fileDraft$"];
  readonly rejectEntry$: Command<void, []>;
  readonly clearDraft$: BrowserUserActionSignals["clearDraft$"];
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

function browserInputSubmissionError(error: unknown): Error {
  return error instanceof ApiError
    ? error
    : new Error("Browser file could not be read or uploaded");
}

function createBrowserMutationSignal(descriptor: BrowserUserActionDescriptor) {
  return command(
    async (
      { get },
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
      return await accept(request, [200, 403, 404, 409, 410], signal);
    },
  );
}

function createSubmitSignal({
  descriptor,
  request$,
  write$,
  draft$,
  choiceDraft$,
  checkboxDraft$,
  radioDraft$,
  rangeDraft$,
  colorDraft$,
  fileDraft$,
  rejectEntry$,
  clearDraft$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["submit$"] {
  // The form submits the action it shows: the checked one, or the requested
  // one while a check of a form without native inputs is still pending.
  const submit$ = command(
    async (
      { get, set },
      action: BrowserInputAction,
      signal: AbortSignal,
    ): Promise<void> => {
      const request = await get(request$);
      signal.throwIfAborted();
      if (
        request.kind !== "action" ||
        request.action.kind !== "input" ||
        request.action.state !== "pending" ||
        action.state !== "pending" ||
        !actionMatches(action, descriptor)
      ) {
        return;
      }
      // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
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
        throw browserInputSubmissionError(prepared.error);
      }
      if (!prepared.value) {
        return;
      }
      const result = await set(
        write$,
        { kind: "apply", values: prepared.value },
        signal,
      );
      signal.throwIfAborted();
      if (isInvalidBrowserInputValueResponse(result)) {
        set(rejectEntry$);
        return;
      }
      if (
        result.status !== 200 ||
        !actionMatches(result.body, descriptor) ||
        result.body.kind !== "input"
      ) {
        set(clearDraft$);
        return;
      }
      if (result.body.state !== "pending") {
        set(clearDraft$);
      }
      if (result.body.state === "succeeded") {
        await set(
          deliverCallback$,
          descriptor.callbackPrompt,
          result.body.callbackIds.success,
          signal,
        );
        signal.throwIfAborted();
      }
    },
  );
  return submit$;
}

function createCancelSignal({
  descriptor,
  request$,
  write$,
  clearDraft$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["cancel$"] {
  const cancel$ = command(async ({ get, set }, signal: AbortSignal) => {
    const request = await get(request$);
    signal.throwIfAborted();
    if (request.kind !== "action" || request.action.state !== "pending") {
      return;
    }
    const result = await set(write$, { kind: "cancel" }, signal);
    signal.throwIfAborted();
    set(clearDraft$);
    if (
      result.status === 200 &&
      actionMatches(result.body, descriptor) &&
      result.body.kind === request.action.kind &&
      result.body.state === "cancelled"
    ) {
      await set(
        deliverCallback$,
        BROWSER_INPUT_CANCELLATION_PROMPT,
        result.body.callbackIds.cancellation,
        signal,
      );
      signal.throwIfAborted();
    }
  });
  return cancel$;
}

function createMutationSignals({
  descriptor,
  request$,
  draft$,
  choiceDraft$,
  checkboxDraft$,
  radioDraft$,
  rangeDraft$,
  colorDraft$,
  fileDraft$,
  clearDraft$,
  rejectEntry$,
}: Pick<
  BrowserUserActionMutationContext,
  | "descriptor"
  | "request$"
  | "draft$"
  | "choiceDraft$"
  | "checkboxDraft$"
  | "radioDraft$"
  | "rangeDraft$"
  | "colorDraft$"
  | "fileDraft$"
  | "clearDraft$"
  | "rejectEntry$"
>): Pick<BrowserUserActionSignals, "submit$" | "cancel$"> {
  const write$ = createBrowserMutationSignal(descriptor);
  const deliverCallback$ = command(
    async (
      { set },
      callbackPrompt: string,
      callbackIds: ChatActionCallbackIds,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(
        runChatActionCallback$,
        callbackArgs(descriptor, callbackPrompt, callbackIds),
        signal,
      );
      signal.throwIfAborted();
    },
  );
  const context: BrowserUserActionMutationContext = {
    descriptor,
    request$,
    write$,
    draft$,
    choiceDraft$,
    checkboxDraft$,
    radioDraft$,
    rangeDraft$,
    colorDraft$,
    fileDraft$,
    rejectEntry$,
    clearDraft$,
    deliverCallback$,
  };

  return {
    submit$: createSubmitSignal(context),
    cancel$: createCancelSignal(context),
  };
}

export function createBrowserUserActionSignals(
  descriptor: BrowserUserActionDescriptor,
): BrowserUserActionSignals {
  const requestSignals = createRequestSignals(descriptor);
  const subscriptionSignals = createSubscriptionSignals(
    descriptor.threadId,
    requestSignals.refresh$,
  );
  const { rejectEntry$, ...entrySignals } = createEntrySignals(descriptor);
  const draftSignals = createDraftSignals();
  const mutationSignals = createMutationSignals({
    descriptor,
    request$: requestSignals.request$,
    draft$: draftSignals.draft$,
    choiceDraft$: draftSignals.choiceDraft$,
    checkboxDraft$: draftSignals.checkboxDraft$,
    radioDraft$: draftSignals.radioDraft$,
    rangeDraft$: draftSignals.rangeDraft$,
    colorDraft$: draftSignals.colorDraft$,
    fileDraft$: draftSignals.fileDraft$,
    clearDraft$: draftSignals.clearDraft$,
    rejectEntry$,
  });
  return {
    ...descriptor,
    request$: requestSignals.request$,
    ...subscriptionSignals,
    ...entrySignals,
    ...draftSignals,
    ...mutationSignals,
  };
}

export function createBrowserUserActionCardSignalsRegistry(): BrowserUserActionCardSignalsRegistry {
  return createCardSignalsRegistry(
    browserUserActionResourceKey,
    createBrowserUserActionSignals,
    (signals) => {
      return signals.subscribe$;
    },
  );
}
