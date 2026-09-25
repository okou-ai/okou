import {
  BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  browserUserActionsContract,
  type BrowserUserActionApplyRequest,
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
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRef, onRejection, resetSignal, settle } from "../utils.ts";
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

export interface BrowserUserActionSignals extends BrowserUserActionDescriptor {
  readonly request$: Computed<Promise<BrowserUserActionRequestState>>;
  readonly draft$: Computed<ReadonlyMap<string, string>>;
  readonly choiceDraft$: Computed<
    ReadonlyMap<string, BrowserSelectChoiceDraft>
  >;
  readonly checkboxDraft$: Computed<ReadonlyMap<string, BrowserCheckboxDraft>>;
  readonly radioDraft$: Computed<ReadonlyMap<string, BrowserRadioDraft>>;
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
  readonly refresh$: Command<void, []>;
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
      set(refresh$);
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

function createRequestSignals(descriptor: BrowserUserActionDescriptor) {
  const reload$ = state(0);
  const request$ = computed(
    async (get): Promise<BrowserUserActionRequestState> => {
      get(reload$);
      if (get(featureSwitch$)[FeatureSwitchKey.BrowserNativeInput] !== true) {
        return { kind: "unavailable" };
      }
      const result = await accept(
        get(apiClient$)(browserUserActionsContract).get({
          params: { requestToken: descriptor.requestToken },
        }),
        [200, 403, 404, 409, 410],
      );
      const status: number = result.status;
      if (status === 410) {
        return { kind: "expired" };
      }
      if (status !== 200 || !actionMatches(result.body, descriptor)) {
        return { kind: "unavailable" };
      }
      return { kind: "action", action: result.body };
    },
  );
  const refresh$ = command(({ set }) => {
    set(reload$, (version) => {
      return version + 1;
    });
  });
  return { request$, refresh$ };
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

function createDraftSignals(): Pick<
  BrowserUserActionSignals,
  | "draft$"
  | "choiceDraft$"
  | "checkboxDraft$"
  | "radioDraft$"
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
> {
  const internalDraft$ = state<ReadonlyMap<string, string>>(new Map());
  const selectSignals = createSelectDraftSignals();
  const checkboxSignals = createCheckboxDraftSignals();
  const radioSignals = createRadioDraftSignals();
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
  readonly draft$: BrowserUserActionSignals["draft$"];
  readonly choiceDraft$: BrowserUserActionSignals["choiceDraft$"];
  readonly checkboxDraft$: BrowserUserActionSignals["checkboxDraft$"];
  readonly radioDraft$: BrowserUserActionSignals["radioDraft$"];
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
  const choice = choiceDraft.get(field.key);
  if (choice && choice.optionSetFingerprint !== optionSetFingerprint) {
    return null;
  }
  const selection = choice?.optionIndexes;
  if (selection === undefined) {
    return field.required ||
      (field.control.siteRequired &&
        !options.some((option) => {
          return option.selected && !option.disabled && !option.empty;
        }))
      ? null
      : undefined;
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
  const choice = checkboxDraft.get(field.key);
  if (choice && choice.observedChecked !== observedChecked) {
    return null;
  }
  if (!choice) {
    return field.required || (field.control.siteRequired && !observedChecked)
      ? null
      : undefined;
  }
  if ((field.required || field.control.siteRequired) && !choice.checked) {
    return null;
  }
  return { key: field.key, checked: choice.checked, observedChecked };
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
  const choice = radioDraft.get(field.key);
  if (
    choice &&
    (choice.groupFingerprint !== fingerprint ||
      choice.observedSelectedIndex !== selectedIndex)
  ) {
    return null;
  }
  if (!choice) {
    return field.required ||
      (field.control.siteRequired && selectedIndex === -1)
      ? null
      : undefined;
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

function browserInputSubmissionValues(
  action: BrowserInputAction,
  draft: ReadonlyMap<string, string>,
  choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>,
  checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>,
  radioDraft: ReadonlyMap<string, BrowserRadioDraft>,
): BrowserUserActionApplyRequest["values"] | null {
  const values: BrowserUserActionApplyRequest["values"][number][] = [];
  for (const field of action.fields) {
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
    const value = draft.get(field.key) ?? "";
    if (value === "") {
      if (field.required || field.control.siteRequired) {
        return null;
      }
      if (
        !["number", "date_time"].includes(field.fieldKind) ||
        !draft.has(field.key)
      ) {
        continue;
      }
    }
    values.push({ key: field.key, value });
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

function createSubmitSignal({
  descriptor,
  request$,
  refresh$,
  draft$,
  choiceDraft$,
  checkboxDraft$,
  radioDraft$,
  entryAction$,
  entryState$,
  invalidateEntry$,
  clearDraft$,
  activeMutation$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["submit$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (get(activeMutation$)) {
      return;
    }
    const request = await get(request$);
    signal.throwIfAborted();
    if (get(activeMutation$)) {
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
    if (entryAction && !actionMatches(entryAction, descriptor)) {
      return;
    }
    const action = entryState === "ready" ? entryAction : request.action;
    if (!action || action.state !== "pending") {
      return;
    }
    const values = browserInputSubmissionValues(
      action,
      get(draft$),
      get(choiceDraft$),
      get(checkboxDraft$),
      get(radioDraft$),
    );
    if (!values) {
      return;
    }

    set(activeMutation$, true);
    const result = await accept(
      get(apiClient$)(browserUserActionsContract).apply({
        params: { requestToken: descriptor.requestToken },
        body: { values },
        fetchOptions: { signal },
      }),
      [200, 403, 404, 409, 410],
      signal,
    ).finally(() => {
      set(activeMutation$, false);
    });
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
        set(refresh$);
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
  clearDraft$,
  activeMutation$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["cancel$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (get(activeMutation$)) {
      return;
    }
    const request = await get(request$);
    signal.throwIfAborted();
    if (get(activeMutation$)) {
      return;
    }
    if (request.kind !== "action" || request.action.state !== "pending") {
      return;
    }
    set(activeMutation$, true);
    const result = await accept(
      get(apiClient$)(browserUserActionsContract).cancel({
        params: { requestToken: descriptor.requestToken },
        body: {},
        fetchOptions: { signal },
      }),
      [200, 403, 404, 409, 410],
      signal,
    ).finally(() => {
      set(activeMutation$, false);
    });
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
        set(refresh$);
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
  activeMutation$,
  deliverCallback$,
}: BrowserUserActionMutationContext): BrowserUserActionSignals["continue$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (get(activeMutation$)) {
      return;
    }
    const request = await get(request$);
    signal.throwIfAborted();
    if (get(activeMutation$)) {
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
        set(refresh$);
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
  draft$,
  choiceDraft$,
  checkboxDraft$,
  radioDraft$,
  clearDraft$,
  entryAction$,
  entryState$,
  invalidateEntry$,
}: Pick<
  BrowserUserActionMutationContext,
  | "descriptor"
  | "request$"
  | "refresh$"
  | "draft$"
  | "choiceDraft$"
  | "checkboxDraft$"
  | "radioDraft$"
  | "clearDraft$"
  | "entryAction$"
  | "entryState$"
  | "invalidateEntry$"
>): Pick<
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
    draft$,
    choiceDraft$,
    checkboxDraft$,
    radioDraft$,
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
    busy$: computed((get) => {
      return get(activeMutation$);
    }),
    submit$: createSubmitSignal(context),
    cancel$: createCancelSignal(context),
    continue$: createContinueSignal(context),
  };
}

export function createBrowserUserActionSignals(
  descriptor: BrowserUserActionDescriptor,
): BrowserUserActionSignals {
  const requestSignals = createRequestSignals(descriptor);
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
  const entrySignals = createEntrySignals(descriptor, requestSignals.refresh$);
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
    draft$: draftSignals.draft$,
    choiceDraft$: draftSignals.choiceDraft$,
    checkboxDraft$: draftSignals.checkboxDraft$,
    radioDraft$: draftSignals.radioDraft$,
    clearDraft$: draftSignals.clearDraft$,
    entryAction$: entrySignals.entryAction$,
    entryState$: entrySignals.entryState$,
    invalidateEntry$: entrySignals.invalidateEntry$,
  });
  return {
    ...descriptor,
    ...requestSignals,
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
