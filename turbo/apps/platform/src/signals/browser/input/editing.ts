import { command, state, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import type { CdpClient, CdpEvent } from "../cdp/client.ts";
import type { InputLifecycle, InputOwner } from "./lifecycle.ts";
import type { InputJob, InputQueue } from "./queue.ts";
import type { Point } from "../display/geometry.ts";
import { isRecord } from "../cdp/errors.ts";
import type { EditingObservation } from "./port.ts";

const editingBinding = "__okouEditingChanged";

// Retain DOM identity in the remote world, never in a page global or field value.
const captureEditing = `/* okou-browser editing */ (() => {
  let previous = [], revision = 0;
  let watch = null;
  const stop = (id) => {
    if (!watch || (id && watch.id !== id)) return;
    for (const root of watch.roots) {
      root.removeEventListener('focusin', watch.changed, true);
      root.removeEventListener('focusout', watch.changed, true);
      root.removeEventListener('pagehide', watch.changed, true);
      root.defaultView?.removeEventListener('pagehide', watch.changed, true);
    }
    watch.observer.disconnect();
    watch = null;
  };
  const observe = (metadata = true) => {
    const chain = [];
    let doc = document, ox = 0, oy = 0, element, kind = 'unknown';
    for (let depth = 0; depth < 16; depth++) {
      let root = doc;
      element = root.activeElement;
      chain.push(root, element);
      while (element?.shadowRoot?.activeElement) {
        root = element.shadowRoot; element = root.activeElement;
        chain.push(root, element);
      }
      if (!element) { kind = 'inactive'; break; }
      if (['iframe','frame'].includes(element.localName)) {
        let inner;
        try { inner = element.contentDocument; } catch {}
        if (!inner) break;
        if (metadata) {
          const rect = element.getBoundingClientRect();
          ox += rect.left + element.clientLeft; oy += rect.top + element.clientTop;
        }
        doc = inner; continue;
      }
      kind = element.matches(':disabled') || element.readOnly ? 'inactive'
        : element.isContentEditable || element.localName === 'textarea' ||
          (element.localName === 'input' && ['text','search','email','url','tel','password','number'].includes(element.type))
          ? 'editable'
          : ['canvas'].includes(element.localName) || element.localName.includes('-') ? 'unknown' : 'inactive';
      break;
    }
    const type = element?.localName === 'input' ? element.type : element?.localName;
    chain.push(kind, type);
    if (chain.length !== previous.length || chain.some((value, index) => value !== previous[index])) {
      revision++; previous = chain;
    }
    if (kind !== 'editable' || !metadata) return { kind, revision };
    const rect = element.getBoundingClientRect();
    let x = rect.left + 4, y = rect.top + Math.min(rect.height, 20);
    const selection = doc.getSelection();
    if (element.isContentEditable && selection?.rangeCount && element.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0).cloneRange(); range.collapse(false);
      const caret = range.getBoundingClientRect();
      if (caret.height) { x = caret.left; y = caret.bottom; }
    }
    let languageRoot = element, lang = '';
    while (languageRoot) {
      const source = languageRoot.closest('[lang]');
      if (source) { lang = source.getAttribute('lang'); break; }
      const root = languageRoot.getRootNode();
      languageRoot = root instanceof doc.defaultView.ShadowRoot ? root.host : null;
    }
    const viewport = window.visualViewport;
    return { kind, revision, x: x + ox, y: y + oy,
      width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
      offsetX: viewport?.offsetLeft ?? 0, offsetY: viewport?.offsetTop ?? 0,
      editing: { type, multiline: element.localName === 'textarea' || element.isContentEditable,
        inputMode: element.inputMode, enterKeyHint: element.enterKeyHint,
        autoCapitalize: element.autocapitalize || element.form?.autocapitalize || '', lang } };
  };
  const begin = (id) => {
    stop();
    const value = observe();
    if (value.kind === 'inactive') return value;
    const roots = previous.filter(node => node?.nodeType === 9 || node?.nodeType === 11);
    const revoke = () => {
      if (watch?.id !== id) return;
      // Focus-away-and-back must not revive an old composition.
      revision++;
      stop(id);
      globalThis.__okouEditingChanged(id);
    };
    const observer = new MutationObserver(records => {
      const eligibility = records.some(record => record.type === 'attributes' &&
        previous.some(node => node?.nodeType === 1 && (record.target === node ||
          (record.attributeName === 'contenteditable' && record.target.contains(node)))));
      const current = observe(false);
      if (eligibility || current.revision !== value.revision || current.kind === 'inactive') revoke();
    });
    watch = { id, roots, changed: revoke, observer };
    for (const root of roots) {
      root.addEventListener('focusin', revoke, true);
      root.addEventListener('focusout', revoke, true);
      root.addEventListener('pagehide', revoke, true);
      root.defaultView?.addEventListener('pagehide', revoke, true);
      observer.observe(root, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['type','disabled','readonly','contenteditable'] });
    }
    return value;
  };
  // Opaque frames/hosts retain outer focus identity, not inner-field identity.
  return { read: observe, begin, stop, dispose: () => stop(), valid: (expected) => {
    const current = observe(false);
    return current.revision === expected && current.kind !== 'inactive';
  } };
})()`;

export interface EditingTarget {
  readonly objectId: string;
  readonly revision: number;
  readonly watchId?: string;
}

// This checks current focus; the subsequent CDP Input write is a separate request.
export function editingTargetValidation(
  target: EditingTarget,
): Protocol.Runtime.CallFunctionOnRequest {
  return {
    objectId: target.objectId,
    functionDeclaration: "function(revision) { return this.valid(revision); }",
    arguments: [{ value: target.revision }],
    returnByValue: true,
  };
}

function caretPoint(value: Record<string, unknown>): Point | null {
  const { x, y, width, height, offsetX, offsetY } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    width <= 0 ||
    typeof height !== "number" ||
    height <= 0 ||
    typeof offsetX !== "number" ||
    typeof offsetY !== "number" ||
    ![x, y, width, height, offsetX, offsetY].every(Number.isFinite)
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(1, (x - offsetX) / width)),
    y: Math.max(0, Math.min(1, (y - offsetY) / height)),
  };
}

