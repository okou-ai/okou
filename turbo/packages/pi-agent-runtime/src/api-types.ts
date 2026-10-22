import type { PiResourceSnapshot } from "@okouai/api-contracts/contracts/runners";
export type PiPreheatedAgentsFile = PiResourceSnapshot["agentsFiles"][number];
export type PiPreheatedSkill = PiResourceSnapshot["skills"][number];
export type PiPreheatedResourceSnapshot = PiResourceSnapshot;

export interface PiSessionInspection {
  readonly sessionId: string;
  readonly messageCount: number;
  readonly hasPendingToolCalls: boolean;
  readonly pendingToolIds: readonly string[];
  readonly isSettledHistory: boolean;
}
