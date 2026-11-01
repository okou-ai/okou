import { command, state, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import type { CdpClient } from "../cdp/client.ts";
import type { InputLifecycle, InputOwner } from "./lifecycle.ts";
import type { InputJob, InputQueue } from "./queue.ts";
import type { Point } from "../display/geometry.ts";
import { isRecord } from "../cdp/errors.ts";
import type { EditingObservation } from "./port.ts";

// Retain DOM identity in the remote world, never in a page global or field value.
const captureEditing = `/* okou-browser editing */ (() => {
  let previous = [], revision = 0;
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
      kind = element.disabled || element.readOnly ? 'inactive'
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
  // Opaque frames/hosts retain outer focus identity, not inner-field identity.
  return { read: observe, valid: (expected) => {
    const current = observe(false);
    return current.revision === expected && current.kind !== 'inactive';
  } };
})()`;

export interface EditingTarget {
  readonly objectId: string;
  readonly revision: number;
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
): { caret: Point | null; editing: EditingObservation } | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  ) {
    return null;
  }
  const target = { objectId, revision: Number(value.revision) };
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

function createEditingValidator(queue: InputQueue) {
  return command(
    async (
      { set },
      job: InputJob,
      target: EditingTarget,
      signal: AbortSignal,
    ) => {
      const result = await set(
        queue.callFunction$,
        job,
        editingTargetValidation(target),
      );
      signal.throwIfAborted();
      if (result.exceptionDetails || typeof result.result.value !== "boolean") {
        throw new Error("Editing target validation unavailable");
      }
      return result.result.value;
    },
  );
}

/** One remote probe per original document; composition retains its exact lease. */
export function createEditingReader(
  client: CdpClient,
  sessionId: string,
  queue: InputQueue,
  lifecycle: InputLifecycle,
  frameId$: Computed<string | null>,
) {
  const probe$ = state<{
    readonly document: InputOwner["document"];
    readonly createdBy: InputOwner;
    readonly token: object;
    readonly result: Promise<string>;
    readonly objectId?: string;
  } | null>(null);
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
      const world = await set(queue.createWorld$, job, {
        frameId,
        worldName: "okou-browser-editing",
      });
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
        client.notify("Runtime.releaseObject", { objectId }, sessionId);
        throw new Error("Editing observation retired");
      }
      retained = true;
      set(probe$, { ...current, objectId });
      return objectId;
    },
  );
  const reset$ = command(({ get, set }) => {
    const probe = get(probe$);
    set(probe$, null);
    // Pending creations release their handle when their token is no longer current.
    if (probe?.objectId) {
      client.notify(
        "Runtime.releaseObject",
        { objectId: probe.objectId },
        sessionId,
      );
    }
  });
  const read$ = command(
    async ({ get, set }, job: InputJob, signal: AbortSignal) => {
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
        const result = set(create$, job, token, signal);
        probe = {
          document: job.owner.document,
          createdBy: job.owner,
          token,
          result,
        };
        set(probe$, probe);
      }
      let acquired = false;
      using _read = {
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
      // Optional observations borrow the document probe used by live compositions.
      acquired = true;
      const result = await set(queue.callFunction$, job, {
        objectId,
        functionDeclaration: "function() { return this.read(); }",
        returnByValue: true,
      });
      signal.throwIfAborted();
      if (result.exceptionDetails) {
        throw new Error("Editing observation unavailable");
      }
      return editingObservation(objectId, result.result.value as unknown);
    },
  );
  return { read$, valid$: createEditingValidator(queue), reset$ };
}
