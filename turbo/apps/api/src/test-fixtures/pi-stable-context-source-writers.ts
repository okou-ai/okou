import { onTestFinished } from "vitest";

import {
  clearAgentDeletionHooksForTest,
  setAgentDeletionHooksForTest,
} from "../signals/services/agent-deletion.service";
import {
  clearChatThreadConnectorSelectionMutationHooksForTest,
  setChatThreadConnectorSelectionMutationHooksForTest,
} from "../signals/services/chat-thread-connector-selection.service";
import {
  clearWorkflowUpdateHooksForTest,
  setWorkflowUpdateHooksForTest,
} from "../signals/services/workflow-update.service";

export function holdWorkflowUpdateAfterMetadataMutationFixture(
  hold: NonNullable<
    Parameters<typeof setWorkflowUpdateHooksForTest>[0]["afterMetadataMutation"]
  >,
): void {
  setWorkflowUpdateHooksForTest({ afterMetadataMutation: hold });
  onTestFinished(() => {
    clearWorkflowUpdateHooksForTest();
  });
}

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

export function holdChatThreadConnectorSelectionBeforeAgentLockFixture(
  hold: () => Promise<void>,
): void {
  setChatThreadConnectorSelectionMutationHooksForTest({
    afterThreadReadBeforeAgentLock: hold,
  });
  onTestFinished(() => {
    clearChatThreadConnectorSelectionMutationHooksForTest();
  });
}
