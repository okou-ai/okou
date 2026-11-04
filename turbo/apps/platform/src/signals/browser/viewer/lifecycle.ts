/** Desired viewer lifetime; native resources and cleanup evidence have their own owners. */
export interface ViewerIntent {
  readonly paused: boolean;
  readonly targetId: string | null;
  /** Explicit choice identity survives observations such as the selected target closing. */
  readonly selection: object;
}

export type IntentEvent =
  | { readonly type: "pause"; readonly paused: boolean }
  | {
      readonly type: "select";
      readonly targetId: string;
      readonly paused: boolean;
    }
  | {
      readonly type:
        "reset" | "target-lost" | "discovery-failed" | "invalidate";
    };

export function initialIntent(): ViewerIntent {
  return Object.freeze({ paused: false, targetId: null, selection: {} });
}

/** Identity orders intent, including deliberate same-target selection, before effects run. */
export function transitionIntent(
  intent: ViewerIntent,
  event: IntentEvent,
): ViewerIntent {
  switch (event.type) {
    case "pause": {
      return intent.paused === event.paused
        ? intent
        : Object.freeze({ ...intent, paused: event.paused });
    }
    case "select": {
      return Object.freeze({
        paused: event.paused,
        targetId: event.targetId,
        selection: {},
      });
    }
    case "reset":
    case "target-lost":
    case "discovery-failed": {
      return Object.freeze({ ...intent, targetId: null });
    }
    case "invalidate": {
      return Object.freeze({ ...intent });
    }
  }
}
