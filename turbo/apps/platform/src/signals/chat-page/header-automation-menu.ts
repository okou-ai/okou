import { command, computed, state, type Command, type Computed } from "ccstate";

import {
  workflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { userPreferences$ } from "../okou-page/settings/user-preferences.ts";
import { listThreadWorkflowAutomations } from "../okou-page/workflow-automations-api.ts";
import { i18n } from "../../i18n/index.ts";
import { locale$ } from "../locale.ts";

/** A workflow automation bound to a chat thread, projected for the header automation sidebar. */
export interface HeaderWorkflowAutomationEntry {
  readonly id: string;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly workflowId: string;
  readonly workflowAgentId: string;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly summary: string;
  readonly timezone: string;
  readonly automation: ChatThreadWorkflowAutomation;
}

export interface HeaderAutomationSignals {
  readonly automations$: Computed<
    Promise<readonly HeaderWorkflowAutomationEntry[]>
  >;
  readonly reloadAutomations$: Command<void, []>;
  readonly updateSchedule$: Command<
    Promise<void>,
    [
      {
        readonly automationId: string;
        readonly schedule: WorkflowSchedule;
      },
      AbortSignal,
    ]
  >;
  readonly updateGmailNewMessage$: Command<
    Promise<void>,
    [
      {
        readonly automationId: string;
        readonly eventConfig: GmailNewMessageEventConfig;
      },
      AbortSignal,
    ]
  >;
  readonly updateGmailLabelApplied$: Command<
    Promise<void>,
    [
      {
        readonly automationId: string;
        readonly eventConfig: GmailLabelAppliedEventConfig;
      },
      AbortSignal,
    ]
  >;
  readonly runNow$: Command<Promise<void>, [string, AbortSignal]>;
}

function googleWorkflowAutomationSummary(
  automation: ChatThreadWorkflowAutomation,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  switch (automation.eventType) {
    case "google-calendar-event-created": {
      return i18n.t(($) => {
        return $.chat.automations.events.googleCalendarCreated;
      });
    }
    case "google-calendar-event-updated": {
      return i18n.t(($) => {
        return $.chat.automations.events.googleCalendarUpdated;
      });
    }
    case "google-calendar-event-cancelled": {
      return i18n.t(($) => {
        return $.chat.automations.events.googleCalendarCancelled;
      });
    }
    case "google-forms-response-submitted": {
      return i18n.t(($) => {
        return $.chat.automations.events.googleFormsResponseSubmitted;
      });
    }
    case "google-meet-transcript-generated": {
      return i18n.t(($) => {
        return $.chat.automations.events.googleMeetTranscript;
      });
    }
    default: {
      return null;
    }
  }
}

function workflowAutomationSummary(
  automation: ChatThreadWorkflowAutomation,
): string {
  if (automation.kind === "event") {
    if (automation.eventType === "chat-run-finished") {
      return i18n.t(($) => {
        return $.workflows.automations.chat.runFinishedTitle;
      });
    }
    if (automation.eventType === "gmail-new-message") {
      return i18n.t(($) => {
        return $.chat.automations.events.gmailNewMessage;
      });
    }
    if (automation.eventType === "gmail-label-applied") {
      return i18n.t(($) => {
        return $.chat.automations.events.gmailLabelApplied;
      });
    }
    if (automation.eventType === "github-pull-request") {
      return i18n.t(($) => {
        return $.chat.automations.events.githubPullRequest;
      });
    }
    if (automation.eventType === "github-workflow-job-completed") {
      return i18n.t(($) => {
        return $.chat.automations.events.githubWorkflowJobCompleted;
      });
    }
    if (automation.eventType === "github-pull-request-review-submitted") {
      return i18n.t(($) => {
        return $.chat.automations.events.githubReviewSubmitted;
      });
    }
    if (automation.eventType === "github-deployment-status-created") {
      return i18n.t(($) => {
        return $.chat.automations.events.githubDeploymentStatus;
      });
    }
    if (automation.eventType === "github-issue-comment-created") {
      return i18n.t(($) => {
        return $.chat.automations.events.githubIssueComment;
      });
    }
    if (automation.eventType === "github-workflow-run-completed") {
      return i18n.t(($) => {
        return $.chat.automations.events.githubWorkflowCompleted;
      });
    }
    const googleSummary = googleWorkflowAutomationSummary(automation);
    if (googleSummary !== null) {
      return googleSummary;
    }
    if (automation.eventType === "notion-child-page-created") {
      return i18n.t(($) => {
        return $.chat.automations.events.notionChildPage;
      });
    }
    if (automation.eventType === "notion-database-item-created") {
      return i18n.t(($) => {
        return $.chat.automations.events.notionDatabaseItem;
      });
    }
    if (automation.eventType === "notion-page-content-updated") {
      return i18n.t(($) => {
        return $.chat.automations.events.notionPageUpdated;
      });
    }
    if (automation.eventType === "webhook-received") {
      return i18n.t(($) => {
        return $.chat.automations.events.webhook;
      });
    }
    return i18n.t(($) => {
      return $.chat.automations.event;
    });
  }
  return (
    automation.scheduleSummary ??
    i18n.t(($) => {
      return $.chat.automations.schedule;
    })
  );
}

/**
 * Create the automation graph owned by one chat-thread signal instance.
 */
export function createHeaderAutomationSignals(
  threadId: string,
): HeaderAutomationSignals {
  const internalReloadAutomations$ = state(0);

  const reloadAutomations$ = command(({ set }) => {
    set(internalReloadAutomations$, (version) => {
      return version + 1;
    });
  });

  const automations$ = computed(
    async (get): Promise<readonly HeaderWorkflowAutomationEntry[]> => {
      get(internalReloadAutomations$);
      get(locale$);
      const automations = await listThreadWorkflowAutomations(get(apiClient$), {
        threadId,
      });
      const prefs = await get(userPreferences$);
      const displayTz =
        prefs?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
      return automations.map((automation) => {
        return {
          id: automation.id,
          chatThreadId: automation.chatThreadId,
          enabled: automation.enabled,
          workflowId: automation.workflow.id,
          workflowAgentId: automation.workflow.agentId,
          workflowName: automation.workflow.name,
          workflowDisplayName: automation.workflow.displayName,
          summary: workflowAutomationSummary(automation),
          timezone: displayTz,
          automation,
        };
      });
    },
  );

  const updateSchedule$ = command(
    async (
      { get, set },
      params: {
        readonly automationId: string;
        readonly schedule: WorkflowSchedule;
      },
      signal: AbortSignal,
    ) => {
      const client = get(apiClient$)(workflowAutomationsContract);
      await accept(
        client.update({
          params: { id: params.automationId },
          body: { schedule: params.schedule },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reloadAutomations$);
    },
  );

  const updateGmailNewMessage$ = command(
    async (
      { get, set },
      params: {
        readonly automationId: string;
        readonly eventConfig: GmailNewMessageEventConfig;
      },
      signal: AbortSignal,
    ) => {
      const client = get(apiClient$)(workflowAutomationsContract);
      await accept(
        client.update({
          params: { id: params.automationId },
          body: { eventConfig: params.eventConfig },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reloadAutomations$);
    },
  );

  const updateGmailLabelApplied$ = command(
    async (
      { get, set },
      params: {
        readonly automationId: string;
        readonly eventConfig: GmailLabelAppliedEventConfig;
      },
      signal: AbortSignal,
    ) => {
      const client = get(apiClient$)(workflowAutomationsContract);
      await accept(
        client.update({
          params: { id: params.automationId },
          body: { eventConfig: params.eventConfig },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reloadAutomations$);
    },
  );

  const runNow$ = command(
    async ({ get, set }, automationId: string, signal: AbortSignal) => {
      const client = get(apiClient$)(workflowAutomationsContract);
      await accept(
        client.run({
          params: { id: automationId },
          fetchOptions: { signal },
        }),
        [201],
      );
      signal.throwIfAborted();
      set(reloadAutomations$);
    },
  );

  return {
    automations$,
    reloadAutomations$,
    updateSchedule$,
    updateGmailNewMessage$,
    updateGmailLabelApplied$,
    runNow$,
  };
}
