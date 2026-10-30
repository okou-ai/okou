import { command } from "ccstate";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { reloadWorkflowData$ } from "./workflow-reload.ts";
import { createElement } from "react";
import {
  isMorningBriefDefinitionName,
  MORNING_BRIEF_PREFERENCES_FOCUS,
  MORNING_BRIEF_PREFERENCES_ROUTE,
  MORNING_BRIEF_PREFERENCES_SECTION,
} from "@okouai/api-contracts/validators/morning-brief-preference";

import { i18n } from "../../i18n/index.ts";
import { WorkflowDetailPage } from "../../views/workflows-page/workflow-detail-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  currentWorkflowDetail$,
  resetWorkflowDetailUiState$,
} from "./workflows-signals.ts";
import { ROUTES } from "../route-paths.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { resetConnectorAccountDialogs$ } from "../okou-page/settings/connector-account-dialogs.ts";
import { cancelGoogleCalendarRecovery$ } from "./google-calendar-recovery.ts";

export const setupWorkflowDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(cancelGoogleCalendarRecovery$);
    signal.addEventListener(
      "abort",
      () => {
        set(cancelGoogleCalendarRecovery$);
      },
      { once: true },
    );
    set(resetConnectorAccountDialogs$);
    set(resetWorkflowDetailUiState$);
    set(
      setAblyInvalidationLoop$,
      {
        topic: "connector:changed",
        invalidations: [reloadWorkflowData$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
    const detail = await get(currentWorkflowDetail$);
    signal.throwIfAborted();
    // Official Workflows are system-managed: Morning Brief is configured in
    // Settings, and no other Official Workflow has a user-facing page.
    if (detail?.official) {
      if (isMorningBriefDefinitionName(detail.official.definitionName)) {
        const searchParams = new URLSearchParams({
          settings: MORNING_BRIEF_PREFERENCES_SECTION,
          focus: MORNING_BRIEF_PREFERENCES_FOCUS,
        });
        set(detachedNavigateTo$, MORNING_BRIEF_PREFERENCES_ROUTE, {
          searchParams,
          replace: true,
        });
      } else {
        set(detachedNavigateTo$, ROUTES.workflows, { replace: true });
      }
      return;
    }
    set(updatePage$, createElement(WorkflowDetailPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.workflows.common.workflow;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
