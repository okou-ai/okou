import { command, computed, state, type Computed } from "ccstate";
import type { ViewerNavigation, NavigationReceipt } from "../viewer/types.ts";
import type { ViewerIntent } from "../viewer/lifecycle.ts";

interface AddressSubmission {
  readonly selection: object;
  readonly scope: object;
  readonly version: object;
  readonly value: string;
  readonly baseline: ViewerNavigation | null;
}
interface AddressDraft {
  readonly targetId: string | null;
  readonly creation: object | null;
  readonly version: object;
  readonly value: string;
  readonly dirty: boolean;
  readonly baseline: ViewerNavigation | null;
  readonly submission?: {
    readonly token: AddressSubmission;
    readonly receipt: NavigationReceipt | null;
  };
}

function confirmsSubmission(
  document: ViewerNavigation | null,
  submission: AddressSubmission,
  receipt: NavigationReceipt,
): boolean {
  return (
    !!document &&
    document !== submission.baseline &&
    receipt.kind === "ack" &&
    (receipt.frameId === undefined || document.frameId === receipt.frameId) &&
    (receipt.loaderId === undefined || document.loaderId === receipt.loaderId)
  );
}

interface AddressSources {
  readonly intent$: Computed<ViewerIntent>;
  readonly selectedTabId$: Computed<string | null>;
  readonly navigation$: Computed<ViewerNavigation | null>;
  readonly navigationScope$: Computed<object | null>;
}

function createAddressState(sources: AddressSources) {
  const { selectedTabId$, navigation$, navigationScope$ } = sources;
  const draftState$ = state<AddressDraft | null>(null);
  const address$ = computed((get) => {
    const draft = get(draftState$);
    const document = get(navigation$);
    const remote = document?.url ?? "";
    if (draft) {
      const submitted = draft.submission;
      const reattached =
        submitted &&
        document &&
        draft.targetId === get(selectedTabId$) &&
        submitted.token.scope !== get(navigationScope$);
      const confirmed =
        submitted?.receipt &&
        submitted.token.scope === get(navigationScope$) &&
        confirmsSubmission(document, submitted.token, submitted.receipt);
      if (
        draft.creation ||
        (draft.dirty && !submitted) ||
        (submitted ? !confirmed && !reattached : draft.baseline === document)
      ) {
        return draft.value;
      }
    }
    return remote === "about:blank" ? "" : remote;
  });
  const addressTargetMatches$ = computed((get) => {
    const draft = get(draftState$);
    const target = get(selectedTabId$);
    return (
      target !== null &&
      (!draft || (!draft.creation && draft.targetId === target))
    );
  });
  return { ...sources, draftState$, address$, addressTargetMatches$ };
}
type AddressGraph = ReturnType<typeof createAddressState>;

function createDraftActions(graph: AddressGraph) {
  const { draftState$, selectedTabId$, navigation$, address$ } = graph;
  const selectAddress$ = command(({ get, set }, targetId: string) => {
    const draft = get(draftState$);
    if (draft && (draft.creation || draft.targetId !== targetId)) {
      set(draftState$, null);
    }
  });
  const detachAddress$ = command(({ get, set }) => {
    const draft = get(draftState$);
    if (draft) {
      set(draftState$, {
        ...draft,
        targetId: null,
        creation: null,
        dirty: true,
        submission: undefined,
      });
    }
  });
  const beginAddressCreation$ = command(({ set }, creation: object) => {
    set(draftState$, {
      targetId: null,
      creation,
      version: {},
      value: "",
      dirty: false,
      baseline: null,
    });
  });
  const adoptAddressCreation$ = command(
    ({ get, set }, creation: object, targetId: string) => {
      const draft = get(draftState$);
      if (draft?.creation === creation) {
        set(draftState$, { ...draft, targetId, creation: null });
      }
    },
  );
  const cancelAddressCreation$ = command(({ get, set }, creation: object) => {
    const draft = get(draftState$);
    if (draft?.creation === creation) {
      set(draftState$, draft.dirty ? { ...draft, creation: null } : null);
    }
  });
  const resetAddress$ = command(({ get, set }) => {
    const draft = get(draftState$);
    if (draft?.creation) {
      set(beginAddressCreation$, draft.creation);
    } else {
      set(draftState$, null);
    }
  });
  const editAddress$ = command(({ get, set }, value: string) => {
    const draft = get(draftState$);
    set(draftState$, {
      targetId: draft ? draft.targetId : get(selectedTabId$),
      creation: draft?.creation ?? null,
      version: {},
      value,
      dirty: true,
      baseline: get(navigation$),
    });
  });
  const focusAddress$ = command(({ get, set }) => {
    const draft = get(draftState$);
    if (draft && (draft.dirty || draft.creation || draft.submission)) {
      return;
    }
    set(draftState$, {
      targetId: get(selectedTabId$),
      creation: null,
      version: {},
      value: get(address$),
      dirty: false,
      baseline: get(navigation$),
    });
  });
  return {
    selectAddress$,
    detachAddress$,
    beginAddressCreation$,
    adoptAddressCreation$,
    cancelAddressCreation$,
    resetAddress$,
    editAddress$,
    focusAddress$,
  };
}

function createSubmissionActions(graph: AddressGraph) {
  const {
    draftState$,
    intent$,
    selectedTabId$,
    navigation$,
    navigationScope$,
    address$,
  } = graph;
  const prepareAddress$ = command(
    ({ get, set }, scope: object): AddressSubmission => {
      const token: AddressSubmission = Object.freeze({
        selection: get(intent$).selection,
        scope,
        version: {},
        value: get(address$),
        baseline: get(navigation$),
      });
      set(draftState$, {
        targetId: get(selectedTabId$),
        creation: null,
        version: token.version,
        value: token.value,
        dirty: true,
        baseline: token.baseline,
        submission: { token, receipt: null },
      });
      return token;
    },
  );
  const acceptAddress$ = command(
    ({ get, set }, token: AddressSubmission, receipt: NavigationReceipt) => {
      const draft = get(draftState$);
      if (
        !draft ||
        draft.version !== token.version ||
        get(intent$).selection !== token.selection ||
        get(navigationScope$) !== token.scope
      ) {
        return;
      }
      if (
        receipt.kind === "download" ||
        receipt.kind === "unavailable" ||
        confirmsSubmission(get(navigation$), token, receipt)
      ) {
        set(draftState$, null);
      } else {
        set(draftState$, { ...draft, submission: { token, receipt } });
      }
    },
  );
  const reconcileAddress$ = command(({ get, set }, scope: object) => {
    const draft = get(draftState$);
    const submission = draft?.submission;
    if (
      draft &&
      submission?.receipt &&
      submission.token.scope === scope &&
      get(navigationScope$) === scope &&
      submission.token.selection === get(intent$).selection &&
      draft.version === submission.token.version &&
      confirmsSubmission(get(navigation$), submission.token, submission.receipt)
    ) {
      set(draftState$, null);
    }
  });
  return { prepareAddress$, acceptAddress$, reconcileAddress$ };
}

/** One mounted local editor survives remote resource replacement without granting authority. */
export function createAddressSignals(sources: AddressSources) {
  const graph = createAddressState(sources);
  return {
    address$: graph.address$,
    addressTargetMatches$: graph.addressTargetMatches$,
    ...createDraftActions(graph),
    ...createSubmissionActions(graph),
  };
}
