export const workflowAutomationRunCallbackKinds = [
  "workflow-automation:cron",
  "workflow-automation:loop",
] as const;

export const terminalRunCallbackKinds = [
  "chat",
  ...workflowAutomationRunCallbackKinds,
] as const;

export const inlineChatDeliveryCallbackKinds = [
  "email:chat",
  "agentphone:chat",
  "slack:chat",
  "wechat:chat",
  "feishu:chat",
  "teams:chat",
  "telegram:chat",
] as const;

const internalRunCallbackKinds = [
  ...terminalRunCallbackKinds,
  ...inlineChatDeliveryCallbackKinds,
] as const;

export type TerminalRunCallbackKind = (typeof terminalRunCallbackKinds)[number];

export type InternalRunCallbackKind = (typeof internalRunCallbackKinds)[number];

export type InternalRunCallbackDispatchResult =
  | { readonly success: true; readonly skipped?: true }
  | { readonly success: false; readonly error: string };

export interface InternalRunCallbackEnvelope {
  readonly callbackId: string;
  readonly runId: string;
  readonly status: "completed" | "failed" | "progress";
  readonly payload: unknown;
}

export function internalRunCallbackKindForRecord(callback: {
  readonly internalKind: string | null;
}): InternalRunCallbackKind | null {
  return (
    internalRunCallbackKinds.find((kind) => {
      return kind === callback.internalKind;
    }) ?? null
  );
}