function editingObservation(
  objectId: string,
  value: unknown,
  watchId?: string,
): { caret: Point | null; editing: EditingObservation } | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  ) {
    return null;
  }
  const target = { objectId, revision: Number(value.revision), watchId };
  if (value.kind === "inactive" || value.kind === "unknown") {
    return { caret: null, editing: { kind: value.kind, target } };
  }
  const context = value.editing;
  if (
    value.kind !== "editable" ||
    !isRecord(context) ||
    typeof context.type !== "string" ||
    typeof context.multiline !== "boolean" ||
    typeof context.inputMode !== "string" ||
    typeof context.enterKeyHint !== "string" ||
    typeof context.autoCapitalize !== "string" ||
    typeof context.lang !== "string"
  ) {
    return null;
  }
  const caret = caretPoint(value);
  if (!caret) {
    return null;
  }
  return {
    caret,
    editing: {
      kind: "editable",
      target,
      context: {
        type: context.type,
        multiline: context.multiline,
        inputMode: context.inputMode,
        enterKeyHint: context.enterKeyHint,
        autoCapitalize: context.autoCapitalize,
        lang: context.lang,
      },
    },
  };
}

interface EditingProbe {
  readonly document: InputOwner["document"];
  readonly createdBy: InputOwner;
  readonly token: object;
  readonly result: Promise<string>;
  readonly objectId?: string;
  readonly contextId?: number;
}

interface EditingWatch {
  readonly id: string;
  readonly objectId: string;
  readonly contextId: number;
  readonly revision: number | null;
}

function createEditingState(
  client: CdpClient,
  sessionId: string,
  queue: InputQueue,
  lifecycle: InputLifecycle,
  frameId$: Computed<string | null>,
) {
  return {
    client,
    sessionId,
    queue,
    lifecycle,
    frameId$,
    probe$: state<EditingProbe | null>(null),
    watch$: state<EditingWatch | null>(null),
  };
}
type EditingState = ReturnType<typeof createEditingState>;

