import { positive, type DisplaySize } from "./geometry.ts";

import type { WindowSizeSync } from "../viewer/types.ts";

type Request = { readonly source: "manual" | "automatic" };
interface Selection {
  readonly owner: object;
  readonly completed: boolean;
}

export interface DisplayIntent extends Request {
  readonly owner: object;
  readonly mode: WindowSizeSync;
  readonly revision: number;
}

export type DisplayStage =
  "preparing" | "prepared" | "writing" | "presenting" | "recovering";
type Execution =
  | { readonly kind: "idle" | "failed" | "closed" }
  | { readonly kind: DisplayStage; readonly intent: DisplayIntent };

export interface DisplayPolicy {
  readonly suspended: boolean;
  readonly mode: WindowSizeSync;
  readonly local: DisplaySize | null;
  readonly selection: Selection | null;
  readonly pending: Request | null;
  readonly execution: Execution;
  readonly revision: number;
  readonly initial: ReadonlyMap<number, number>;
}

export type DisplayDecision =
  | { readonly kind: "fit"; readonly size: DisplaySize }
  | { readonly kind: "restore-density"; readonly dpr: number };

export type DisplayOutcome =
  | {
      readonly kind: "completed";
      readonly proof: "reused" | "painted";
      readonly windowId: number;
      readonly dpr: number;
    }
  | { readonly kind: "deferred" | "retired" | "failed" };

export type DisplayEvent =
  | { readonly type: "suspend"; readonly value: boolean }
  | { readonly type: "select"; readonly owner: object | null }
  | { readonly type: "mode"; readonly mode: WindowSizeSync }
  | { readonly type: "measure"; readonly size: DisplaySize | null }
  | { readonly type: "manual" | "cancel-manual" | "begin" | "close" }
  | { readonly type: "prepared"; readonly intent: DisplayIntent }
  | {
      readonly type: "stage";
      readonly intent: DisplayIntent;
      readonly stage: Exclude<DisplayStage, "preparing" | "prepared">;
    }
  | {
      readonly type: "finished";
      readonly intent: DisplayIntent;
      readonly outcome: DisplayOutcome;
    };

export function createDisplayPolicy(): DisplayPolicy {
  return {
    suspended: false,
    mode: "off",
    local: null,
    selection: null,
    pending: null,
    execution: { kind: "idle" },
    revision: 0,
    initial: new Map<number, number>(),
  };
}

export function activeDisplayIntent(
  policy: DisplayPolicy,
): DisplayIntent | null {
  return "intent" in policy.execution ? policy.execution.intent : null;
}

export function canBeginDisplay(
  policy: DisplayPolicy,
): policy is DisplayPolicy & {
  readonly local: DisplaySize;
  readonly selection: Selection;
  readonly pending: Request;
} {
  return (
    !policy.suspended &&
    policy.execution.kind === "idle" &&
    !!policy.local &&
    !!policy.selection &&
    !!policy.pending
  );
}

function currentPreparation(
  policy: DisplayPolicy,
  intent: DisplayIntent,
): boolean {
  return (
    !policy.suspended &&
    policy.execution.kind === "preparing" &&
    activeDisplayIntent(policy) === intent &&
    policy.selection?.owner === intent.owner &&
    policy.revision === intent.revision
  );
}

/** A native executor asks for current policy facts, never a session cache. */
export function decideDisplay(
  policy: DisplayPolicy,
  intent: DisplayIntent,
  windowId: number,
): DisplayDecision | null {
  if (!currentPreparation(policy, intent) || !policy.local) {
    return null;
  }
  const dpr = policy.initial.get(windowId);
  return intent.mode === "initial" &&
    intent.source === "automatic" &&
    dpr !== undefined
    ? { kind: "restore-density", dpr }
    : { kind: "fit", size: policy.local };
}

