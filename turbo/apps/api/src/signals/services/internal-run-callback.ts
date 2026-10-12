export const internalRunCallbackKinds = [
  "agentphone:chat",
  "chat",
  "slack:chat",
  "feishu:chat",
  "teams:chat",
  "telegram:chat",
  "feishu:org",
  "workflow-automation:cron",
  "workflow-automation:loop",
  "pi-memory:phase2",
] as const;

export type InternalRunCallbackKind = (typeof internalRunCallbackKinds)[number];

// Registered at Run claim only by release-1 APIs (1.729.0 and earlier) for
// Official Automations with platform completion email. No current producer may
// register it, so it is absent from `InternalRunCallbackKind`; it is recognized
// only to dispatch those captured callbacks to the bounded legacy consumer
// (#39524) instead of failing them as URL-less HTTP callbacks. Release 3 of
// #39378 removes it with that consumer.
const LEGACY_OFFICIAL_RESULT_EMAIL_CALLBACK_KIND =
  "workflow-automation:result-email";

/** Kinds a persisted callback record can carry, including drain-only kinds. */
export type DispatchedInternalRunCallbackKind =
  InternalRunCallbackKind | typeof LEGACY_OFFICIAL_RESULT_EMAIL_CALLBACK_KIND;

export type InternalRunCallbackStatus = "completed" | "failed" | "progress";

export type InternalRunCallbackDispatchResult =
  | { readonly success: true; readonly skipped?: true }
  | { readonly success: false; readonly error: string };

interface InternalRunCallbackEnvelopeBase {
  readonly callbackId?: string;
  readonly runId: string;
  readonly result?: Record<string, unknown>;
  readonly payload: unknown;
}

export type InternalRunCallbackEnvelope = InternalRunCallbackEnvelopeBase &
  (
    | {
        readonly status: "failed";
        readonly error: string;
      }
    | {
        readonly status: Exclude<InternalRunCallbackStatus, "failed">;
        readonly error?: string;
      }
  );

interface InternalRunCallbackRecord {
  readonly internalKind: string | null;
}

function isDispatchedInternalRunCallbackKind(
  value: string | null,
): value is DispatchedInternalRunCallbackKind {
  switch (value) {
    case "agentphone:chat":
    case "chat":
    case "slack:chat":
    case "feishu:chat":
    case "teams:chat":
    case "telegram:chat":
    case "feishu:org":
    case "workflow-automation:cron":
    case "workflow-automation:loop":
    case LEGACY_OFFICIAL_RESULT_EMAIL_CALLBACK_KIND:
    case "pi-memory:phase2": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function internalRunCallbackKindForRecord(
  callback: InternalRunCallbackRecord,
): DispatchedInternalRunCallbackKind | null {
  return isDispatchedInternalRunCallbackKind(callback.internalKind)
    ? callback.internalKind
    : null;
}
