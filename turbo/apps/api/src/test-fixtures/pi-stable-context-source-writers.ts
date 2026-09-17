import { randomUUID } from "node:crypto";

import { chatThreads } from "@okouai/db/schema/chat-thread";
import { createStore } from "ccstate";
import { onTestFinished } from "vitest";

import { writeDb$ } from "../signals/external/db";
import {
  clearWorkflowCreationHooksForTest,
  setWorkflowCreationHooksForTest,
} from "../signals/routes/workflows";
import {
  clearChatThreadConnectorSelectionMutationHooksForTest,
  setChatThreadConnectorSelectionMutationHooksForTest,
} from "../signals/services/chat-thread-connector-selection.service";

const store = createStore();

export async function seedChatThreadForStableContextWriterFixture(args: {
  readonly userId: string;
  readonly agentId: string;
}): Promise<string> {
  const id = randomUUID();
  await store.set(writeDb$).insert(chatThreads).values({
    id,
    userId: args.userId,
    agentId: args.agentId,
    title: "Stable-context source writer fixture",
  });
  return id;
}

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
