import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";

export const INTEGRATION_DM_SESSION_PREFIX = "direct-message:";

export function integrationDmSessionKey(args: {
  readonly agentId: string;
  readonly selectedModel?: string | null;
  readonly serviceTier?: ChatThreadServiceTier | null;
}): string {
  const session = `${INTEGRATION_DM_SESSION_PREFIX}${args.agentId}:${args.selectedModel ?? "default"}`;
  return args.serviceTier === "priority" ? `${session}:priority` : session;
}

export function isIntegrationDmSessionKey(key: string): boolean {
  return key.startsWith(INTEGRATION_DM_SESSION_PREFIX);
}