function createEditingWatch(graph: EditingState) {
  const { client, sessionId, probe$, watch$ } = graph;
  const stop$ = command(({ get, set }, target?: EditingTarget) => {
    const watch = get(watch$);
    if (!watch || (target && watch.id !== target.watchId)) {
      return;
    }
    set(watch$, null);
    client.notify(
      "Runtime.callFunctionOn",
      {
        objectId: watch.objectId,
        functionDeclaration: "function(id) { this.stop(id); }",
        arguments: [{ value: watch.id }],
        returnByValue: true,
      },
      sessionId,
    );
  });
  const prepare$ = command(
    ({ get, set }, objectId: string, watchId: string | null) => {
      const previous = get(watch$);
      if (watchId) {
        const probe = get(probe$);
        if (probe?.objectId !== objectId || probe.contextId === undefined) {
          throw new Error("Editing context unavailable");
        }
        set(stop$);
        set(watch$, {
          id: watchId,
          objectId,
          contextId: probe.contextId,
          revision: null,
        });
      }
      return previous;
    },
  );
  const reconcile$ = command(
    (
      { get, set },
      observation: ReturnType<typeof editingObservation>,
      objectId: string,
      watchId: string | null,
      previous: EditingWatch | null,
    ) => {
      const watch = get(watch$);
      if (watchId) {
        // A revocation can arrive before the begin response; never revive it.
        if (watch?.id !== watchId) {
          return;
        }
        if (!observation || observation.editing.kind === "inactive") {
          set(stop$);
        } else {
          set(watch$, {
            ...watch,
            revision: observation.editing.target?.revision ?? null,
          });
        }
      } else if (
        watch &&
        watch === previous &&
        watch.objectId === objectId &&
        observation &&
        observation.editing.target?.revision !== watch.revision
      ) {
        set(stop$);
      }
    },
  );
  const valid$ = command(({ get }, target: EditingTarget) => {
    const watch = get(watch$);
    return (
      !!watch &&
      watch.id === target.watchId &&
      watch.objectId === target.objectId &&
      watch.revision === target.revision
    );
  });
  return { stop$, prepare$, reconcile$, valid$ };
}
type EditingOwnership = EditingState & ReturnType<typeof createEditingWatch>;

function createEditingProbe(graph: EditingOwnership) {
  const { client, sessionId, queue, frameId$, probe$, stop$ } = graph;
  const release = (objectId: string) => {
    client.notify(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: "function() { this.dispose(); }",
        returnByValue: true,
      },
      sessionId,
    );
    client.notify("Runtime.releaseObject", { objectId }, sessionId);
  };
  const create$ = command(
    async ({ get, set }, job: InputJob, token: object, signal: AbortSignal) => {
      let retained = false;
      using _creation = {
        [Symbol.dispose]: () => {
          if (!retained && get(probe$)?.token === token) {
            set(probe$, null);
          }
        },
      };
      const frameId = get(frameId$);
      if (!frameId) {
        throw new Error("Editing document unavailable");
      }
      // Binding registration by world name and world creation are independent.
      const [world] = await Promise.all([
        set(queue.createWorld$, job, {
          frameId,
          worldName: "okou-browser-editing",
        }),
        set(queue.addBinding$, job, {
          name: editingBinding,
          executionContextName: "okou-browser-editing",
        }),
      ]);
      signal.throwIfAborted();
      const result = await set(queue.evaluate$, job, {
        contextId: world.executionContextId,
        expression: captureEditing,
        returnByValue: false,
      });
      signal.throwIfAborted();
      if (result.exceptionDetails || !result.result.objectId) {
        throw new Error("Editing observation unavailable");
      }
      const objectId = result.result.objectId;
      const current = get(probe$);
      if (!current || current.token !== token) {
        release(objectId);
        throw new Error("Editing observation retired");
      }
      retained = true;
      set(probe$, {
        ...current,
        objectId,
        contextId: world.executionContextId,
      });
      return objectId;
    },
  );
  const reset$ = command(({ get, set }) => {
    const probe = get(probe$);
    set(stop$);
    set(probe$, null);
    // Pending creations release their handle when their token is no longer current.
    if (probe?.objectId) {
      release(probe.objectId);
    }
  });
  return { create$, reset$ };
}
type EditingGraph = EditingOwnership & ReturnType<typeof createEditingProbe>;

