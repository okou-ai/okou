import { onTestFinished } from "vitest";

import {
  clearRunConnectorAccountsReadHookForTest,
  setRunConnectorAccountsReadHookForTest,
} from "../signals/services/agent-run-preparation-hooks";

/** Pause the real account SELECT without replacing its rows or catalog. */
export function onRunConnectorAccountsReadFixture(
  hook: () => Promise<void>,
): () => void {
  setRunConnectorAccountsReadHookForTest(hook);
  onTestFinished(clearRunConnectorAccountsReadHookForTest);
  return clearRunConnectorAccountsReadHookForTest;
}
