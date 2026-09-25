import { onTestFinished } from "vitest";

import {
  clearAgentDeletionHooksForTest,
  setAgentDeletionHooksForTest,
} from "../signals/services/agent-deletion.service";

export function holdAgentDeletionAfterStableContextCleanupFixture(
  agentId: string,
  hold: () => Promise<void>,
): void {
  setAgentDeletionHooksForTest({
    async afterInitialStableContextCleanup(_tx, args) {
      if (args.agentId === agentId) {
        await hold();
      }
    },
  });
  onTestFinished(() => {
    clearAgentDeletionHooksForTest();
  });
}