function createEditingAcquisition(graph: EditingGraph) {
  const { probe$, lifecycle, create$, reset$ } = graph;
  return command(async ({ get, set }, job: InputJob, signal: AbortSignal) => {
    let probe = get(probe$);
    if (
      probe &&
      (probe.document !== job.owner.document ||
        (!probe.objectId && probe.createdBy !== job.owner))
    ) {
      set(reset$);
      probe = null;
    }
    if (!probe) {
      const token = Object.freeze({});
      probe = {
        document: job.owner.document,
        createdBy: job.owner,
        token,
        result: set(create$, job, token, signal),
      };
      set(probe$, probe);
    }
    let acquired = false;
    using _acquisition = {
      [Symbol.dispose]: () => {
        if (
          !acquired &&
          get(probe$)?.token === probe.token &&
          set(lifecycle.owns$, job.owner)
        ) {
          set(reset$);
        }
      },
    };
    const objectId = await probe.result;
    signal.throwIfAborted();
    if (
      !set(lifecycle.owns$, job.owner) ||
      get(probe$)?.objectId !== objectId
    ) {
      throw new Error("Editing observation retired");
    }
    // Optional observations borrow the probe; their failures must not release it.
    acquired = true;
    return objectId;
  });
}

function createEditingObservation(graph: EditingGraph) {
  const acquire$ = createEditingAcquisition(graph);
  const { queue, lifecycle, prepare$, reconcile$ } = graph;
  const observe$ = command(
    async (
      { set },
      job: InputJob,
      watchId: string | null,
      signal: AbortSignal,
    ) => {
      const objectId = await set(acquire$, job, signal);
      signal.throwIfAborted();
      if (!set(lifecycle.owns$, job.owner)) {
        throw new Error("Editing observation retired");
      }
      const previous = set(prepare$, objectId, watchId);
      const result = await set(queue.callFunction$, job, {
        objectId,
        functionDeclaration: watchId
          ? "function(id) { return this.begin(id); }"
          : "function() { return this.read(); }",
        ...(watchId ? { arguments: [{ value: watchId }] } : {}),
        returnByValue: true,
      });
      signal.throwIfAborted();
      if (result.exceptionDetails) {
        throw new Error("Editing observation unavailable");
      }
      const observation = editingObservation(
        objectId,
        result.result.value as unknown,
        watchId ?? undefined,
      );
      set(reconcile$, observation, objectId, watchId, previous);
      return observation;
    },
  );
  const read$ = command(({ set }, job: InputJob, signal: AbortSignal) => {
    return set(observe$, job, null, signal);
  });
  const begin$ = command(({ set }, job: InputJob, signal: AbortSignal) => {
    return set(observe$, job, crypto.randomUUID(), signal);
  });
  return { read$, begin$ };
}

function createEditingEvents(graph: EditingGraph) {
  const { sessionId, probe$, watch$, reset$ } = graph;
  return command(({ get, set }, event: CdpEvent) => {
    if (event.sessionId !== sessionId) {
      return;
    }
    if (
      event.method === "Runtime.executionContextsCleared" ||
      (event.method === "Runtime.executionContextDestroyed" &&
        event.params.executionContextId === get(probe$)?.contextId)
    ) {
      set(reset$);
      return;
    }
    const watch = get(watch$);
    if (
      watch &&
      event.method === "Runtime.bindingCalled" &&
      event.params.name === editingBinding &&
      event.params.executionContextId === watch.contextId &&
      event.params.payload === watch.id
    ) {
      set(watch$, null);
    }
  });
}

/** One remote probe per original document; composition retains its exact lease. */
export function createEditingReader(
  client: CdpClient,
  sessionId: string,
  queue: InputQueue,
  lifecycle: InputLifecycle,
  frameId$: Computed<string | null>,
) {
  const values = createEditingState(
    client,
    sessionId,
    queue,
    lifecycle,
    frameId$,
  );
  const ownership = { ...values, ...createEditingWatch(values) };
  const graph = { ...ownership, ...createEditingProbe(ownership) };
  return {
    ...createEditingObservation(graph),
    valid$: graph.valid$,
    stop$: graph.stop$,
    reset$: graph.reset$,
    event$: createEditingEvents(graph),
  };
}