/** Pure semantic transitions; native geometry and resource lifetimes live elsewhere. */
export function transitionDisplay(
  policy: DisplayPolicy,
  event: DisplayEvent,
): DisplayPolicy {
  if (policy.execution.kind === "closed") {
    return policy;
  }
  switch (event.type) {
    case "suspend": {
      return suspendDisplay(policy, event);
    }
    case "close": {
      return { ...createDisplayPolicy(), execution: { kind: "closed" } };
    }
    case "select": {
      return selectDisplay(policy, event);
    }
    case "mode": {
      return changeDisplayMode(policy, event);
    }
    case "measure": {
      return measureDisplay(policy, event);
    }
    case "cancel-manual": {
      return cancelManualDisplay(policy);
    }
    case "manual": {
      if (!policy.local || !policy.selection) {
        return policy;
      }
      return {
        ...policy,
        pending: { source: "manual" },
        execution:
          policy.execution.kind === "failed"
            ? { kind: "idle" }
            : policy.execution,
        revision: policy.revision + 1,
      };
    }
    case "begin": {
      if (!canBeginDisplay(policy)) {
        return policy;
      }
      return {
        ...policy,
        pending: null,
        execution: {
          kind: "preparing",
          intent: {
            source: policy.pending.source,
            owner: policy.selection.owner,
            mode: policy.mode,
            revision: policy.revision,
          },
        },
      };
    }
    case "prepared": {
      return currentPreparation(policy, event.intent) && policy.local
        ? {
            ...policy,
            pending: null,
            execution: { kind: "prepared", intent: event.intent },
          }
        : policy;
    }
    case "stage": {
      return stageDisplay(policy, event);
    }
    case "finished": {
      return finishDisplay(policy, event);
    }
  }
}

function cancelManualDisplay(policy: DisplayPolicy): DisplayPolicy {
  const manual = activeDisplayIntent(policy)?.source === "manual";
  if (policy.pending?.source !== "manual" && !manual) {
    return policy;
  }
  // Cancellation retires only manual intent. Automatic policy remains
  // owner-lived, including repair of an interrupted native write.
  const automatic =
    policy.selection &&
    policy.mode !== "off" &&
    (policy.mode === "live" ||
      !policy.selection.completed ||
      (manual &&
        ["writing", "presenting", "recovering"].includes(
          policy.execution.kind,
        )));
  return {
    ...policy,
    pending:
      policy.pending?.source === "automatic"
        ? policy.pending
        : automatic
          ? { source: "automatic" }
          : null,
  };
}

function suspendDisplay(
  policy: DisplayPolicy,
  event: Extract<DisplayEvent, { type: "suspend" }>,
): DisplayPolicy {
  if (policy.suspended === event.value) {
    return policy;
  }
  const retryAutomatic =
    !event.value &&
    policy.execution.kind === "failed" &&
    policy.selection &&
    policy.mode !== "off" &&
    (policy.mode === "live" || !policy.selection.completed);
  const interruptedAutomatic =
    event.value &&
    policy.mode !== "off" &&
    activeDisplayIntent(policy)?.source === "automatic";
  const pending: Request | null =
    policy.pending ??
    (retryAutomatic || interruptedAutomatic ? { source: "automatic" } : null);
  return {
    ...policy,
    suspended: event.value,
    pending,
    execution:
      !event.value && policy.execution.kind === "failed" && pending
        ? { kind: "idle" }
        : policy.execution,
  };
}

function measureDisplay(
  policy: DisplayPolicy,
  event: Extract<DisplayEvent, { type: "measure" }>,
): DisplayPolicy {
  const size = event.size;
  const local =
    size && [size.width, size.height, size.dpr].every(positive)
      ? { width: size.width, height: size.height, dpr: size.dpr }
      : null;
  if (
    policy.local?.width === local?.width &&
    policy.local?.height === local?.height &&
    policy.local?.dpr === local?.dpr
  ) {
    return policy;
  }
  const automatic =
    policy.mode === "live" ||
    (policy.mode === "initial" &&
      (!policy.local || !policy.selection?.completed));
  return {
    ...policy,
    local,
    pending: policy.pending ?? (automatic ? { source: "automatic" } : null),
  };
}

