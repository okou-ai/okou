import { onTestFinished } from "vitest";

import {
  clearWorkflowCreationHooksForTest,
  setWorkflowCreationHooksForTest,
} from "../signals/routes/workflows";
import {
  clearChatThreadConnectorSelectionMutationHooksForTest,
  setChatThreadConnectorSelectionMutationHooksForTest,
} from "../signals/services/chat-thread-connector-selection.service";
import {
  clearOfficialWorkflowInstallationHooksForTest,
  setOfficialWorkflowInstallationHooksForTest,
} from "../signals/services/official-workflow-installation.service";

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
