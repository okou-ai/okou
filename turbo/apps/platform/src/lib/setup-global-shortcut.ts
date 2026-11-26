import { matchShortcut, isEditableTarget } from "@okouai/ui";
import { onDomEventFn } from "../signals/utils.ts";

type GlobalShortcutCallback = (e: KeyboardEvent) => void | Promise<void>;

export interface GlobalShortcutBinding {
  readonly allowInEditableTarget?: boolean;
  readonly shouldHandle?: (e: KeyboardEvent) => boolean;
  readonly run: GlobalShortcutCallback;
}

export type GlobalShortcutBindings = Record<string, GlobalShortcutBinding>;

interface GlobalShortcutSetupOptions {
  readonly doc?: Document;
  /** Bubble when a focused control must get first use of this key. */
  readonly capture?: boolean;
  readonly shouldHandleEvent?: (e: KeyboardEvent) => boolean;
}

function hasOpenDialog(doc: Document): boolean {
  return doc.querySelector('[role="dialog"]') !== null;
}

/**
 * Attach keyboard shortcuts to `document` with automatic cleanup via AbortSignal.
 *
 * Callbacks are wrapped with `onDomEventFn` so they can be async (fire-and-forget
 * with proper abort-error handling). Text-entry targets are ignored by default;
 * individual bindings can opt in with `allowInEditableTarget`. Handlers capture
 * by default. Bubble-phase handlers yield to controls that consume the key.
 */
export function setupGlobalShortcut(
  bindings: GlobalShortcutBindings,
  signal: AbortSignal,
  options: GlobalShortcutSetupOptions = {},
): () => void {
  const doc = options.doc ?? document;
  const onKeyDown = onDomEventFn((e: KeyboardEvent) => {
    if (
      e.defaultPrevented ||
      // The embedded browser owns its keyboard, including shortcuts that
      // the host normally handles inside editable controls.
      e.composedPath().some((node) => {
        return (
          node instanceof HTMLElement &&
          node.dataset.browserSessionCdpViewer !== undefined
        );
      }) ||
      hasOpenDialog(doc) ||
      options.shouldHandleEvent?.(e) === false
    ) {
      return;
    }
    for (const [shortcut, binding] of Object.entries(bindings)) {
      if (matchShortcut(shortcut, e)) {
        if (binding.shouldHandle?.(e) === false) {
          continue;
        }
        if (isEditableTarget(e.target) && !binding.allowInEditableTarget) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        return binding.run(e);
      }
    }
  });
  const capture = options.capture ?? true;
  doc.addEventListener("keydown", onKeyDown, { capture, signal });
  return () => {
    doc.removeEventListener("keydown", onKeyDown, capture);
  };
}
