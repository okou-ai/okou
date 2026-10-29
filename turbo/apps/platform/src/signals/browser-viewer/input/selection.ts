import { isRecord } from "../cdp/errors.ts";
import type { InputJob } from "./queue.ts";

export const clipboardTextLimit = 64 * 1024;
export type SelectionResult = {
  status: "ok" | "empty" | "unsupported" | "stale" | "too-large";
  text: string;
};

// A retained isolated-world object binds the read to the actual focused chain.
// Return text only after a second request validates that snapshot. Never inspect
// the remote system clipboard or grant universal frame access.
const captureSelection = `/* okou-browser selection */ (() => {
  const chain = [];
  let doc = document, root = doc, element;
  for (let depth = 0; depth < 16; depth++) {
    element = root.activeElement;
    chain.push({ root, element, doc });
    if (!element) break;
    if (element.shadowRoot) { root = element.shadowRoot; continue; }
    if (['iframe', 'frame'].includes(element.localName)) {
      let child;
      try { child = element.contentDocument; } catch {}
      if (!child) return { read: () => ({ status: 'unsupported', text: '' }) };
      doc = child; root = child; continue;
    }
    break;
  }
  const valid = () => chain.every((entry) =>
    entry.root.activeElement === entry.element &&
    (!entry.element || entry.element.isConnected) &&
    (entry.root === document || entry.root.nodeType !== 9 ||
      entry.doc.defaultView?.frameElement?.contentDocument === entry.doc));
  let status = 'empty', text = '', unchanged = () => true;
  if (chain.length >= 16 || !element ||
      ['iframe','frame','canvas'].includes(element.localName) ||
      (element.localName.includes('-') && !element.shadowRoot)) status = 'unsupported';
  else if (['input', 'textarea'].includes(element.localName)) {
    if (element.localName === 'input' &&
        !['text','search','url','tel'].includes(element.type)) status = 'unsupported';
    else if (typeof element.selectionStart !== 'number' ||
             typeof element.selectionEnd !== 'number') status = 'unsupported';
    else {
      const value = element.value, type = element.type, start = element.selectionStart, end = element.selectionEnd;
      if (end - start > ${clipboardTextLimit}) status = 'too-large';
      else { text = value.slice(start, end); status = text ? 'ok' : 'empty'; }
      unchanged = () => element.type === type && element.value === value && element.selectionStart === start && element.selectionEnd === end;
    }
  } else {
    const selection = root.getSelection?.() ?? doc.getSelection();
    // A focused opaque/non-editing host may own a closed shadow selection.
    // Do not substitute a retained document range for that focused surface.
    if (!['body','html'].includes(element.localName) && !element.isContentEditable) status = 'unsupported';
    else if (selection?.rangeCount) {
      const range = selection.getRangeAt(0).cloneRange();
      // Range text is bounded before it crosses the protocol boundary.
      text = selection.toString();
      status = text.length > ${clipboardTextLimit} ? 'too-large' : text ? 'ok' : 'empty';
      unchanged = () => selection.rangeCount === 1 &&
        selection.anchorNode?.isConnected && selection.focusNode?.isConnected &&
        selection.getRangeAt(0).startContainer === range.startContainer &&
        selection.getRangeAt(0).endContainer === range.endContainer &&
        selection.getRangeAt(0).startOffset === range.startOffset &&
        selection.getRangeAt(0).endOffset === range.endOffset && selection.toString() === text;
    }
  }
  return { read: () => valid() && unchanged()
    ? { status, text: status === 'ok' ? text : '' }
    : { status: 'stale', text: '' } };
})()`;

export async function readSelection(
  job: InputJob,
  frameId: string,
  current: () => boolean,
  release: (objectId: string) => void,
): Promise<SelectionResult> {
  const check = () => {
    if (!current()) {
      throw new Error("Selection cancelled");
    }
  };
  check();
  const world = await job.request("Page.createIsolatedWorld", {
    frameId,
    worldName: "okou-browser-clipboard",
  });
  check();
  const snapshot = await job.request("Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: captureSelection,
    returnByValue: false,
  });
  // The queue already released all handles on an exceptional result.
  if (snapshot.exceptionDetails) {
    throw new Error("Selection unavailable");
  }
  const objectId = snapshot.result.objectId;
  const [completion1] = await Promise.allSettled([
    (async (): Promise<SelectionResult> => {
      check();
      if (!objectId) {
        throw new Error("Selection unavailable");
      }
      const result = await job.request("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { return this.read(); }",
        returnByValue: true,
      });
      check();
      const value: unknown = result.result.value;
      if (
        result.exceptionDetails ||
        !isRecord(value) ||
        !["ok", "empty", "unsupported", "stale", "too-large"].includes(
          String(value.status),
        ) ||
        typeof value.text !== "string" ||
        value.text.length > clipboardTextLimit
      ) {
        throw new Error("Selection unavailable");
      }
      return {
        status: value.status as SelectionResult["status"],
        text: value.text,
      };
    })(),
  ]);

  if (objectId) {
    release(objectId);
  }

  if (completion1.status === "rejected") {
    throw completion1.reason;
  }
  return completion1.value;
}
