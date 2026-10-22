export const internalRunCallbackKinds = [
  "agentphone:chat",
  "chat",
  "slack:chat",
  "wechat:chat",
  "feishu:chat",
  "teams:chat",
  "telegram:chat",
  "feishu:org",
  "workflow-automation:cron",
  "workflow-automation:loop",
] as const;

export type InternalRunCallbackKind = (typeof internalRunCallbackKinds)[number];

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

function isInternalRunCallbackKind(
  value: string | null,
): value is InternalRunCallbackKind {
  switch (value) {
    case "agentphone:chat":
    case "chat":
    case "wechat:chat":
    case "slack:chat":
    case "feishu:chat":
    case "teams:chat":
    case "telegram:chat":
    case "feishu:org":
    case "workflow-automation:cron":
    case "workflow-automation:loop": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function internalRunCallbackKindForRecord(
  callback: InternalRunCallbackRecord,
): InternalRunCallbackKind | null {
  return isInternalRunCallbackKind(callback.internalKind)
    ? callback.internalKind
    : null;
}