function stageDisplay(
  policy: DisplayPolicy,
  event: Extract<DisplayEvent, { type: "stage" }>,
): DisplayPolicy {
  if (
    activeDisplayIntent(policy) !== event.intent ||
    policy.selection?.owner !== event.intent.owner
  ) {
    return policy;
  }
  const previous = policy.execution.kind;
  if (
    (event.stage === "writing" &&
      (policy.suspended ||
        previous !== "prepared" ||
        policy.selection?.owner !== event.intent.owner ||
        policy.revision !== event.intent.revision ||
        !policy.local)) ||
    (event.stage === "presenting" && previous !== "writing") ||
    (event.stage === "recovering" &&
      previous !== "writing" &&
      previous !== "presenting")
  ) {
    return policy;
  }
  return {
    ...policy,
    execution: { kind: event.stage, intent: event.intent },
    selection:
      event.stage === "recovering" &&
      policy.selection?.owner === event.intent.owner
        ? { ...policy.selection, completed: false }
        : policy.selection,
  };
}

function finishDisplay(
  policy: DisplayPolicy,
  event: Extract<DisplayEvent, { type: "finished" }>,
): DisplayPolicy {
  const { intent, outcome } = event;
  if (activeDisplayIntent(policy) !== intent) {
    return policy;
  }
  const current = policy.selection?.owner === intent.owner;
  if (
    outcome.kind === "deferred" &&
    policy.execution.kind !== "preparing" &&
    policy.execution.kind !== "prepared"
  ) {
    return policy;
  }
  if (outcome.kind === "completed") {
    return completeDisplay(policy, intent, outcome, current);
  }
  const retain =
    outcome.kind === "deferred" &&
    current &&
    (intent.source === "manual" || policy.revision === intent.revision);
  return {
    ...policy,
    pending:
      retain && intent.source === "manual"
        ? { source: "manual" }
        : (policy.pending ?? (retain ? { source: "automatic" } : null)),
    execution: {
      kind:
        outcome.kind === "failed" &&
        current &&
        policy.revision === intent.revision
          ? "failed"
          : "idle",
    },
  };
}

function completeDisplay(
  policy: DisplayPolicy,
  intent: DisplayIntent,
  outcome: Extract<DisplayOutcome, { kind: "completed" }>,
  current: boolean,
): DisplayPolicy {
  if (!current) {
    return { ...policy, execution: { kind: "idle" } };
  }
  if (
    outcome.proof === "reused"
      ? policy.execution.kind !== "prepared"
      : policy.execution.kind !== "presenting"
  ) {
    return policy;
  }
  const initial =
    (intent.mode === "initial" || policy.initial.has(outcome.windowId)) &&
    policy.initial.get(outcome.windowId) !== outcome.dpr
      ? new Map(policy.initial).set(outcome.windowId, outcome.dpr)
      : policy.initial;
  return {
    ...policy,
    initial,
    selection: {
      owner: intent.owner,
      completed: true,
    },
    execution: { kind: "idle" },
  };
}

function changeDisplayMode(
  policy: DisplayPolicy,
  event: Extract<DisplayEvent, { type: "mode" }>,
): DisplayPolicy {
  if (policy.mode === event.mode) {
    return policy;
  }
  return {
    ...policy,
    mode: event.mode,
    pending:
      policy.pending?.source === "manual"
        ? policy.pending
        : event.mode !== "off"
          ? { source: "automatic" }
          : null,
    execution:
      policy.execution.kind === "failed" ? { kind: "idle" } : policy.execution,
    revision: policy.revision + 1,
  };
}

function selectDisplay(
  policy: DisplayPolicy,
  event: Extract<DisplayEvent, { type: "select" }>,
): DisplayPolicy {
  return {
    ...policy,
    selection: event.owner ? { owner: event.owner, completed: false } : null,
    pending:
      event.owner && policy.mode !== "off" ? { source: "automatic" } : null,
    execution:
      policy.execution.kind === "failed" ? { kind: "idle" } : policy.execution,
    revision: policy.revision + 1,
  };
}
