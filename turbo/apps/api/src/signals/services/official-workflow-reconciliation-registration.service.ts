import { command } from "ccstate";

import { configureOfficialWorkflowReconciliationCommand$ } from "./official-workflow-reconciliation-dispatch.service";
import { reconcileOfficialWorkflowInstallation$ } from "./official-workflow-reconciliation.service";

/** Wire Official Workflow reconciliation into the request's command graph. */
export const configureOfficialWorkflowReconciliationDispatcher$ = command(
  ({ set }): void => {
    set(
      configureOfficialWorkflowReconciliationCommand$,
      reconcileOfficialWorkflowInstallation$,
    );
  },
);
