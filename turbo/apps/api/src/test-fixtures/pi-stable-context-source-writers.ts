import { onTestFinished } from "vitest";

import {
  clearWorkflowCreationHooksForTest,
  setWorkflowCreationHooksForTest,
} from "../signals/routes/workflows";
import {
  clearAgentDeletionHooksForTest,
  setAgentDeletionHooksForTest,
} from "../signals/services/agent-deletion.service";
import {
  clearClerkAgentLifecycleHooksForTest,
  setClerkAgentLifecycleHooksForTest,
} from "../signals/services/agent-lifecycle.service";
import {
  clearChatThreadConnectorSelectionMutationHooksForTest,
  setChatThreadConnectorSelectionMutationHooksForTest,
} from "../signals/services/chat-thread-connector-selection.service";
import {
  clearOfficialWorkflowInstallationHooksForTest,
  setOfficialWorkflowInstallationHooksForTest,
} from "../signals/services/official-workflow-installation.service";
import {
  clearWorkflowDeleteHooksForTest,
  setWorkflowDeleteHooksForTest,
} from "../signals/services/workflow-delete.service";
import {
  clearWorkflowUpdateHooksForTest,
  setWorkflowUpdateHooksForTest,
} from "../signals/services/workflow-update.service";

export function holdWorkflowCreationBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setWorkflowCreationHooksForTest({ beforeAdmission: hold });
  onTestFinished(() => {
    clearWorkflowCreationHooksForTest();
  });
}

export function holdWorkflowCopyBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setWorkflowCreationHooksForTest({ beforeCopyAdmission: hold });
  onTestFinished(() => {
    clearWorkflowCreationHooksForTest();
  });
}

export function holdWorkflowUpdateBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setWorkflowUpdateHooksForTest({ beforeAdmission: hold });
  onTestFinished(() => {
    clearWorkflowUpdateHooksForTest();
  });
}

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

export function holdWorkflowDeleteBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setWorkflowDeleteHooksForTest({ beforeAdmission: hold });
  onTestFinished(() => {
    clearWorkflowDeleteHooksForTest();
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

export function observeClerkAgentLifecycleBeforeAgentLockFixture(
  observe: NonNullable<
    Parameters<typeof setClerkAgentLifecycleHooksForTest>[0]["beforeAgentLock"]
  >,
): void {
  setClerkAgentLifecycleHooksForTest({ beforeAgentLock: observe });
  onTestFinished(() => {
    clearClerkAgentLifecycleHooksForTest();
  });
}

export function holdClerkAgentLifecycleAfterInstructionsStorageLocksFixture(
  hold: NonNullable<
    Parameters<
      typeof setClerkAgentLifecycleHooksForTest
    >[0]["afterInstructionsStorageLocks"]
  >,
): void {
  setClerkAgentLifecycleHooksForTest({
    afterInstructionsStorageLocks: hold,
  });
  onTestFinished(() => {
    clearClerkAgentLifecycleHooksForTest();
  });
}

export function holdChatThreadConnectorSelectionBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setChatThreadConnectorSelectionMutationHooksForTest({
    beforeAdmission: hold,
  });
  onTestFinished(() => {
    clearChatThreadConnectorSelectionMutationHooksForTest();
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

export function holdOfficialWorkflowInstallationBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setOfficialWorkflowInstallationHooksForTest({ beforeInsertAdmission: hold });
  onTestFinished(() => {
    clearOfficialWorkflowInstallationHooksForTest();
  });
}

export function holdOfficialWorkflowActivationBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setOfficialWorkflowInstallationHooksForTest({
    beforeActivationAdmission: hold,
  });
  onTestFinished(() => {
    clearOfficialWorkflowInstallationHooksForTest();
  });
}
