import { command, computed, state, type Computed } from "ccstate";
import type { ViewerNavigation, NavigationReceipt } from "../viewer/types.ts";
import type { ViewerIntent } from "../viewer/lifecycle.ts";

interface AddressSubmission {
  readonly targetId: string | null;
  readonly selection: object;
  readonly scope: object;
  readonly value: string;
  readonly baseline: ViewerNavigation | null;
}
interface SubmittedAddress {
  readonly token: AddressSubmission;
  readonly receipt: NavigationReceipt | null;
}
interface AddressEditor {
  readonly kind: "creation" | "focus" | "input";
  readonly targetId: string | null;
  readonly creation: object | null;
  readonly value: string;
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

type AddressTarget =
  | { readonly kind: "target"; readonly id: string }
  | { readonly kind: "unselected" | "detached" };

function createAddressState(sources: AddressSources) {
  const { selectedTabId$, navigation$, navigationScope$ } = sources;
  const editorState$ = state<AddressEditor | null>(null);
  const submissionState$ = state<SubmittedAddress | null>(null);
  const targetState$ = state<AddressTarget>({ kind: "unselected" });
  const pendingAddress$ = computed((get) => {
    const submitted = get(submissionState$);
    if (!submitted) {
      return null;
    }
    const document = get(navigation$);
    const reattached =
      document &&
      submitted.token.targetId === get(selectedTabId$) &&
      submitted.token.scope !== get(navigationScope$);
    const confirmed =
      submitted.receipt &&
      submitted.token.scope === get(navigationScope$) &&
      confirmsSubmission(document, submitted.token, submitted.receipt);
    return confirmed || reattached ? null : submitted.token;
  });
  const editTargetId$ = computed((get) => {
    const editor = get(editorState$);
    if (editor) {
      return editor.targetId;
    }
    const pending = get(pendingAddress$);
    if (pending) {
      return pending.targetId;
    }
    const target = get(targetState$);
    return target.kind === "target" ? target.id : null;
  });
  const address$ = computed((get) => {
    const editor = get(editorState$);
    if (editor) {
      return editor.value;
    }
    const pending = get(pendingAddress$);
    if (pending) {
      return pending.value;
    }
    const remote = get(navigation$)?.url ?? "";
    return remote === "about:blank" ? "" : remote;
  });
  const addressTargetMatches$ = computed((get) => {
    const target = get(selectedTabId$);
    return (
      target !== null &&
      !get(editorState$)?.creation &&
      get(editTargetId$) === target
    );
  });
  return {
    ...sources,
    editorState$,
    submissionState$,
    targetState$,
    editTargetId$,
    address$,
    addressTargetMatches$,
  };
}
type AddressGraph = ReturnType<typeof createAddressState>;

function createTargetActions(graph: AddressGraph) {
  const { editorState$, submissionState$, targetState$, address$ } = graph;
  const observeAddressTarget$ = command(({ get, set }, targetId: string) => {
    const previous = get(targetState$);
    const editor = get(editorState$);
    // Only initial discovery can adopt an edit without an established target.
    if (
      previous.kind === "unselected" &&
      editor &&
      !editor.creation &&
      editor.targetId === null
    ) {
      set(editorState$, { ...editor, targetId });
    }
    set(targetState$, { kind: "target", id: targetId });
  });
  const selectAddress$ = command(({ get, set }, targetId: string) => {
    set(targetState$, { kind: "target", id: targetId });
    const editor = get(editorState$);
    if (editor && (editor.creation || editor.targetId !== targetId)) {
      set(editorState$, null);
    }
    if (get(submissionState$)?.token.targetId !== targetId) {
      set(submissionState$, null);
    }
  });
  const detachAddress$ = command(({ get, set }) => {
    const retained = get(editorState$) || get(submissionState$);
    const value = get(address$);
    set(targetState$, { kind: "detached" });
    set(submissionState$, null);
    if (retained) {
      set(editorState$, {
        kind: "input",
        targetId: null,
        creation: null,
        value,
      });
    }
  });
  return { observeAddressTarget$, selectAddress$, detachAddress$ };
}

function createCreationActions(
  graph: AddressGraph,
  detachAddress$: ReturnType<typeof createTargetActions>["detachAddress$"],
) {
  const { editorState$, submissionState$ } = graph;
  const beginAddressCreation$ = command(({ set }, creation: object) => {
    set(submissionState$, null);
    set(editorState$, {
      kind: "creation",
      targetId: null,
      creation,
      value: "",
    });
  });
  const adoptAddressCreation$ = command(
    ({ get, set }, creation: object, targetId: string) => {
      const editor = get(editorState$);
      if (editor?.creation === creation) {
        set(
          editorState$,
          editor.kind === "creation"
            ? null
            : { ...editor, targetId, creation: null },
        );
      }
    },
  );
  const cancelAddressCreation$ = command(({ get, set }, creation: object) => {
    const editor = get(editorState$);
    if (editor?.creation === creation) {
      if (editor.kind === "input") {
        set(detachAddress$);
      } else {
        set(editorState$, null);
      }
    }
  });
  return {
    beginAddressCreation$,
    adoptAddressCreation$,
    cancelAddressCreation$,
  };
}

function createEditorActions(
  graph: AddressGraph,
  beginAddressCreation$: ReturnType<
    typeof createCreationActions
  >["beginAddressCreation$"],
) {
  const {
    editorState$,
    submissionState$,
    targetState$,
    editTargetId$,
    address$,
  } = graph;
  const beginAddressEdit$ = command(
    ({ get, set }, origin: "focus" | "interaction") => {
      const editor = get(editorState$);
      if (editor) {
        // Automatic New tab focus is passive; a subsequent gesture owns editing.
        if (editor.kind === "creation" && origin === "interaction") {
          set(editorState$, { ...editor, kind: "focus" });
        }
        return;
      }
      set(editorState$, {
        kind: "focus",
        targetId: get(editTargetId$),
        creation: null,
        value: get(address$),
      });
    },
  );
  const blurAddress$ = command(({ get, set }) => {
    const editor = get(editorState$);
    if (editor?.kind === "focus") {
      set(
        editorState$,
        editor.creation ? { ...editor, kind: "creation" } : null,
      );
    }
  });
  const editAddress$ = command(({ get, set }, value: string) => {
    const editor = get(editorState$);
    set(editorState$, {
      kind: "input",
      targetId: get(editTargetId$),
      creation: editor?.creation ?? null,
      value,
    });
  });
  const resetAddress$ = command(({ get, set }) => {
    const editor = get(editorState$);
    if (editor?.creation) {
      set(beginAddressCreation$, editor.creation);
    } else {
      set(editorState$, null);
      set(submissionState$, null);
      const target = get(graph.selectedTabId$);
      set(
        targetState$,
        target ? { kind: "target", id: target } : { kind: "unselected" },
      );
    }
  });
  return { beginAddressEdit$, blurAddress$, editAddress$, resetAddress$ };
}

function createSubmissionActions(graph: AddressGraph) {
  const {
    editorState$,
    submissionState$,
    intent$,
    navigation$,
    navigationScope$,
  } = graph;
  const prepareAddress$ = command(
    ({ get, set }, scope: object): AddressSubmission => {
      const token: AddressSubmission = Object.freeze({
        targetId: get(graph.editTargetId$),
        selection: get(intent$).selection,
        scope,
        value: get(graph.address$),
        baseline: get(navigation$),
      });
      set(submissionState$, { token, receipt: null });
      set(editorState$, null);
      return token;
    },
  );
  const acceptAddress$ = command(
    ({ get, set }, token: AddressSubmission, receipt: NavigationReceipt) => {
      if (
        get(submissionState$)?.token !== token ||
        get(intent$).selection !== token.selection ||
        get(navigationScope$) !== token.scope
      ) {
        return;
      }
      set(
        submissionState$,
        receipt.kind === "download" ||
          receipt.kind === "unavailable" ||
          confirmsSubmission(get(navigation$), token, receipt)
          ? null
          : { token, receipt },
      );
    },
  );
  const reconcileAddress$ = command(({ get, set }, scope: object) => {
    const submitted = get(submissionState$);
    if (
      submitted?.receipt &&
      submitted.token.scope === scope &&
      get(navigationScope$) === scope &&
      submitted.token.selection === get(intent$).selection &&
      confirmsSubmission(get(navigation$), submitted.token, submitted.receipt)
    ) {
      set(submissionState$, null);
    }
  });
  return { prepareAddress$, acceptAddress$, reconcileAddress$ };
}

/** Local interaction and submitted native effects have independent lifetimes. */
export function createAddressSignals(sources: AddressSources) {
  const graph = createAddressState(sources);
  const targets = createTargetActions(graph);
  const creation = createCreationActions(graph, targets.detachAddress$);
  return {
    address$: graph.address$,
    addressTargetMatches$: graph.addressTargetMatches$,
    ...targets,
    ...creation,
    ...createEditorActions(graph, creation.beginAddressCreation$),
    ...createSubmissionActions(graph),
  };
}
